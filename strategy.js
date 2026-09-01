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
    if (!Array.isArray(values) || values.length === 0) {
      return 0;
    }
    return values.reduce((total, value) => total + (finite(value) ? value : 0), 0) / values.length;
  }

  /**
   * Compute the sample standard deviation of an array of numbers.
   * @param {number[]} values
   * @param {number} average - pre-computed mean
   * @returns {number}
   */
  function sampleDeviation(values, average) {
    if (!Array.isArray(values) || values.length < 2) {
      return 0;
    }
    const squaredError = values.reduce((total, value) => {
      if (!finite(value)) return total;
      return total + (value - average) ** 2;
    }, 0);
    return Math.sqrt(squaredError / (values.length - 1));
  }

  /**
   * Test a short log-return drift against the recent return distribution.
   * The result is a filter, not a prediction or claim of trading profitability.
   * @param {Array<{t: number, price: number}>} history
   * @param {Object} config - configuration object
   * @returns {{signal: string|null, pct: number|null, zScore: number|null, reason: string}}
   */
  function decide(history, config) {
    if (!Array.isArray(history) || !config || typeof config !== 'object') {
      return { signal: null, pct: null, zScore: null, reason: 'invalid input' };
    }

    const { FAST_WINDOW, SLOW_WINDOW, Z_SCORE_THRESHOLD, MIN_EFFICIENCY_RATIO,
      MAX_REALIZED_VOLATILITY } = config;
    if (!Number.isInteger(FAST_WINDOW) || !Number.isInteger(SLOW_WINDOW) ||
        FAST_WINDOW < 2 || SLOW_WINDOW <= FAST_WINDOW || history.length < SLOW_WINDOW + 1) {
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
    const realizedVolatility = deviation * Math.sqrt(SLOW_WINDOW);
    const pathLength = returns.reduce((total, value) => total + Math.abs(value), 0);
    const efficiency = pathLength === 0 ? 0 :
      Math.abs(returns.reduce((total, value) => total + value, 0)) / pathLength;

    if (deviation === 0 || !finite(deviation)) {
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

    return {
      signal: zScore > 0 ? 'UP' : 'DOWN',
      pct,
      zScore,
      reason: 'aligned statistically significant drift',
    };
  }

  const api = Object.freeze({ decide, mean, sampleDeviation });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    Object.defineProperty(globalThis, 'NexaStrategy', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
