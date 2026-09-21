/* Candles built from the tick feed, and the higher-timeframe context read
   off them. Shared by the isolated content script (section 2c keeps one
   series per streaming symbol) and tools/backtest.js (which replays the
   same filter over a recording). Pure data and pure functions — no DOM, no
   storage, no timers.

   Why candles at all: every signal model in strategy.js looks at the last
   ~300 ticks (about 2.5 minutes). A 60-second contract entered against a
   trend that has been running for half an hour is fighting the only
   structure that outlives the noise. Quotex draws its chart to a canvas, so
   the candles are rebuilt here from the same quotes the models see. */
(() => {
  'use strict';

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  /**
   * An empty candle series.
   * @param {number} periodMs candle length (60_000 = 1m)
   * @param {number} keep closed candles retained (240 x 1m = 4 hours)
   */
  function createSeries(periodMs, keep) {
    if (!finite(periodMs) || periodMs <= 0 || !Number.isInteger(keep) || keep < 1) {
      return null;
    }
    return { periodMs, keep, candles: [], open: null };
  }

  /**
   * Feed one tick. Candles are aligned to wall-clock multiples of the
   * period (a 1m candle covers hh:mm:00–hh:mm:59), the way every charting
   * package draws them. Returns the candle this tick closed, or null.
   * A tick older than the forming candle (out-of-order delivery) is ignored
   * rather than allowed to rewrite a closed bar.
   */
  function push(series, t, price) {
    if (!series || !finite(t) || !finite(price) || price <= 0) return null;
    const bucket = Math.floor(t / series.periodMs) * series.periodMs;
    const open = series.open;
    if (open === null) {
      series.open = { t: bucket, o: price, h: price, l: price, c: price, n: 1 };
      return null;
    }
    if (bucket === open.t) {
      if (price > open.h) open.h = price;
      if (price < open.l) open.l = price;
      open.c = price;
      open.n += 1;
      return null;
    }
    if (bucket < open.t) return null;
    const closed = open;
    series.candles.push(closed);
    if (series.candles.length > series.keep) {
      series.candles.splice(0, series.candles.length - series.keep);
    }
    series.open = { t: bucket, o: price, h: price, l: price, c: price, n: 1 };
    return closed;
  }

  /** Closing prices of the closed candles, oldest first. */
  function closes(series) {
    return series ? series.candles.map((candle) => candle.c) : [];
  }

  /** Bias-corrected EMA (the "adjust=True" form strategy.js uses), so a
      short series is less certain rather than seed-biased. Null if empty. */
  function ema(values, period) {
    if (!Array.isArray(values) || values.length === 0 || !finite(period) || period < 1) return null;
    const k = 2 / (period + 1);
    let num = values[0];
    let den = 1;
    for (let index = 1; index < values.length; index += 1) {
      num = values[index] + (1 - k) * num;
      den = 1 + (1 - k) * den;
    }
    return num / den;
  }

  /**
   * Wilder's RSI over the closes: 100 - 100 / (1 + avgGain / avgLoss), the
   * averages seeded by a simple mean over the first `period` changes and
   * smoothed by (period - 1)/period from then on. Null until there are
   * period + 1 closes. 100 when there were no losses at all, 0 when no gains.
   */
  function rsi(values, period) {
    if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 ||
        values.length < period + 1) {
      return null;
    }
    let gain = 0;
    let loss = 0;
    for (let index = 1; index <= period; index += 1) {
      const change = values[index] - values[index - 1];
      if (change > 0) gain += change;
      else loss -= change;
    }
    gain /= period;
    loss /= period;
    for (let index = period + 1; index < values.length; index += 1) {
      const change = values[index] - values[index - 1];
      gain = (gain * (period - 1) + (change > 0 ? change : 0)) / period;
      loss = (loss * (period - 1) + (change < 0 ? -change : 0)) / period;
    }
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  }

  /**
   * The higher-timeframe read: which way the candle trend points (fast EMA
   * of closes above/below the slow one), and whether the RSI is stretched.
   *
   * `warm` is false until the slow EMA has a full window of closed candles;
   * before that `dir` is null and the caller should stand aside rather than
   * act on a half-formed average. `blockUp` / `blockDown` say the RSI is at
   * or beyond rsiBlock (and its mirror, 100 - rsiBlock): a buy into an
   * overbought bar, or a sell into an oversold one, is the classic way to
   * catch the top of a move that is about to mean-revert.
   *
   * @param {Object} series
   * @param {{fast: number, slow: number, rsiPeriod: number, rsiBlock: number}} opts
   *   rsiBlock 0 disables the RSI gate
   */
  function bias(series, opts) {
    const out = { dir: null, rsi: null, candles: 0, needed: 0, warm: false,
      blockUp: false, blockDown: false };
    if (!series || !opts || typeof opts !== 'object') return out;
    const { fast, slow, rsiPeriod, rsiBlock } = opts;
    if (!Number.isInteger(fast) || !Number.isInteger(slow) || fast < 2 || slow <= fast) return out;
    const values = closes(series);
    out.candles = values.length;
    out.needed = slow + 1;
    if (Number.isInteger(rsiPeriod) && rsiPeriod >= 2 && finite(rsiBlock) && rsiBlock > 0) {
      const r = rsi(values, rsiPeriod);
      if (r !== null) {
        out.rsi = r;
        const high = Math.max(50, Math.min(100, rsiBlock));
        out.blockUp = r >= high;
        out.blockDown = r <= 100 - high;
      }
    }
    if (values.length < out.needed) return out;
    out.warm = true;
    const diff = ema(values, fast) - ema(values, slow);
    const last = values[values.length - 1];
    if (Math.abs(diff) <= last * 1e-9) return out;   // flat to float noise
    out.dir = diff > 0 ? 'UP' : 'DOWN';
    return out;
  }

  const api = Object.freeze({ createSeries, push, closes, ema, rsi, bias });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && !('NexaCandles' in globalThis)) {
    // Guarded: redefining a non-configurable property on a second injection
    // into the same context would throw and kill the whole script.
    Object.defineProperty(globalThis, 'NexaCandles', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
