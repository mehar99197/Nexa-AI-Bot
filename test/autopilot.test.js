'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  efficiencyRatio, percentile, gapFreeSuffix, settlePendings, recordOutcome,
  statsOf, breakEvenRate, wilsonLowerBound, bestQualified,
} = require('../autopilot.js');

test('efficiencyRatio: straight trend is 1, pure chop is ~0, short history is null', () => {
  const trend = Array.from({ length: 31 }, (_, i) => ({ price: 100 * Math.exp(i * 0.001) }));
  assert.ok(Math.abs(efficiencyRatio(trend, 30) - 1) < 1e-9);

  const chop = Array.from({ length: 31 }, (_, i) => ({ price: i % 2 ? 100.1 : 100 }));
  assert.ok(efficiencyRatio(chop, 30) < 0.05);

  assert.equal(efficiencyRatio(trend.slice(0, 10), 30), null);
  assert.equal(efficiencyRatio([{ price: 100 }, { price: 0 }, { price: 100 }], 2), null);
});

test('percentile picks from the sorted sample and survives junk', () => {
  assert.equal(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0), 1);
  assert.equal(percentile([2, NaN, 1], 0.5), 2);
  assert.equal(percentile([], 0.9), null);
});

test('gapFreeSuffix stops at the last gap and honours the cap', () => {
  const samples = [
    { t: 0 }, { t: 500 },
    { t: 20_000 }, { t: 20_500 }, { t: 21_000 },   // after a 19.5s gap
  ];
  assert.deepEqual(gapFreeSuffix(samples, 5_000, 100).map((s) => s.t),
    [20_000, 20_500, 21_000]);
  assert.deepEqual(gapFreeSuffix(samples, 5_000, 2).map((s) => s.t),
    [20_500, 21_000]);
  assert.deepEqual(gapFreeSuffix(samples, 60_000, 100).length, 5);
  assert.deepEqual(gapFreeSuffix([], 5_000, 10), []);
});

test('settlePendings: future kept, expired settled as w/l/d', () => {
  const pendings = [
    { variantId: 'up-win',  dir: 'UP',   price: 100, expiresAt: 1000 },
    { variantId: 'up-loss', dir: 'UP',   price: 102, expiresAt: 1000 },
    { variantId: 'dn-win',  dir: 'DOWN', price: 102, expiresAt: 1000 },
    { variantId: 'draw',    dir: 'UP',   price: 101, expiresAt: 1000 },
    { variantId: 'future',  dir: 'UP',   price: 100, expiresAt: 9000 },
  ];
  const { keep, outcomes } = settlePendings(pendings, { t: 1200, price: 101 }, 5000);
  assert.deepEqual(keep.map((p) => p.variantId), ['future']);
  const byId = Object.fromEntries(outcomes.map((o) => [o.variantId, o.outcome]));
  assert.deepEqual(byId,
    { 'up-win': 'w', 'up-loss': 'l', 'dn-win': 'w', draw: 'd' });
});

test('settlePendings drops an outcome when the settle sample is too late', () => {
  const pendings = [{ variantId: 'x', dir: 'UP', price: 100, expiresAt: 1000 }];
  const { keep, outcomes } = settlePendings(pendings, { t: 20_000, price: 105 }, 5000);
  assert.deepEqual(keep, []);
  assert.deepEqual(outcomes, []);
});

test('recordOutcome appends and trims to the cap', () => {
  assert.equal(recordOutcome(undefined, 'w', 5), 'w');
  assert.equal(recordOutcome('wwll', 'd', 5), 'wwlld');
  assert.equal(recordOutcome('wwlld', 'w', 5), 'wlldw');   // oldest trimmed
});

test('statsOf counts outcomes; draws are excluded from the hit-rate', () => {
  assert.deepEqual(statsOf('wwwlld'),
    { wins: 3, losses: 2, draws: 1, n: 5, hitRate: 0.6 });
  assert.deepEqual(statsOf(''),
    { wins: 0, losses: 0, draws: 0, n: 0, hitRate: null });
  assert.equal(statsOf(undefined).hitRate, null);
});

test('breakEvenRate: 54.1% at 85% payout, 50% at 100%, null when invalid', () => {
  assert.ok(Math.abs(breakEvenRate(85) - 0.54054) < 0.0005);
  assert.equal(breakEvenRate(100), 0.5);
  assert.equal(breakEvenRate(0), null);
  assert.equal(breakEvenRate(NaN), null);
});

test('wilsonLowerBound shrinks small samples toward 0.5 and rejects junk', () => {
  // 18/30 = 60% observed, but at z=2 we can only be confident of ~42%.
  const small = wilsonLowerBound(18, 30, 2.0);
  assert.ok(small > 0.40 && small < 0.45, 'got ' + small);
  // 180/300 = the same 60%, now backed by 300 outcomes: ~54%.
  const large = wilsonLowerBound(180, 300, 2.0);
  assert.ok(large > 0.53 && large < 0.55, 'got ' + large);
  assert.ok(large > small);
  // z = 0 is the raw ratio; a perfect record still stays below 1.
  assert.equal(wilsonLowerBound(3, 4, 0), 0.75);
  assert.ok(wilsonLowerBound(50, 50, 2.0) < 1);
  assert.equal(wilsonLowerBound(0, 0, 2.0), null);
  assert.equal(wilsonLowerBound(5, 4, 2.0), null);
  assert.equal(wilsonLowerBound(2.5, 4, 2.0), null);
  assert.equal(wilsonLowerBound(2, 4, NaN), null);
});

const rec = (wins, losses) => statsOf('w'.repeat(wins) + 'l'.repeat(losses));

test('bestQualified qualifies on the LOWER bound, ranks by it, fails closed', () => {
  const stats = {
    few:   rec(27, 3),      // 90% of 30 — too few samples
    lucky: rec(66, 34),     // 66% of 100: LB ≈ 0.56 — clears 0.5505
    solid: rec(186, 114),   // 62% of 300: LB ≈ 0.56 too, slightly higher evidence
    weak:  rec(58, 42),     // 58% of 100: LB ≈ 0.48 — observed ratio clears, bound does not
  };
  const opts = { breakEven: 0.5405, minSamples: 100, margin: 0.01, confidenceZ: 2.0 };
  const winner = bestQualified(Object.keys(stats), (id) => stats[id], opts);
  assert.ok(winner, 'expected a qualifier');
  assert.ok(['lucky', 'solid'].includes(winner.id));
  assert.ok(winner.lowerBound >= 0.5505);
  assert.equal(bestQualified(['few', 'weak'], (id) => stats[id], opts), null,
    'a raw 58% over 100 must NOT qualify: its lower bound is under break-even');

  // Missing options disqualify everything instead of comparing against NaN.
  assert.equal(bestQualified(['solid'], (id) => stats[id], { breakEven: 0.54 }), null);
  assert.equal(bestQualified(['solid'], (id) => stats[id],
    { breakEven: 0.54, minSamples: 100 }), null);
  assert.equal(bestQualified(['solid'], (id) => stats[id],
    { breakEven: NaN, minSamples: 100, margin: 0 }), null);
});

test('a coin-flip pool almost never qualifies under the live bar', () => {
  // Deterministic LCG so the test cannot flake; 8 variants, 400 outcomes each.
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const opts = { breakEven: 0.5405, minSamples: 100, margin: 0.01, confidenceZ: 2.0 };
  let armedTicks = 0;
  let trials = 0;
  for (let trial = 0; trial < 20; trial += 1) {
    const records = Array(8).fill('');
    for (let k = 0; k < 400; k += 1) {
      for (let v = 0; v < 8; v += 1) {
        records[v] = recordOutcome(records[v], rand() < 0.5 ? 'w' : 'l', 300);
      }
      if (k < 100) continue;
      trials += 1;
      if (bestQualified(records.map((_, i) => String(i)), (id) => statsOf(records[+id]), opts)) {
        armedTicks += 1;
      }
    }
  }
  // The old bar (raw ratio, 30 samples, 4 points) armed ~50% of the time here.
  assert.ok(armedTicks / trials < 0.02, 'armed ' + (armedTicks / trials * 100).toFixed(1) + '% of the time');
});
