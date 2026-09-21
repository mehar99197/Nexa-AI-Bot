'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createSeries, push, closes, ema, rsi, bias } = require('../candles.js');
const { htfGate, HTF } = require('../tools/backtest.js');

const MIN = 60_000;

/** Feed a series one tick per `stepMs` from the prices given. */
function feed(series, prices, stepMs, t0 = 0) {
  prices.forEach((price, index) => push(series, t0 + index * stepMs, price));
}

test('createSeries validates its arguments', () => {
  assert.ok(createSeries(MIN, 10));
  assert.equal(createSeries(0, 10), null);
  assert.equal(createSeries(MIN, 0), null);
  assert.equal(createSeries(NaN, 10), null);
});

test('push aligns candles to wall-clock periods and keeps OHLC', () => {
  const series = createSeries(MIN, 10);
  const t0 = 1_800_000_000_000;                       // an exact minute boundary
  assert.equal(push(series, t0 + 5_000, 1.0), null);   // first tick opens the candle
  assert.equal(push(series, t0 + 20_000, 1.3), null);
  assert.equal(push(series, t0 + 40_000, 0.9), null);
  assert.equal(push(series, t0 + 59_999, 1.1), null);
  const closed = push(series, t0 + MIN + 1, 1.2);      // the next minute closes it
  assert.deepEqual(closed, { t: t0, o: 1.0, h: 1.3, l: 0.9, c: 1.1, n: 4 });
  assert.deepEqual(closes(series), [1.1]);
  assert.equal(series.open.t, t0 + MIN);
  assert.equal(series.open.o, 1.2);
});

test('push ignores junk and out-of-order ticks, and trims to `keep`', () => {
  const series = createSeries(MIN, 3);
  assert.equal(push(series, 5_000, 0), null);          // non-positive price
  assert.equal(push(series, NaN, 1), null);
  assert.equal(push(null, 5_000, 1), null);
  feed(series, [1, 2, 3, 4, 5, 6], MIN);               // six candles opened, five closed
  assert.deepEqual(closes(series), [3, 4, 5]);         // only the last three kept
  assert.equal(push(series, 0, 9), null);              // an old tick cannot rewrite history
  assert.deepEqual(closes(series), [3, 4, 5]);
  assert.equal(series.open.c, 6);
});

test('ema is the bias-corrected form: a constant series returns the constant', () => {
  assert.equal(ema([5, 5, 5, 5], 3), 5);
  assert.equal(ema([], 3), null);
  assert.equal(ema([1, 2], 0), null);
  // rising series: the fast EMA sits above the slow one
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.ok(ema(rising, 5) > ema(rising, 20));
});

test('rsi: Wilder smoothing, null until period + 1 closes, 100 / 0 / 50 at the edges', () => {
  assert.equal(rsi([1, 2, 3], 14), null);
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14), 100);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(down, 14), 0);
  const flat = Array.from({ length: 20 }, () => 100);
  assert.equal(rsi(flat, 14), 50);
  // A worked example: 3 up moves of 1 and 3 down moves of 1 over a period of 6
  // is a perfectly balanced RSI of 50; tilt one move and it leaves 50.
  const balanced = [10, 11, 10, 11, 10, 11, 10];
  assert.equal(rsi(balanced, 6), 50);
  assert.ok(rsi([10, 11, 10, 11, 10, 11, 12], 6) > 50);
  assert.ok(rsi([10, 11, 10, 11, 10, 11, 9], 6) < 50);
});

test('bias: not warm until the slow window has closed candles, then follows the EMA order', () => {
  const opts = { fast: 3, slow: 6, rsiPeriod: 14, rsiBlock: 70 };
  const series = createSeries(MIN, 50);
  feed(series, [1, 2, 3, 4], MIN);                     // 3 closed candles: not enough
  let view = bias(series, opts);
  assert.equal(view.warm, false);
  assert.equal(view.dir, null);
  assert.equal(view.candles, 3);
  assert.equal(view.needed, 7);
  feed(series, [5, 6, 7, 8, 9], MIN, 4 * MIN);          // rising: 8 closed candles
  view = bias(series, opts);
  assert.equal(view.warm, true);
  assert.equal(view.dir, 'UP');
  const falling = createSeries(MIN, 50);
  feed(falling, [9, 8, 7, 6, 5, 4, 3, 2, 1], MIN);
  assert.equal(bias(falling, opts).dir, 'DOWN');
  const flat = createSeries(MIN, 50);
  feed(flat, Array.from({ length: 10 }, () => 1), MIN);
  assert.equal(bias(flat, opts).dir, null);            // flat is not a direction
});

test('bias: the RSI gate blocks a buy into overbought and a sell into oversold', () => {
  const opts = { fast: 3, slow: 6, rsiPeriod: 5, rsiBlock: 70 };
  const up = createSeries(MIN, 50);
  feed(up, Array.from({ length: 12 }, (_, i) => 100 + i), MIN);
  let view = bias(up, opts);
  assert.equal(view.rsi, 100);
  assert.equal(view.blockUp, true);
  assert.equal(view.blockDown, false);
  const down = createSeries(MIN, 50);
  feed(down, Array.from({ length: 12 }, (_, i) => 100 - i), MIN);
  view = bias(down, opts);
  assert.equal(view.blockDown, true);
  assert.equal(view.blockUp, false);
  // rsiBlock 0 disables the gate entirely
  view = bias(up, { ...opts, rsiBlock: 0 });
  assert.equal(view.rsi, null);
  assert.equal(view.blockUp, false);
});

test('bias fails closed on junk', () => {
  const view = bias(null, { fast: 3, slow: 6 });
  assert.deepEqual(view, { dir: null, rsi: null, candles: 0, needed: 0, warm: false,
    blockUp: false, blockDown: false });
  const series = createSeries(MIN, 5);
  assert.equal(bias(series, { fast: 6, slow: 3 }).warm, false);   // slow must exceed fast
  assert.equal(bias(series, null).warm, false);
});

test('the backtester replays the same gate the live tradeVeto applies', () => {
  const gate = htfGate();
  // 30 minutes of a falling market at one tick per 10 seconds
  for (let i = 0; i < 180; i += 1) gate.push(i * 10_000, 100 - i * 0.01);
  assert.equal(gate.veto('UP'), 'against candle trend');
  // straight down every candle: the RSI is pinned at 0, so a sell is stretched too
  assert.equal(gate.veto('DOWN'), 'rsi stretched');
  assert.equal(HTF.EMA_SLOW, 21);
});

test('content.js and the manifest load candles.js before content.js', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const isolated = manifest.content_scripts.find((block) => block.world === 'ISOLATED');
  const order = isolated.js;
  assert.ok(order.indexOf('candles.js') !== -1, 'candles.js is not in the manifest');
  assert.ok(order.indexOf('candles.js') < order.indexOf('content.js'), 'candles.js must load before content.js');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.ok(content.includes('NexaCandles.bias('), 'content.js reads the HTF bias from candles.js');
  assert.ok(!content.includes('function rsi('), 'content.js keeps no private RSI copy');
});
