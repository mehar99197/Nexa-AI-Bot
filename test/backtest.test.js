'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  groupBySymbol, segmentSamples, labelAt, offlineVeto, backtestSymbol, backtestAuto,
  simulateTrades, sweepConfigs, baseConfigsFor, medianSlippageFrac, BASE_CONFIGS,
  collectSignals, walkForward, hourBuckets, loadExports, SWEEP_MIN_DECIDED,
} = require('../tools/backtest.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { horizonFor } = require('../horizons.js');

function samplesFromReturns(returns, spacingMs = 500, start = 100) {
  let price = start;
  const samples = [{ t: 0, price }];
  returns.forEach((value, index) => {
    price *= Math.exp(value);
    samples.push({ t: (index + 1) * spacingMs, price });
  });
  return samples;
}

test('groupBySymbol splits per symbol, sorts by arrival, drops bad rows', () => {
  const map = groupBySymbol([
    ['A', 1, 200, 1.5],
    ['B', 1, 100, 2.5],
    ['A', 2, 100, 1.4],
    ['A', 3, NaN, 1.4],     // no arrival time
    ['A', 4, 300, 0],       // non-positive price
    ['bad'],
  ]);
  assert.deepEqual([...map.keys()].sort(), ['A', 'B']);
  assert.deepEqual(map.get('A').map((s) => s.t), [100, 200]);
});

test('segmentSamples splits on gaps and drops singleton segments', () => {
  const samples = [
    { t: 0, price: 1 }, { t: 500, price: 1 }, { t: 1000, price: 1 },
    { t: 20_000, price: 1 }, { t: 20_500, price: 1 },
    { t: 60_000, price: 1 },                            // singleton — dropped
  ];
  const segments = segmentSamples(samples, 5_000);
  assert.deepEqual(segments.map((s) => s.length), [3, 2]);
});

test('labelAt settles on the first sample at/after expiry', () => {
  const samples = samplesFromReturns(Array.from({ length: 20 }, () => 0.001));
  const outcome = labelAt(samples, 0, 5_000, 5_000);
  assert.equal(outcome.label, 1);                       // steadily rising
  assert.equal(outcome.at, 5_000);
  assert.equal(labelAt(samples, samples.length - 1, 5_000, 5_000), null);
});

test('labelAt rejects a settle sample that arrives too late', () => {
  const samples = [
    { t: 0, price: 100 },
    { t: 500, price: 100.1 },
    { t: 30_000, price: 105 },   // 25s past the 5s expiry target
  ];
  assert.equal(labelAt(samples, 0, 5_000, 5_000), null);
});

test('labelAt honours a handicapped entry price', () => {
  const samples = [{ t: 0, price: 100 }, { t: 5_000, price: 100.005 }];
  assert.equal(labelAt(samples, 0, 5_000, 5_000).label, 1);          // raw: tiny win
  assert.equal(labelAt(samples, 0, 5_000, 5_000, 100.01).label, -1); // after slippage: a loss
});

test('offlineVeto mirrors the post-reset quiet period and the thin-feed gate', () => {
  const dense = samplesFromReturns(Array.from({ length: 100 }, () => 0.0001), 500);
  assert.equal(offlineVeto(dense, 10), 'stabilizing');     // 5s into the segment
  assert.equal(offlineVeto(dense, 90), null);              // 45s in, 2Hz feed
  const sparse = samplesFromReturns(Array.from({ length: 40 }, () => 0.0001), 2_000);
  assert.equal(offlineVeto(sparse, 30), 'thin feed');      // 0.5Hz: 5 samples per 10s
});

test('the configs replayed follow the expiry, like the live bot', () => {
  const five = baseConfigsFor(5);
  const sixty = baseConfigsFor(60);
  assert.equal(five.momentum.EMA_SLOW, horizonFor(5).momentum.EMA_SLOW);
  assert.ok(five.momentum.EMA_SLOW < sixty.momentum.EMA_SLOW);
  assert.equal(sixty.zscore.SLOW_WINDOW, BASE_CONFIGS.zscore.SLOW_WINDOW);
  for (const config of sweepConfigs('both', 5)) {
    assert.ok(config.STRATEGY === 'momentum' ? config.EMA_SLOW <= 20 : config.SLOW_WINDOW === 18,
      'sweep at 5s must use 5s-sized windows: ' + JSON.stringify(config));
  }
});

test('backtestSymbol finds and labels momentum reversal signals', () => {
  const block = [
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 40 }, () => 0.00030),
    ...Array.from({ length: 40 }, () => -0.00030),
  ];
  const samples = samplesFromReturns([...block, ...block]);
  const result = backtestSymbol(samples, BASE_CONFIGS.momentum,
    { expiryMs: 5_000, payoutPct: 85, cooldownMs: 0, vetoes: false });
  assert.equal(result.evaluations, samples.length);
  assert.ok(result.all.total >= 2,
    'expected repeated crossovers, got ' + result.all.total);
  assert.ok(result.all.labeled >= 2);
  assert.equal(result.all.labeled,
    result.all.wins + result.all.losses + result.all.draws);
  assert.ok(result.trades.total <= result.all.total);
  assert.ok(result.trades.lowerBound === null || result.trades.lowerBound <= result.trades.hitRate);
});

test('the offline vetoes hold signals inside the quiet period', () => {
  const block = [
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 40 }, () => 0.00030),
    ...Array.from({ length: 40 }, () => -0.00030),
  ];
  const samples = samplesFromReturns([...block, ...block]);
  const free = backtestSymbol(samples, BASE_CONFIGS.momentum,
    { expiryMs: 5_000, payoutPct: 85, cooldownMs: 0, vetoes: false });
  const gated = backtestSymbol(samples, BASE_CONFIGS.momentum,
    { expiryMs: 5_000, payoutPct: 85, cooldownMs: 0 });
  assert.ok(gated.all.total < free.all.total, 'the first 30s of signals should be held');
  assert.ok((gated.reasons['held: stabilizing'] || 0) > 0);
});

test('an impossible MIN_MOMENTUM yields zero signals', () => {
  const samples = samplesFromReturns([
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 40 }, () => 0.00030),
  ]);
  const result = backtestSymbol(samples,
    { ...BASE_CONFIGS.momentum, MIN_MOMENTUM: 1 },
    { expiryMs: 5_000, payoutPct: 85, cooldownMs: 0, vetoes: false });
  assert.equal(result.all.total, 0);
  assert.equal(result.trades.total, 0);
});

test('simulateTrades enforces the cooldown', () => {
  const signals = [
    { t: 0, dir: 'UP', label: 1 },
    { t: 10_000, dir: 'UP', label: 1 },      // inside cooldown — skipped
    { t: 70_000, dir: 'DOWN', label: -1 },
  ];
  const taken = simulateTrades(signals, 60_000);
  assert.deepEqual(taken.map((s) => s.t), [0, 70_000]);
});

test('an unlabeled signal still consumes the cooldown', () => {
  const signals = [
    { t: 0, dir: 'UP', label: null },        // the live bot would have traded it
    { t: 10_000, dir: 'UP', label: 1 },      // and this one would be blocked
  ];
  const taken = simulateTrades(signals, 60_000);
  assert.deepEqual(taken.map((s) => s.t), [0]);
});

test('medianSlippageFrac needs 5 real fills and ignores dry-run rows', () => {
  const fill = (slippage, dry) => ({ slippage, clickPrice: 100, profit: 1, dry });
  assert.equal(medianSlippageFrac([fill(0.01), fill(0.02), fill(0.03), fill(0.04)]), 0);
  const five = [fill(0.01), fill(0.02), fill(0.03), fill(0.04), fill(0.05)];
  assert.ok(Math.abs(medianSlippageFrac(five) - 0.0003) < 1e-12);
  assert.equal(medianSlippageFrac([...five.slice(0, 4), fill(9, true)]), 0);
});

test('backtestAuto replays the pool and never takes a real trade on a coin flip', () => {
  // A noisy sine — no exploitable drift — long enough for records to fill.
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = Array.from({ length: 6_000 }, (_, i) => ({
    t: i * 500, price: 1.1 + Math.sin(i / 37) * 0.0003 + (rand() - 0.5) * 0.0004,
  }));
  const result = backtestAuto(samples, { expiryMs: 5_000, payoutPct: 85, cooldownMs: 0 });
  assert.equal(result.horizon, '5s');
  assert.equal(result.variants.length, 8);
  assert.ok(result.virtualOutcomes > 100, 'pool should have settled many virtual trades');
  for (const v of result.variants) {
    if (v.n > 0) assert.ok(v.lowerBound <= v.hitRate + 1e-12);
  }
  // With no edge in the series, real trades should be rare to nonexistent.
  assert.ok(result.real.total <= Math.max(3, result.virtualOutcomes * 0.01),
    'took ' + result.real.total + ' real trades on noise');
});

/* ---- pipeline: walk-forward, hour buckets, merged exports ---------------- */

/** A 2Hz series whose drift flips sign every `block` samples — a momentum
    model has something to catch, and a walk-forward fold has trades to
    count. Deterministic (LCG noise) so the assertions are stable. */
function regimeSamples(n, block, t0 = 0) {
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = [];
  let price = 100;
  let drift = 0.00004;
  for (let index = 0; index < n; index += 1) {
    if (index % block === 0) drift = -drift;
    price *= Math.exp(drift + (rand() - 0.5) * 0.00002);
    samples.push({ t: t0 + index * 500, price });
  }
  return samples;
}

const PIPE_OPTS = { expiryMs: 60_000, cooldownMs: 20_000, payoutPct: 85 };

test('collectSignals is what backtestSymbol tallies — same signals, same trades', () => {
  const samples = regimeSamples(6_000, 600);
  const { signals } = collectSignals(samples, BASE_CONFIGS.momentum, PIPE_OPTS);
  const result = backtestSymbol(samples, BASE_CONFIGS.momentum, PIPE_OPTS);
  assert.equal(result.all.total, signals.length);
  assert.equal(result.taken.length, simulateTrades(signals, PIPE_OPTS.cooldownMs).length);
  assert.equal(result.trades.total, result.taken.length);
});

test('walkForward picks on the past and trades the next slice only', () => {
  const samples = regimeSamples(24_000, 600);            // ~3.3 hours of ticks
  const grid = sweepConfigs('momentum', 60);
  const wf = walkForward(samples, grid, PIPE_OPTS, 4);
  assert.equal(wf.folds, 4);
  assert.equal(wf.steps.length, 3);                       // the first slice is training only
  const t0 = samples[0].t;
  const span = samples[samples.length - 1].t - t0;
  for (const step of wf.steps) {
    assert.equal(step.from, t0 + span * step.fold / 4);
    if (step.chosen === null) continue;
    assert.ok(step.train.wins + step.train.losses >= SWEEP_MIN_DECIDED, 'chosen on 30+ decided trades');
    assert.ok(grid.some((c) => step.chosen.includes('EMA ' + c.EMA_FAST + '/' + c.EMA_SLOW)),
      'chosen label names a grid configuration: ' + step.chosen);
  }
  // Out-of-sample trades all fall after the first slice, and the pool is the
  // sum of the per-step test tallies.
  assert.ok(wf.oosTrades.every((trade) => trade.t >= t0 + span / 4));
  const pooled = wf.steps.reduce((sum, s) => sum + (s.test ? s.test.total : 0), 0);
  assert.equal(wf.oos.total, pooled);
  assert.equal(wf.oos.total, wf.oosTrades.length);
});

test('walkForward trades nothing when no configuration clears the bar', () => {
  const samples = regimeSamples(1_200, 600);              // 10 minutes: far too few trades
  const wf = walkForward(samples, sweepConfigs('momentum', 60), PIPE_OPTS, 3);
  assert.equal(wf.steps.length, 2);
  assert.ok(wf.steps.every((step) => step.chosen === null));
  assert.equal(wf.oos.total, 0);
  assert.equal(wf.oos.lowerBound, null);
});

test('walkForward rejects junk input', () => {
  assert.equal(walkForward([], [BASE_CONFIGS.momentum], PIPE_OPTS, 3), null);
  assert.equal(walkForward(regimeSamples(100, 50), [], PIPE_OPTS, 3), null);
  assert.equal(walkForward(regimeSamples(100, 50), [BASE_CONFIGS.momentum], PIPE_OPTS, 1), null);
});

test('hourBuckets groups simulated trades by local hour and skips empty hours', () => {
  const at = (hour, minute) => new Date(2026, 8, 18, hour, minute).getTime();
  const trades = [
    { t: at(9, 5), dir: 'UP', label: 1 }, { t: at(9, 20), dir: 'UP', label: -1 },
    { t: at(9, 40), dir: 'DOWN', label: -1 }, { t: at(14, 0), dir: 'UP', label: 0 },
    { t: NaN }, null,
  ];
  const buckets = hourBuckets(trades);
  assert.deepEqual(buckets.map((b) => b.hour), [9, 14]);
  assert.equal(buckets[0].wins, 2);
  assert.equal(buckets[0].losses, 1);
  assert.equal(buckets[1].draws, 1);
  assert.equal(buckets[1].hitRate, null);
});

test('loadExports merges several exports and drops the rows they share', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-bt-'));
  const rows = (from, to) => Array.from({ length: to - from }, (_, i) => ['EURUSD_otc', 1, (from + i) * 500, 1.08]);
  const trade = { t: 1000, sym: 'EURUSD_otc', profit: 0.85 };
  const one = path.join(dir, 'one.json');
  const two = path.join(dir, 'two.json');
  fs.writeFileSync(one, JSON.stringify({ format: 'nexa-ticks-v1', ticks: rows(0, 100), trades: [trade] }));
  fs.writeFileSync(two, JSON.stringify({ format: 'nexa-ticks-v1', ticks: rows(50, 160), trades: [trade, { t: 2000, sym: 'X' }] }));
  const merged = loadExports([one, two]);
  assert.equal(merged.files, 2);
  assert.equal(merged.ticks.length, 160);               // 100 + 110 - 50 shared
  assert.equal(merged.trades.length, 2);
  // A single file is passed through untouched (no de-duplication pass).
  assert.equal(loadExports([one]).ticks.length, 100);
});
