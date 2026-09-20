/* Statistical signal functions shared by the isolated content script and tests. */
(() => {
  'use strict';

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  /**
   * Compute the arithmetic mean of an array of numbers.
   * @param {number[]} values
   * @returns {number}
   */
  function mean(values) {
    if (!Array.isArray(values)) return 0;
    let total = 0;
    let count = 0;
    for (const value of values) {
      if (!finite(value)) continue;
      total += value;
      count += 1;
    }
    return count === 0 ? 0 : total / count;
  }

  /**
   * Compute the sample standard deviation of an array of numbers.
   * @param {number[]} values
   * @param {number} average - pre-computed mean
   * @returns {number}
   */
  function sampleDeviation(values, average) {
    if (!Array.isArray(values)) return 0;
    let squaredError = 0;
    let count = 0;
    for (const value of values) {
      if (!finite(value)) continue;
      squaredError += (value - average) ** 2;
      count += 1;
    }
    return count < 2 ? 0 : Math.sqrt(squaredError / (count - 1));
  }

  /**
   * Strategy dispatcher. config.STRATEGY picks the signal model:
   *   'zscore' (default) — studentized drift with efficiency/volatility gates
   *   'momentum'         — EMA crossover with a momentum confirmation
   *   'trend'            — the EMA STATE (fast above/below slow) — a signal on
   *                        every sample, so trades happen at every cooldown
   * All return the same shape, and all are filters — not a prediction or
   * claim of trading profitability.
   * @param {Array<{t: number, price: number}>} history
   * @param {Object} config
   * @returns {{signal: string|null, pct: number|null, zScore: number|null, reason: string}}
   */
  function decide(history, config) {
    if (!Array.isArray(history) || !config || typeof config !== 'object') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid input' };
    }
    const strategy = config.STRATEGY === undefined ? 'zscore' : config.STRATEGY;
    if (strategy === 'momentum') return decideMomentum(history, config);
    if (strategy === 'trend') return decideTrendState(history, config);
    if (strategy !== 'zscore') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid config' };
    }
    return decideZScore(history, config);
  }

  /** Bias-corrected ("adjust=True") EMA of a price array; null if empty. */
  function ema(prices, period) {
    if (!Array.isArray(prices) || prices.length === 0) return null;
    const k = 2 / (period + 1);
    let num = prices[0];
    let den = 1;
    for (let index = 1; index < prices.length; index += 1) {
      num = prices[index] + (1 - k) * num;
      den = 1 + (1 - k) * den;
    }
    return num / den;
  }

  // The trend state needs only a handful of samples to say which side the
  // fast EMA is on — bias correction means a short series is not seed-biased,
  // just less certain. It exists for the instant first trade after Start,
  // where waiting EMA_SLOW+2 samples would defeat the point.
  const MIN_TREND_SAMPLES = 5;

  /**
   * Which side of the slow EMA the fast EMA is on RIGHT NOW, with a drift
   * over MOMENTUM_TICKS for the pct readout and the edge-vs-cost gate.
   * Unlike the crossover this is a state, not an event: it is a signal on
   * every sample, so a bot running it trades at every cooldown. Used by the
   * 'trend' strategy and by content.js's instant entry after Start. It says
   * nothing about the future beyond "the recent average is above/below the
   * older one".
   */
  function decideTrendState(history, config) {
    if (!Array.isArray(history) || !config || typeof config !== 'object') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid input' };
    }
    const { EMA_FAST, EMA_SLOW, MOMENTUM_TICKS, MAX_REALIZED_VOLATILITY } = config;
    if (!Number.isInteger(EMA_FAST) || !Number.isInteger(EMA_SLOW) ||
        EMA_FAST < 2 || EMA_SLOW <= EMA_FAST ||
        !Number.isInteger(MOMENTUM_TICKS) || MOMENTUM_TICKS < 1 ||
        !finite(MAX_REALIZED_VOLATILITY)) {
      return { signal: null, pct: null, zScore: null, reason: 'invalid config' };
    }
    if (history.length < MIN_TREND_SAMPLES) {
      return { signal: null, pct: null, zScore: null, reason: 'warming up' };
    }
    const prices = [];
    for (const sample of history) {
      const price = sample && typeof sample === 'object' ? sample.price : NaN;
      if (!finite(price) || price <= 0) {
        return { signal: null, pct: null, zScore: null, reason: 'invalid price' };
      }
      prices.push(price);
    }
    const last = prices.length - 1;
    const back = Math.max(0, last - MOMENTUM_TICKS);
    const drift = Math.log(prices[last] / prices[back]);
    const pct = (Math.exp(drift) - 1) * 100;

    const returns = [];
    for (let index = Math.max(1, prices.length - EMA_SLOW); index < prices.length; index += 1) {
      returns.push(Math.log(prices[index] / prices[index - 1]));
    }
    const realizedVolatility =
      sampleDeviation(returns, mean(returns)) * Math.sqrt(returns.length);
    if (!finite(realizedVolatility) || realizedVolatility > MAX_REALIZED_VOLATILITY) {
      return { signal: null, pct, zScore: null, reason: 'volatility limit' };
    }

    // Two EMAs of a flat series differ by float rounding (~1e-14), which
    // would turn "no trend" into a random direction; anything under a
    // billionth of the price is flat.
    const diff = ema(prices, EMA_FAST) - ema(prices, EMA_SLOW);
    if (Math.abs(diff) <= prices[last] * 1e-9) {
      return { signal: null, pct, zScore: null, reason: 'flat trend' };
    }
    return { signal: diff > 0 ? 'UP' : 'DOWN', pct, zScore: null, reason: 'trend state' };
  }

  /**
   * Test a short log-return drift against the recent return distribution.
   */
  function decideZScore(history, config) {
    if (!Array.isArray(history) || !config || typeof config !== 'object') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid input' };
    }

    const { FAST_WINDOW, SLOW_WINDOW, Z_SCORE_THRESHOLD, MIN_EFFICIENCY_RATIO,
      MAX_REALIZED_VOLATILITY } = config;
    // Every threshold must be validated: the gates below are written as
    // reject-if-true comparisons, so a missing/NaN threshold would make each
    // comparison false and silently PASS its gate (fail open).
    if (!Number.isInteger(FAST_WINDOW) || !Number.isInteger(SLOW_WINDOW) ||
        FAST_WINDOW < 2 || SLOW_WINDOW <= FAST_WINDOW ||
        !finite(Z_SCORE_THRESHOLD) || !finite(MIN_EFFICIENCY_RATIO) ||
        !finite(MAX_REALIZED_VOLATILITY)) {
      return { signal: null, pct: null, zScore: null, reason: 'invalid config' };
    }
    if (history.length < SLOW_WINDOW + 1) {
      return { signal: null, pct: null, zScore: null, reason: 'warming up' };
    }

    const prices = history.slice(-(SLOW_WINDOW + 1)).map((sample) => {
      if (!sample || typeof sample !== 'object') return NaN;
      return sample.price;
    });
    if (!prices.every((price) => finite(price) && price > 0)) {
      return { signal: null, pct: null, zScore: null, reason: 'invalid price' };
    }

    const returns = [];
    for (let index = 1; index < prices.length; index += 1) {
      const logReturn = Math.log(prices[index] / prices[index - 1]);
      if (Number.isFinite(logReturn)) {
        returns.push(logReturn);
      }
    }

    if (returns.length < FAST_WINDOW) {
      return { signal: null, pct: null, zScore: null, reason: 'insufficient returns' };
    }

    const slowMean = mean(returns);
    const deviation = sampleDeviation(returns, slowMean);
    const fastReturns = returns.slice(-FAST_WINDOW);
    const fastMean = mean(fastReturns);
    const fastDrift = fastMean * FAST_WINDOW;
    const pct = (Math.exp(fastDrift) - 1) * 100;
    const realizedVolatility = deviation * Math.sqrt(returns.length);
    const pathLength = returns.reduce((total, value) => total + Math.abs(value), 0);
    const efficiency = pathLength === 0 ? 0 :
      Math.abs(returns.reduce((total, value) => total + value, 0)) / pathLength;

    // Exact zero only catches perfectly flat prices. A constant nonzero drift
    // leaves ~1e-17 of float rounding noise in the deviation, which would
    // inflate the z-score astronomically; treat both as zero variance.
    if (!finite(deviation) || deviation < 1e-12) {
      return { signal: null, pct, zScore: 0, reason: 'zero variance' };
    }

    // Studentized mean: drift relative to its standard error.
    const zScore = fastMean / (deviation / Math.sqrt(FAST_WINDOW));
    const sameDirection = Math.sign(fastMean) === Math.sign(slowMean) && slowMean !== 0;

    if (!finite(realizedVolatility) || realizedVolatility > MAX_REALIZED_VOLATILITY) {
      return { signal: null, pct, zScore, reason: 'volatility limit' };
    }
    if (efficiency < MIN_EFFICIENCY_RATIO) {
      return { signal: null, pct, zScore, reason: 'noisy path' };
    }
    if (!sameDirection || Math.abs(zScore) < Z_SCORE_THRESHOLD) {
      return { signal: null, pct, zScore, reason: 'insufficient trend evidence' };
    }

    // Not "statistically significant": |z| of 1.2–1.6 on autocorrelated tick
    // returns is a one-sided p of roughly 0.1–0.2. It is a drift that cleared
    // the configured z threshold in the direction of the slow window — the
    // scoreboard decides whether that ever meant anything.
    return {
      signal: zScore > 0 ? 'UP' : 'DOWN',
      pct,
      zScore,
      reason: 'aligned drift above z threshold',
    };
  }

  /**
   * EMA crossover with a momentum confirmation — fires only on the tick where
   * the fast EMA crosses the slow one, so entries land at trend inception
   * instead of requiring the sustained statistical evidence the z-score model
   * demands. Suits the choppy 1s OTC feeds where |z| rarely exceeds ~2.
   */
  function decideMomentum(history, config) {
    if (!Array.isArray(history) || !config || typeof config !== 'object') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid input' };
    }
    const { EMA_FAST, EMA_SLOW, MOMENTUM_TICKS, MIN_MOMENTUM,
      MAX_REALIZED_VOLATILITY } = config;
    if (!Number.isInteger(EMA_FAST) || !Number.isInteger(EMA_SLOW) ||
        EMA_FAST < 2 || EMA_SLOW <= EMA_FAST ||
        !Number.isInteger(MOMENTUM_TICKS) || MOMENTUM_TICKS < 1 ||
        MOMENTUM_TICKS > EMA_SLOW ||
        !finite(MIN_MOMENTUM) || MIN_MOMENTUM < 0 ||
        !finite(MAX_REALIZED_VOLATILITY)) {
      return { signal: null, pct: null, zScore: null, reason: 'invalid config' };
    }
    if (history.length < EMA_SLOW + 2) {
      return { signal: null, pct: null, zScore: null, reason: 'warming up' };
    }

    const prices = [];
    for (const sample of history) {
      const price = sample && typeof sample === 'object' ? sample.price : NaN;
      if (!finite(price) || price <= 0) {
        return { signal: null, pct: null, zScore: null, reason: 'invalid price' };
      }
      prices.push(price);
    }

    // Bias-corrected EMAs (the "adjust=True" form): each value is the
    // exponentially weighted mean of every price seen so far, divided by the
    // sum of the weights actually applied. A plain seeded EMA still carries
    // ~12% of prices[0] when the history is only EMA_SLOW + 2 long — for any
    // window — which manufactured a crossover right after every history
    // reset (gap, chart switch) and fed the shadow scoreboard biased entries.
    // Once the history is long the two forms agree to floating-point noise.
    const kFast = 2 / (EMA_FAST + 1);
    const kSlow = 2 / (EMA_SLOW + 1);
    let fastNum = prices[0], fastDen = 1;
    let slowNum = prices[0], slowDen = 1;
    let prevDiff = 0;
    for (let index = 1; index < prices.length; index += 1) {
      prevDiff = fastNum / fastDen - slowNum / slowDen;
      fastNum = prices[index] + (1 - kFast) * fastNum;
      fastDen = 1 + (1 - kFast) * fastDen;
      slowNum = prices[index] + (1 - kSlow) * slowNum;
      slowDen = 1 + (1 - kSlow) * slowDen;
    }
    const diff = fastNum / fastDen - slowNum / slowDen;

    const last = prices.length - 1;
    const momentum = Math.log(prices[last] / prices[last - MOMENTUM_TICKS]);
    const pct = (Math.exp(momentum) - 1) * 100;

    const returns = [];
    for (let index = Math.max(1, prices.length - EMA_SLOW); index < prices.length; index += 1) {
      returns.push(Math.log(prices[index] / prices[index - 1]));
    }
    const realizedVolatility =
      sampleDeviation(returns, mean(returns)) * Math.sqrt(returns.length);
    if (!finite(realizedVolatility) || realizedVolatility > MAX_REALIZED_VOLATILITY) {
      return { signal: null, pct, zScore: null, reason: 'volatility limit' };
    }

    if (diff === 0 || Math.sign(diff) === Math.sign(prevDiff)) {
      return { signal: null, pct, zScore: null, reason: 'no crossover' };
    }
    const direction = diff > 0 ? 'UP' : 'DOWN';
    if (Math.sign(momentum) !== Math.sign(diff) || Math.abs(momentum) < MIN_MOMENTUM) {
      return { signal: null, pct, zScore: null, reason: 'weak momentum' };
    }
    return { signal: direction, pct, zScore: null, reason: 'momentum crossover' };
  }

  const api = Object.freeze({
    decide, decideZScore, decideMomentum, decideTrendState, ema, mean, sampleDeviation,
  });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && !('NexaStrategy' in globalThis)) {
    // Guarded: redefining a non-configurable property on a second injection
    // into the same context would throw and kill the whole script.
    Object.defineProperty(globalThis, 'NexaStrategy', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
