'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_KEY, SCHEMA, GROUPS, valid, sanitize, parse, defaults } = require('../settings.js');

const root = path.join(__dirname, '..');

/** content.js's CONFIG literal, evaluated — the source of truth the schema
    defaults must match. Lifted out of the source text like panel.test.js
    does; a moved marker fails loudly. */
function liveConfig() {
  const src = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const start = src.indexOf('  const CONFIG = {');
  const end = src.indexOf('\n  };', start);
  assert.ok(start !== -1 && end !== -1, 'could not locate CONFIG in content.js');
  return new Function(src.slice(start + '  const CONFIG = '.length, end + '\n  }'.length).replace(/^/, 'return ') )();
}

test('every schema default equals the CONFIG default in content.js', () => {
  const config = liveConfig();
  for (const row of SCHEMA) {
    assert.ok(Object.prototype.hasOwnProperty.call(config, row.key), row.key + ' is not in CONFIG');
    assert.equal(config[row.key], row.default, row.key + ' default drifted from content.js');
    assert.ok(valid(row, row.default), row.key + ' default is not valid under its own rule');
  }
});

test('schema rows are well-formed and grouped', () => {
  const keys = new Set();
  for (const row of SCHEMA) {
    assert.ok(!keys.has(row.key), 'duplicate key ' + row.key);
    keys.add(row.key);
    assert.ok(['bool', 'int', 'number', 'enum'].includes(row.type), row.key + ' type');
    assert.ok(typeof row.label === 'string' && row.label.length > 0, row.key + ' label');
    assert.ok(typeof row.help === 'string' && row.help.length > 0, row.key + ' help');
    assert.ok(GROUPS.includes(row.group), row.key + ' group');
    if (row.type === 'int' || row.type === 'number') {
      assert.ok(Number.isFinite(row.min) && Number.isFinite(row.max) && row.min < row.max, row.key + ' range');
    }
    if (row.type === 'enum') assert.ok(Array.isArray(row.options) && row.options.length >= 2, row.key + ' options');
  }
  assert.equal(SETTINGS_KEY, 'nexa.autotrade.prefs');
  assert.deepEqual(GROUPS, ['Trading', 'Money', 'Filters', 'Data & alerts']);
});

test('sanitize keeps valid overrides, reports the rest, ignores unknown keys', () => {
  const { overrides, rejected } = sanitize({
    STRATEGY: 'trend',
    MIN_PAYOUT_PCT: 75,
    KELLY_FRACTION: 2,          // above max
    STAKE_MODE: 'martingale',   // not an option
    DRY_RUN: 'yes',             // not a boolean
    KEEP_TRADING_AFTER_SEC: 1.5, // not an integer
    TICK_MS: 5,                 // not user-settable
    __proto__: { HTF_FILTER: false },
  });
  assert.deepEqual(overrides, { STRATEGY: 'trend', MIN_PAYOUT_PCT: 75 });
  assert.deepEqual(rejected.sort(), ['DRY_RUN', 'KEEP_TRADING_AFTER_SEC', 'KELLY_FRACTION', 'STAKE_MODE']);
});

test('sanitize is safe on junk input', () => {
  for (const junk of [null, undefined, 'x', 42, [], true]) {
    assert.deepEqual(sanitize(junk), { overrides: {}, rejected: [] });
  }
});

test('parse turns form text into typed values and rejects what does not fit', () => {
  const int = SCHEMA.find((r) => r.key === 'MIN_PAYOUT_PCT');
  const num = SCHEMA.find((r) => r.key === 'KELLY_FRACTION');
  const en = SCHEMA.find((r) => r.key === 'STRATEGY');
  const bool = SCHEMA.find((r) => r.key === 'DRY_RUN');
  assert.equal(parse(int, ' 70 '), 70);
  assert.equal(parse(int, '70.5'), null);
  assert.equal(parse(int, ''), null);
  assert.equal(parse(num, '0.25'), 0.25);
  assert.equal(parse(num, 'abc'), null);
  assert.equal(parse(en, 'auto'), 'auto');
  assert.equal(parse(en, 'nope'), null);
  assert.equal(parse(bool, 'true'), true);
  assert.equal(parse(bool, 'false'), false);
});

test('defaults() is a fresh copy of every default', () => {
  const a = defaults();
  const b = defaults();
  assert.notEqual(a, b);
  assert.equal(Object.keys(a).length, SCHEMA.length);
  assert.equal(a.STAKE_MODE, 'kelly');
});

test('the manifest loads settings.js before content.js and points the action at the popup', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const order = manifest.content_scripts.find((block) => block.world === 'ISOLATED').js;
  assert.ok(order.indexOf('settings.js') < order.indexOf('content.js'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.ok(html.includes('src="settings.js"') && html.includes('src="popup.js"'));
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline scripts (MV3 popup CSP)');
});
