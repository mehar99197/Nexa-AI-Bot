/* Every variant the horizon pool generates must be accepted by the strategy
   dispatcher. A variant whose config fails validation returns
   "invalid config" forever — it would sit in the scoreboard scoring nothing,
   silently shrinking the pool. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const NexaStrategy = require('../strategy.js');
const { HORIZONS, horizonFor, buildVariants } = require('../horizons.js');

const MAX_VOL = 0.001;

/** Enough samples for any horizon, with a clean trend so decide() runs the
    whole gate chain instead of bailing on length. */
const series = (n) => Array.from({ length: n }, (_, i) => ({
  t: i * 450, price: 1.08 + Math.sin(i / 9) * 0.0004 + i * 0.000002,
}));

test('horizonFor picks the preset by expiry and falls back to the longest', () => {
  assert.equal(horizonFor(5).label, '5s');
  assert.equal(horizonFor(10).label, '5s');
  assert.equal(horizonFor(15).label, '15s');
  assert.equal(horizonFor(60).label, '60s');
  assert.equal(horizonFor(120).label, '60s');
  assert.equal(horizonFor(300).label, '5m+');
  assert.equal(horizonFor(NaN).label, '5m+');
});

test('every horizon produces exactly 8 variants with unique ids', () => {
  for (const row of HORIZONS) {
    const pool = buildVariants(row, MAX_VOL);
    assert.strictEqual(pool.length, 8, row.label + ' pool size');
    assert.strictEqual(new Set(pool.map((v) => v.id)).size, 8, row.label + ' unique ids');
    for (const variant of pool) {
      assert.strictEqual(variant.config.MAX_REALIZED_VOLATILITY, MAX_VOL,
        row.label + ' / ' + variant.id + ' carries the live volatility cap');
    }
  }
});

test('no generated variant is rejected as an invalid config', () => {
  const history = series(400);
  for (const row of HORIZONS) {
    for (const variant of buildVariants(row, MAX_VOL)) {
      const result = NexaStrategy.decide(history, variant.config);
      assert.notStrictEqual(result.reason, 'invalid config',
        row.label + ' / ' + variant.id + ' was rejected as invalid config');
      assert.notStrictEqual(result.reason, 'invalid input',
        row.label + ' / ' + variant.id + ' was rejected as invalid input');
    }
  }
});

test('momentum variants satisfy decideMomentum window constraints', () => {
  for (const row of HORIZONS) {
    for (const variant of buildVariants(row, MAX_VOL)) {
      const c = variant.config;
      if (c.STRATEGY !== 'momentum') continue;
      const where = row.label + ' / ' + variant.id;
      assert.ok(Number.isInteger(c.EMA_FAST) && c.EMA_FAST >= 2, where + ' EMA_FAST');
      assert.ok(Number.isInteger(c.EMA_SLOW) && c.EMA_SLOW > c.EMA_FAST, where + ' EMA_SLOW');
      assert.ok(Number.isInteger(c.MOMENTUM_TICKS) && c.MOMENTUM_TICKS >= 1 &&
        c.MOMENTUM_TICKS <= c.EMA_SLOW, where + ' MOMENTUM_TICKS');
      assert.ok(c.MIN_MOMENTUM >= 0, where + ' MIN_MOMENTUM');
    }
  }
});

test('zscore variants satisfy decideZScore window constraints', () => {
  for (const row of HORIZONS) {
    for (const variant of buildVariants(row, MAX_VOL)) {
      const c = variant.config;
      if (c.STRATEGY !== 'zscore') continue;
      const where = row.label + ' / ' + variant.id;
      assert.ok(Number.isInteger(c.FAST_WINDOW) && c.FAST_WINDOW >= 2, where + ' FAST_WINDOW');
      assert.ok(Number.isInteger(c.SLOW_WINDOW) && c.SLOW_WINDOW > c.FAST_WINDOW, where + ' SLOW_WINDOW');
      assert.ok(Number.isFinite(c.Z_SCORE_THRESHOLD) && c.Z_SCORE_THRESHOLD > 0, where + ' threshold');
      assert.ok(Number.isFinite(c.MIN_EFFICIENCY_RATIO), where + ' efficiency');
    }
  }
});

test('a shorter horizon really does use shorter windows', () => {
  const byLabel = Object.fromEntries(HORIZONS.map((r) => [r.label, r]));
  assert.ok(byLabel['5s'].momentum.EMA_SLOW < byLabel['60s'].momentum.EMA_SLOW);
  assert.ok(byLabel['5s'].zscore.SLOW_WINDOW < byLabel['60s'].zscore.SLOW_WINDOW);
  // ...and demands a BIGGER move, because slippage eats a larger share of it.
  assert.ok(byLabel['5s'].momentum.MIN_MOMENTUM > byLabel['60s'].momentum.MIN_MOMENTUM);
});

test('the 5s horizon warms up inside the scanner buffer', () => {
  // SCANNER_KEEP is 120 samples; a horizon the warm start cannot fill would
  // never benefit from seeding.
  const row = HORIZONS.find((r) => r.label === '5s');
  for (const variant of buildVariants(row, MAX_VOL)) {
    const need = variant.config.STRATEGY === 'momentum'
      ? variant.config.EMA_SLOW + 2
      : variant.config.SLOW_WINDOW + 1;
    assert.ok(need <= 120, variant.id + ' needs ' + need + ' samples, scanner keeps 120');
  }
});

test('content.js and the manifest load horizons.js, not a private copy', () => {
  const fs = require('fs');
  const path = require('path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.ok(!/const HORIZONS = \[/.test(content), 'content.js still defines its own HORIZONS');
  assert.ok(!/function buildVariants\(/.test(content), 'content.js still defines buildVariants');
  assert.ok(/NexaHorizons\.buildVariants\(/.test(content));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const isolated = manifest.content_scripts.find((entry) => entry.world === 'ISOLATED');
  const order = isolated.js;
  assert.ok(order.indexOf('horizons.js') !== -1, 'horizons.js is not in the manifest');
  assert.ok(order.indexOf('horizons.js') < order.indexOf('content.js'),
    'horizons.js must load before content.js');
  assert.ok(order.indexOf('strategy.js') < order.indexOf('content.js'));
  assert.ok(order.indexOf('autopilot.js') < order.indexOf('content.js'));
});
