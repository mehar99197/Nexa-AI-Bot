/* The trade-panel parsers and the account-route check live inside
   content.js's closure (they need its DOM state), so they are lifted out of
   the source text here — the same technique the horizon test used before
   horizons.js existed. If a marker moves, the test fails loudly rather than
   silently testing nothing. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const grab = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(a !== -1 && b !== -1, 'could not locate ' + startMarker);
  return src.slice(a, b);
};

const panelSrc = grab('  const PAYOUT_RE = /', '  /** Label text of a panel candidate');
const { parseDuration, PAYOUT_RE, movesLikeAClock, distrustExpiryNode, isDistrustedExpiryNode } =
  new Function(panelSrc +
    '\nreturn { parseDuration, PAYOUT_RE, movesLikeAClock, distrustExpiryNode, isDistrustedExpiryNode };')();

test('parseDuration reads MM:SS and HH:MM:SS durations inside 5s..4h', () => {
  assert.equal(parseDuration('00:05'), 5);
  assert.equal(parseDuration('01:00'), 60);
  assert.equal(parseDuration('00:01:00'), 60);
  assert.equal(parseDuration('04:00:00'), 14_400);
  assert.equal(parseDuration('00:00'), null);       // below 5s
  assert.equal(parseDuration('04:00:01'), null);    // above 4h
  assert.equal(parseDuration('12:60'), null);       // not a time
  assert.equal(parseDuration('1.00'), null);
  assert.equal(parseDuration('14:35:00'), null);    // an HH:MM:SS wall clock
});

test('an HH:MM wall clock parses as a duration — which is why movesLikeAClock exists', () => {
  assert.equal(parseDuration('14:35'), 875);
  const clock = {};
  let t = 1_000_000;
  assert.equal(movesLikeAClock(clock, 875, t), false);               // primes the tracker
  for (let i = 0; i < 19; i += 1) assert.equal(movesLikeAClock(clock, 875, t += 3_000), false);
  assert.equal(movesLikeAClock(clock, 876, t += 3_000), false);      // 14:36 — first change
  for (let i = 0; i < 19; i += 1) assert.equal(movesLikeAClock(clock, 876, t += 3_000), false);
  assert.equal(movesLikeAClock(clock, 877, t += 3_000), true);       // 14:37 — changed AGAIN: a clock
});

test('a countdown is caught in two scans; a one-off setting change is not', () => {
  const countdown = {};
  movesLikeAClock(countdown, 47, 0);
  assert.equal(movesLikeAClock(countdown, 44, 3_000), false);    // first change
  assert.equal(movesLikeAClock(countdown, 41, 6_000), true);     // second change inside the window
  const setting = {};
  movesLikeAClock(setting, 60, 0);
  assert.equal(movesLikeAClock(setting, 60, 3_000), false);      // unchanged
  assert.equal(movesLikeAClock(setting, 120, 6_000), false);     // user picked 2:00
  for (let i = 0; i < 100; i += 1) assert.equal(movesLikeAClock(setting, 120, 9_000 + i * 3_000), false);
  assert.equal(movesLikeAClock(setting, 300, 400_000), false);   // picked 5:00 much later: window expired
  const other = {};
  assert.equal(movesLikeAClock(other, 120, 7_000), false);       // a different node primes afresh
});

test('distrust is remembered and time-boxed', () => {
  const node = {};
  const now = Date.now();
  assert.equal(isDistrustedExpiryNode(node, now), false);
  distrustExpiryNode(node, 10_000);
  assert.equal(isDistrustedExpiryNode(node, now + 5_000), true);
  assert.equal(isDistrustedExpiryNode(node, now + 20_000), false);   // expired and forgotten
  assert.equal(isDistrustedExpiryNode(node, now + 5_000), false);
});

test('PAYOUT_RE accepts the payout label forms and nothing else', () => {
  for (const good of ['+85%', '85%', '85 %', '+92%']) assert.ok(PAYOUT_RE.test(good), good);
  for (const bad of ['85', '+85 percent', '%85', '8.5%', '85%%']) assert.ok(!PAYOUT_RE.test(bad), bad);
});

const accountSrc = grab('  function accountType() {', '  /**\n   * Android app: tap the screen for real');

test('accountType is decided by the route and fails closed on anything unknown', () => {
  const at = (pathname) => new Function('location', 'console', accountSrc + '\nreturn accountType();')(
    { pathname }, { error() {} });
  assert.equal(at('/en/demo-trade'), 'demo');
  assert.equal(at('/en/demo-trade/'), 'demo');
  assert.equal(at('/demo-trade'), 'demo');
  assert.equal(at('/zh/demo-trade'), 'demo');
  assert.equal(at('/en/trade'), 'live');
  assert.equal(at('/trade'), 'live');
  assert.equal(at('/en/tradeX'), 'unknown');
  assert.equal(at('/en/'), 'unknown');
  assert.equal(at('/pt-br/demo-trade'), 'unknown');   // unknown locale form -> refuse, not guess
  assert.equal(at(''), 'unknown');
});

test('the stale-signal guard and the money gates are wired the way the audit requires', () => {
  // Cheap structural checks against regressions in the parts a DOM harness
  // would otherwise be needed for.
  assert.ok(/SIGNAL_MAX_AGE_MS:\s*2_500/.test(src), 'SIGNAL_MAX_AGE_MS default');
  assert.ok(/const freshAfter = Date\.now\(\) - CONFIG\.SIGNAL_MAX_AGE_MS/.test(src));
  assert.ok(/if \(sample\.t < freshAfter\) \{\s*staleSkipped \+= 1;/.test(src),
    'stale samples must be skipped before becoming a click');
  assert.ok(/return 'payout unknown'/.test(src), 'unknown payout must veto real clicks');
  assert.ok(/AUTO_MIN_SAMPLES:\s*100/.test(src) && /AUTO_ROLLING:\s*300/.test(src) &&
    /AUTO_CONFIDENCE_Z:\s*2\.0/.test(src), 'auto-mode bar constants');
  assert.ok(/AUTO_MIN_SAMPLES:\s*(\d+)/.exec(src)[1] <= /AUTO_ROLLING:\s*(\d+)/.exec(src)[1],
    'min samples must not exceed the rolling window');
  assert.ok(/const thisRun = trade\.runId === bot\.runId;/.test(src),
    'session counters must be gated on the run that placed the trade');
  assert.ok(!/localStorage\.setItem\(SETTINGS_KEY/.test(src), 'no settings persistence left');
  // The live-account policy: a run re-reads the route before every click and
  // never trades live without the policy allowing it.
  assert.ok(/LIVE_ACCOUNT:\s*'confirm'/.test(src), 'live account defaults to confirm');
  assert.ok(/if \(account !== bot\.account\) \{/.test(src), 'account switch mid-run must stop the run');
  assert.ok(/if \(account === 'live' && !liveAllowed\(\)\) \{\s*log\('BLOCKED/.test(src),
    'a live click must go through liveAllowed()');
  // The payout probe must only spend itself on a tick that can actually click.
  assert.ok(/const cooldownClear = now - bot\.lastTradeAt >= effectiveCooldownMs\(\);/.test(src),
    'payout probe must respect the cooldown');
});
