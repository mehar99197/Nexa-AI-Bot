'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decide, mean, sampleDeviation } = require('../strategy.js');

const config = Object.freeze({
  FAST_WINDOW: 12,
  SLOW_WINDOW: 48,
  Z_SCORE_THRESHOLD: 2.5,
  MIN_EFFICIENCY_RATIO: 0.55,
  MAX_REALIZED_VOLATILITY: 0.015,
});

function historyFromReturns(returns, start = 100) {
  let price = start;
  return [{ t: 0, price }, ...returns.map((value, index) => {
    price *= Math.exp(value);
    return { t: index + 1, price };
  })];
}

test('rejects insufficient history', () => {
  const result = decide([{ t: 0, price: 100 }], config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'warming up');
});

test('accepts a low-volatility, statistically significant aligned uptrend', () => {
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? 0.00005 + ((index % 3) - 1) * 0.00001 : 0.00055 + ((index % 3) - 1) * 0.00002
  );
  const result = decide(historyFromReturns(returns), config);
  assert.equal(result.signal, 'UP');
  assert.ok(result.zScore > config.Z_SCORE_THRESHOLD);
});

test('accepts a low-volatility, statistically significant aligned downtrend', () => {
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? -0.00005 + ((index % 3) - 1) * 0.00001 : -0.00055 + ((index % 3) - 1) * 0.00002
  );
  const result = decide(historyFromReturns(returns), config);
  assert.equal(result.signal, 'DOWN');
  assert.ok(result.zScore < -config.Z_SCORE_THRESHOLD);
});

test('rejects a high-volatility path despite positive drift', () => {
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? (index % 2 ? 0.02 : -0.018) : (index % 2 ? 0.023 : -0.015)
  );
  const result = decide(historyFromReturns(returns), config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'volatility limit');
});

test('rejects a choppy path with low efficiency', () => {
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? (index % 2 ? 0.0005 : -0.00045) : (index % 2 ? 0.0007 : -0.0005)
  );
  const result = decide(historyFromReturns(returns), config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'noisy path');
});

test('reports insufficient trend evidence when the drift is below the threshold', () => {
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? 0.0001 + ((index % 3) - 1) * 0.0001 : 0.00005
  );
  const result = decide(historyFromReturns(returns), config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'insufficient trend evidence');
});

test('rejects invalid input', () => {
  assert.equal(decide(null, config).reason, 'invalid input');
  assert.equal(decide([{ t: 0, price: 100 }], null).reason, 'invalid input');
});

test('reports invalid config for broken windows', () => {
  const history = historyFromReturns(Array.from({ length: 49 }, () => 0.0001));
  assert.equal(decide(history, { ...config, FAST_WINDOW: 12.5 }).reason, 'invalid config');
  assert.equal(decide(history, { ...config, SLOW_WINDOW: 12 }).reason, 'invalid config');
});

test('fails closed when a gate threshold is missing', () => {
  // Without this guard a missing threshold makes every reject-if-true gate
  // comparison false, and this weak drift produces a spurious signal.
  const returns = Array.from({ length: 49 }, (_, index) =>
    index < 37 ? 0.00005 + ((index % 3) - 1) * 0.00001 : 0.00055 + ((index % 3) - 1) * 0.00002
  );
  const result = decide(historyFromReturns(returns), { FAST_WINDOW: 12, SLOW_WINDOW: 48 });
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'invalid config');
});

test('rejects an invalid price sample', () => {
  const history = historyFromReturns(Array.from({ length: 49 }, () => 0.0001));
  history[10] = { t: 10, price: 0 };
  assert.equal(decide(history, config).reason, 'invalid price');
});

test('reports zero variance for flat prices', () => {
  const history = Array.from({ length: 50 }, (_, index) => ({ t: index, price: 100 }));
  const result = decide(history, config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'zero variance');
});

test('treats float-noise variance from a constant drift as zero variance', () => {
  // Reconstructed log returns of a constant drift differ only by ~1e-17 of
  // rounding noise; without the epsilon this yields a z-score around 1e16.
  const result = decide(historyFromReturns(Array.from({ length: 49 }, () => 0.001)), config);
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'zero variance');
});

test('mean and sampleDeviation ignore non-finite values consistently', () => {
  assert.equal(mean([2, NaN]), 2);
  assert.equal(mean([]), 0);
  assert.equal(sampleDeviation([1, 1, NaN], 1), 0);
  assert.equal(sampleDeviation([NaN, 1], 1), 0);
});

// ---- momentum strategy (STRATEGY: 'momentum') ----

const momoConfig = Object.freeze({
  STRATEGY: 'momentum',
  EMA_FAST: 10,
  EMA_SLOW: 30,
  MOMENTUM_TICKS: 6,
  MIN_MOMENTUM: 0.00001,
  MAX_REALIZED_VOLATILITY: 0.001,
});

/** Walk growing prefixes and return the first non-null signal (or null). */
function firstSignal(history, cfg) {
  for (let end = 2; end <= history.length; end++) {
    const result = decide(history.slice(0, end), cfg);
    if (result.signal) return result;
  }
  return null;
}

test('unknown STRATEGY value fails closed', () => {
  const history = historyFromReturns(Array.from({ length: 49 }, () => 0.0001));
  const result = decide(history, { ...config, STRATEGY: 'yolo' });
  assert.equal(result.signal, null);
  assert.equal(result.reason, 'invalid config');
});

test('momentum: reports warming up on short history', () => {
  const result = decide([{ t: 0, price: 100 }], momoConfig);
  assert.equal(result.reason, 'warming up');
});

test('momentum: invalid config when EMA_SLOW <= EMA_FAST', () => {
  const history = historyFromReturns(Array.from({ length: 40 }, () => 0.0001));
  const result = decide(history, { ...momoConfig, EMA_SLOW: 10 });
  assert.equal(result.reason, 'invalid config');
});

test('momentum: a down-then-up reversal produces an UP crossover signal', () => {
  const returns = [
    ...Array.from({ length: 40 }, () => -0.00008),  // establish fast below slow
    ...Array.from({ length: 20 }, () => 0.00030),   // reversal drives the cross
  ];
  const result = firstSignal(historyFromReturns(returns), momoConfig);
  assert.ok(result, 'expected a signal somewhere in the reversal');
  assert.equal(result.signal, 'UP');
  assert.equal(result.reason, 'momentum crossover');
});

test('momentum: an up-then-down reversal produces a DOWN crossover signal', () => {
  const returns = [
    ...Array.from({ length: 40 }, () => 0.00008),
    ...Array.from({ length: 20 }, () => -0.00030),
  ];
  const result = firstSignal(historyFromReturns(returns), momoConfig);
  assert.ok(result, 'expected a signal somewhere in the reversal');
  assert.equal(result.signal, 'DOWN');
});

test('momentum: an absurd MIN_MOMENTUM suppresses every signal', () => {
  const returns = [
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 20 }, () => 0.00030),
  ];
  const result = firstSignal(historyFromReturns(returns), { ...momoConfig, MIN_MOMENTUM: 1 });
  assert.equal(result, null);
});

test('momentum: volatility gate blocks a spiking series', () => {
  const returns = [
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 20 }, (_, i) => (i % 2 ? -0.004 : 0.005)),  // violent chop upward
  ];
  const history = historyFromReturns(returns);
  let sawVolLimit = false;
  for (let end = 2; end <= history.length; end++) {
    const r = decide(history.slice(0, end), momoConfig);
    assert.equal(r.signal, null);
    if (r.reason === 'volatility limit') sawVolLimit = true;
  }
  assert.ok(sawVolLimit, 'expected the volatility gate to engage');
});

// ---- trend state (STRATEGY: 'trend' and the instant entry after Start) ----

const { decideTrendState } = require('../strategy.js');
const trendConfig = Object.freeze({ ...momoConfig, STRATEGY: 'trend' });

test('trend: a signal on every sample once 5 samples exist, following the EMA state', () => {
  assert.equal(decideTrendState([{ t: 0, price: 100 }], trendConfig).reason, 'warming up');
  const up = historyFromReturns(Array.from({ length: 6 }, () => 0.0001));
  const upView = decide(up, trendConfig);
  assert.equal(upView.signal, 'UP');
  assert.equal(upView.reason, 'trend state');
  assert.ok(upView.pct > 0);
  const down = historyFromReturns(Array.from({ length: 40 }, () => -0.0001));
  assert.equal(decide(down, trendConfig).signal, 'DOWN');
  // Unlike the crossover it does not need an EVENT: a steady trend keeps signalling.
  assert.equal(decide(down.slice(0, 20), trendConfig).signal, 'DOWN');
});

test('trend: flat prices give no direction, spikes hit the volatility gate, config is validated', () => {
  const flat = Array.from({ length: 20 }, (_, i) => ({ t: i, price: 100 }));
  assert.equal(decideTrendState(flat, trendConfig).reason, 'flat trend');
  const spiky = historyFromReturns(Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.02 : -0.018)));
  assert.equal(decideTrendState(spiky, trendConfig).reason, 'volatility limit');
  assert.equal(decideTrendState(flat, { ...trendConfig, EMA_SLOW: 5 }).reason, 'invalid config');
  assert.equal(decideTrendState(flat, {}).reason, 'invalid config');
  assert.equal(decide(flat, { ...trendConfig, STRATEGY: 'nope' }).reason, 'invalid config');
});

test('trend: a reversal flips the state a few ticks after the crossover model fires', () => {
  const history = historyFromReturns([
    ...Array.from({ length: 40 }, () => -0.00008),
    ...Array.from({ length: 20 }, () => 0.00030),
  ]);
  let flippedAt = null;
  for (let end = 41; end <= history.length; end += 1) {
    if (decideTrendState(history.slice(0, end), trendConfig).signal === 'UP') { flippedAt = end; break; }
  }
  assert.ok(flippedAt !== null && flippedAt > 41 && flippedAt < 60, 'flipped at ' + flippedAt);
});
