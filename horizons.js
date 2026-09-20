/* Horizon presets + the auto-mode variant pool, shared by the isolated
   content script and tools/backtest.js. Pure data and pure functions — no
   DOM, no storage — so the backtester replays exactly the windows the live
   bot would run for a given expiry instead of a hardcoded 60s copy. */
(() => {
  'use strict';

  /**
   * Strategy windows matched to the contract's horizon.
   *
   * Every window here is in TICKS, and the feed runs at roughly 2Hz, so a
   * 5-second contract is decided by about 11 samples. Using the 60s windows
   * (EMA 10/30, z 12/48) to forecast 5 seconds means the indicator's own
   * lookback is longer than the thing it predicts — the crossover reports a
   * trend that has already had more time to happen than the trade will last.
   *
   * MIN_MOMENTUM rises as the horizon shortens for the opposite reason: the
   * shorter the contract, the smaller the move, and the more of that move is
   * eaten by slippage. See CONFIG.EDGE_OVER_COST in content.js.
   */
  const HORIZONS = Object.freeze([
    { maxSec: 10, label: '5s',
      momentum: { EMA_FAST: 3, EMA_SLOW: 9, MOMENTUM_TICKS: 3, MIN_MOMENTUM: 0.00008 },
      zscore: { FAST_WINDOW: 4, SLOW_WINDOW: 18, Z_SCORE_THRESHOLD: 1.2, MIN_EFFICIENCY_RATIO: 0.08 } },
    { maxSec: 30, label: '15s',
      momentum: { EMA_FAST: 5, EMA_SLOW: 16, MOMENTUM_TICKS: 4, MIN_MOMENTUM: 0.00004 },
      zscore: { FAST_WINDOW: 7, SLOW_WINDOW: 28, Z_SCORE_THRESHOLD: 1.3, MIN_EFFICIENCY_RATIO: 0.09 } },
    { maxSec: 120, label: '60s',
      momentum: { EMA_FAST: 10, EMA_SLOW: 30, MOMENTUM_TICKS: 6, MIN_MOMENTUM: 0.00001 },
      zscore: { FAST_WINDOW: 12, SLOW_WINDOW: 48, Z_SCORE_THRESHOLD: 1.5, MIN_EFFICIENCY_RATIO: 0.10 } },
    { maxSec: Infinity, label: '5m+',
      momentum: { EMA_FAST: 16, EMA_SLOW: 50, MOMENTUM_TICKS: 10, MIN_MOMENTUM: 0.00001 },
      zscore: { FAST_WINDOW: 20, SLOW_WINDOW: 80, Z_SCORE_THRESHOLD: 1.6, MIN_EFFICIENCY_RATIO: 0.12 } },
  ]);

  /** The preset for a contract of `seconds`; the longest one for junk input. */
  function horizonFor(seconds) {
    return HORIZONS.find((row) => seconds <= row.maxSec) || HORIZONS[HORIZONS.length - 1];
  }

  /**
   * The auto-mode variant pool for one horizon.
   *
   * Built FROM the horizon rather than pinned to the 60s windows it used to
   * hardcode: running EMA 6/20..14/45 against a 5-second contract meant every
   * variant was forecasting a horizon several times longer than the trade —
   * the scoreboard faithfully measured eight models all aimed at the wrong
   * target. Variant ids carry their windows, and the scoreboard key includes
   * the expiry, so each horizon keeps its own clean record.
   *
   * @param {Object} row a HORIZONS entry
   * @param {number} maxRealizedVolatility the live CONFIG.MAX_REALIZED_VOLATILITY
   * @returns {Array<{id: string, config: Object, minER?: number, adaptive?: boolean}>}
   */
  function buildVariants(row, maxRealizedVolatility) {
    const momentumBase = {
      STRATEGY: 'momentum',
      MOMENTUM_TICKS: row.momentum.MOMENTUM_TICKS,
      MIN_MOMENTUM: row.momentum.MIN_MOMENTUM,
      MAX_REALIZED_VOLATILITY: maxRealizedVolatility,
    };
    const zscoreBase = {
      STRATEGY: 'zscore',
      FAST_WINDOW: row.zscore.FAST_WINDOW,
      SLOW_WINDOW: row.zscore.SLOW_WINDOW,
      MAX_REALIZED_VOLATILITY: maxRealizedVolatility,
    };
    const baseFast = row.momentum.EMA_FAST;
    const baseSlow = row.momentum.EMA_SLOW;
    // Same spread the old pool had around its base pair (~0.65x, 1x, ~1.45x),
    // clamped so decideMomentum's own validation always passes.
    const pair = (scaleFast, scaleSlow) => {
      const fast = Math.max(2, Math.round(baseFast * scaleFast));
      const slow = Math.max(fast + 2, Math.round(baseSlow * scaleSlow));
      return { fast, slow };
    };
    const tight = pair(0.65, 0.65);
    const mid = pair(1, 1);
    const wide = pair(1.45, 1.5);
    const mom = (p) => ({
      ...momentumBase,
      EMA_FAST: p.fast,
      EMA_SLOW: p.slow,
      MOMENTUM_TICKS: Math.min(momentumBase.MOMENTUM_TICKS, p.slow),
    });
    const zThr = row.zscore.Z_SCORE_THRESHOLD;
    const name = (p) => p.fast + '/' + p.slow;
    return [
      { id: 'M' + name(tight), config: mom(tight) },
      { id: 'M' + name(mid), config: mom(mid) },
      { id: 'M' + name(wide), config: mom(wide) },
      // Regime-gated: same crossovers, but only while the market is trending
      // (ER >= minER). Chop-time whipsaw is the crossover's main failure mode.
      { id: 'R' + name(tight), minER: 0.25, config: mom(tight) },
      { id: 'R' + name(mid), minER: 0.25, config: mom(mid) },
      { id: 'Z' + (zThr - 0.3).toFixed(1),
        config: { ...zscoreBase, Z_SCORE_THRESHOLD: zThr - 0.3,
                  MIN_EFFICIENCY_RATIO: row.zscore.MIN_EFFICIENCY_RATIO / 2 } },
      { id: 'Z' + zThr.toFixed(1),
        config: { ...zscoreBase, Z_SCORE_THRESHOLD: zThr,
                  MIN_EFFICIENCY_RATIO: row.zscore.MIN_EFFICIENCY_RATIO } },
      // Adaptive z: the threshold is recalibrated live to the p90 of the |z|
      // this feed actually produces (fixed thresholds rot per asset).
      { id: 'ZA', adaptive: true,
        config: { ...zscoreBase, Z_SCORE_THRESHOLD: zThr,
                  MIN_EFFICIENCY_RATIO: row.zscore.MIN_EFFICIENCY_RATIO / 2 } },
    ];
  }

  const api = Object.freeze({ HORIZONS, horizonFor, buildVariants });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && !('NexaHorizons' in globalThis)) {
    // Guarded: redefining a non-configurable property on a second injection
    // into the same context would throw and kill the whole script.
    Object.defineProperty(globalThis, 'NexaHorizons', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
