'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decide } = require('../strategy.js');

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
