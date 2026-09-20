/* inject.js runs in the page's MAIN world and had no tests at all. It is
   driven here with a fake window + WebSocket: the handshake, quote batching,
   binary placeholder frames, and — the part that used to be wrong — which
   socket's frames are believed. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8');
const ORIGIN = 'https://x.test';

class FakeWS {
  static get CONNECTING() { return 0; }
  static get OPEN() { return 1; }
  static get CLOSING() { return 2; }
  static get CLOSED() { return 3; }
  constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event || {}); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close'); }
  text(frame) { this.emit('message', { data: frame }); }
  binary(bytes) { this.emit('message', { data: Uint8Array.from(bytes).buffer }); }
}

/** Boot inject.js against a fake window; returns the patched WebSocket and
    the messages it posted (after the hello handshake). */
function boot() {
  const posted = [];
  const window = {
    WebSocket: FakeWS,
    location: { origin: ORIGIN, href: ORIGIN + '/en/demo-trade' },
    listeners: [],
    addEventListener(type, fn) { this.listeners.push(fn); },
    postMessage(message) { posted.push(message); },
  };
  const run = new Function('window', 'TextDecoder', 'Blob', 'console', SOURCE);
  run(window, TextDecoder, class Blob {}, { debug() {}, error() {} });
  const nonce = 'n'.repeat(40);
  for (const fn of window.listeners) {
    fn({ source: window, origin: ORIGIN, data: { __nexa: true, kind: 'hello', nonce } });
  }
  const summary = (message) => {
    if (message.kind === 'quotes') return 'quotes(' + message.rows.map((r) => r[0]).join(',') + ')';
    if (message.kind === 'socket') return 'socket:' + message.state;
    if (message.kind === 'balance') return 'balance:' + message.live + '/' + message.demo;
    return message.kind;
  };
  return { WS: window.WebSocket, window, posted, log: () => posted.map(summary) };
}

const FEED_URL = 'wss://ws2.x.test/socket.io/?EIO=3&transport=websocket';

test('the WebSocket proxy keeps native statics and marks the window without a string global', () => {
  const { WS, window } = boot();
  assert.equal(WS.OPEN, 1);
  assert.equal(Object.keys(window).includes('__nexaWsHooked'), false);
  assert.equal(window[Symbol.for('nexa.ws.hooked')], true);
});

test('a quotes/stream frame is forwarded as one batch, bad rows dropped', () => {
  const { WS, log, posted } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  feed.text('42["quotes/stream",[["EURUSD_otc",1726700000.1,1.0834],["bad"],["GBPUSD_otc",1726700000.1,1.27]]]');
  assert.deepEqual(log(), ['socket:open', 'quotes(EURUSD_otc,GBPUSD_otc)']);
  assert.deepEqual(posted[1].rows[0], ['EURUSD_otc', 1726700000.1, 1.0834]);
});

test('a later socket.io connection that never carries quotes cannot steal the feed', () => {
  const { WS, log } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  feed.text('42["quotes/stream",[["EURUSD_otc",1,1.08]]]');
  const chat = new WS('wss://chat.x.test/socket.io/?EIO=3');   // opened later
  chat.open();
  chat.text('42["s_balance",{"balance":999,"isDemo":1}]');    // must be ignored
  feed.text('42["quotes/stream",[["EURUSD_otc",2,1.09]]]');
  assert.deepEqual(log(), ['socket:open', 'quotes(EURUSD_otc)', 'quotes(EURUSD_otc)']);
});

test('a reconnect is adopted once the old socket closes, and the stale one stays dead', () => {
  const { WS, log } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  feed.text('42["quotes/stream",[["EURUSD_otc",1,1.08]]]');
  feed.close();
  const feed2 = new WS(FEED_URL);
  feed2.open();
  feed2.text('42["quotes/stream",[["EURUSD_otc",2,1.09]]]');
  feed.text('42["quotes/stream",[["STALE",3,1]]]');           // buffered frame from the dead socket
  assert.deepEqual(log(), [
    'socket:open', 'quotes(EURUSD_otc)', 'socket:closed', 'socket:open', 'quotes(EURUSD_otc)',
  ]);
});

test('a newer socket delivering quotes supersedes a still-open older one', () => {
  const { WS, log } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  feed.text('42["quotes/stream",[["EURUSD_otc",1,1.08]]]');
  const feed2 = new WS(FEED_URL);                              // reconnect before the old one closed
  feed2.open();                                                // not adopted yet: old is OPEN
  feed2.text('42["quotes/stream",[["EURUSD_otc",2,1.09]]]');  // quotes + newer -> adopted
  feed.text('42["quotes/stream",[["OLD",3,1]]]');              // old one is now ignored
  assert.deepEqual(log(), ['socket:open', 'quotes(EURUSD_otc)', 'socket:open', 'quotes(EURUSD_otc)']);
});

test('binary placeholder frames route single-attachment events and skip multi-attachment ones', () => {
  const { WS, posted } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  const order = JSON.stringify({ id: 'abc', asset: 'EURUSD_otc', amount: 1, openPrice: 1.08,
    command: 0, isDemo: 1, percentProfit: 85, closeTimestamp: 1726700060 });
  feed.text('451-["s_orders/open",{"_placeholder":true,"num":0}]');
  feed.binary([4, ...Buffer.from(order)]);                     // engine.io type byte + JSON
  const open = posted.find((m) => m.kind === 'trade-open');
  assert.ok(open, 'expected a trade-open');
  assert.equal(open.isDemo, true);                             // numeric 1 -> boolean
  assert.equal(open.percentProfit, 85);
  assert.equal(open.closeTimestamp, 1726700060);
  const before = posted.length;
  feed.text('452-["s_orders/open",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]');
  feed.binary([4, ...Buffer.from(order)]);
  feed.binary([4, ...Buffer.from(order)]);
  assert.equal(posted.length, before, 'a 2-attachment event must be consumed, not routed');
});

test('balance list forwards whichever figure is present and remembers the other', () => {
  const { WS, log } = boot();
  const feed = new WS(FEED_URL);
  feed.open();
  feed.text('42["s_balance/list",{"demoBalance":10000}]');
  feed.text('42["s_balance/list",{"liveBalance":12.5}]');
  feed.text('42["s_balance",{"balance":9950,"isDemo":1}]');
  assert.deepEqual(log().slice(1), ['balance:null/10000', 'balance:12.5/10000', 'balance:12.5/9950']);
});
