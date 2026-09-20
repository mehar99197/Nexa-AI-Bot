#!/usr/bin/env node
'use strict';
/* DOM smoke harness: boots the real content-script stack (strategy,
   autopilot, horizons, content) inside jsdom against a mock Quotex page with
   a fake bridge and a fake clock, then drives the one-pill UI through:
   boot/storage migration -> chart lock -> clock-node rejection -> Start
   (instant BUY flash) -> virtual settlement -> throttled-tab stale signal ->
   live clicks with the payout-unknown hold and probe -> server confirm ->
   settlement -> expiry cross-check -> run-until-Stop (limit ignored, loss
   streak pauses, unconfirmed pauses, missing button retried) -> daily cap
   -> LIVE-account confirmation and account-switch stop -> pagehide.

   Run with:  npm run smoke   (needs the jsdom devDependency: npm install)
   It is deliberately NOT under test/ so `npm test` stays dependency-free. */
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.error('tools/dom-smoke.js needs jsdom: run `npm install` (it is a devDependency) and retry.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const failures = [];
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures.push(msg); };
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The clock node sits NEARER the buttons than the real duration, on purpose.
const html = `<!doctype html><html><head></head><body>
  <div id="app">
    <div class="header"><span class="title" data-top="10">EUR/USD (OTC)</span></div>
    <div class="watch"><span data-top="300">GBP/USD (OTC)</span><span data-top="320">EUR/USD (OTC)</span></div>
    <div class="panel" data-left="900">
      <input id="amount" data-top="100" data-left="900" value="1">
      <span id="duration" data-top="140" data-left="900">00:05</span>
      <span id="clock" data-top="190" data-left="900">14:35</span>
      <span id="payout" data-top="180" data-left="900">+85%</span>
      <button id="up" data-top="220" data-left="900"><svg class="icon-arrow-up-circle"></svg><span>Up</span></button>
      <button id="down" data-top="260" data-left="900"><svg class="icon-arrow-down-circle"></svg><span>Down</span></button>
    </div>
  </div></body></html>`;

const dom = new JSDOM(html, {
  url: 'https://market-qx.trade/en/demo-trade',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// ---- fake clock + timers -------------------------------------------------
let now = 1_800_000_000_000;
const timers = [];
let timerSeq = 0;
window.Date.now = () => now;
window.setTimeout = (fn, ms, ...args) => { const id = ++timerSeq; timers.push({ id, at: now + (ms || 0), fn, args, every: null }); return id; };
window.setInterval = (fn, ms, ...args) => { const id = ++timerSeq; timers.push({ id, at: now + (ms || 1), fn, args, every: ms || 1 }); return id; };
window.clearTimeout = window.clearInterval = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(now), 16);
const wallClock = () => { const d = new Date(now); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    now = Math.max(now, due.at);
    document.getElementById('clock').textContent = wallClock();   // the mock clock ticks
    if (due.every) due.at = now + due.every; else timers.splice(timers.indexOf(due), 1);
    try { due.fn(...due.args); } catch (error) { failures.push('timer threw: ' + error.stack); console.log('  FAIL  timer threw: ' + error.stack.split('\n').slice(0, 3).join(' | ')); }
  }
  now = target;
  document.getElementById('clock').textContent = wallClock();
}

// ---- layout stubs ----------------------------------------------------------
window.Element.prototype.getBoundingClientRect = function () {
  const top = Number(this.getAttribute('data-top') || this.closest('[data-top]')?.getAttribute('data-top') || 50);
  const left = Number(this.getAttribute('data-left') || this.closest('[data-left]')?.getAttribute('data-left') || 20);
  const width = 80, height = 20;
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top };
};
window.HTMLElement.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect;
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get() { return 132; } });
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get() { return 190; } });
Object.defineProperty(window.HTMLElement.prototype, 'offsetLeft', { get() { return 24; } });
Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', { get() { return 24; } });
window.PointerEvent = window.MouseEvent;

// ---- chrome / fetch stubs --------------------------------------------------
const storage = {};
window.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://abc/' + p, lastError: undefined },
  storage: { local: {
    get(_k, cb) { cb({ ...storage }); },
    set(obj, cb) { Object.assign(storage, obj); cb && cb(); },
    remove(k, cb) { delete storage[k]; cb && cb(); },
  } },
};
window.localStorage.setItem('nexa.autotrade.dryrun', '1');                 // legacy key: lifted, then dropped
window.localStorage.setItem('nexa.autotrade.settings', '{"strategy":"zscore","cooldownSec":600}'); // must NOT override CONFIG
window.localStorage.setItem('nexa.autotrade.scores.X.60', '{"M":"ww"}');   // legacy scoreboard to drop
let cssLoaded = false;
window.fetch = () => Promise.resolve({ ok: true, text: () => { cssLoaded = true; return Promise.resolve(read('style.css')); } });

// ---- bridge capture --------------------------------------------------------
let nonce = null;
window.postMessage = (msg) => { if (msg && msg.kind === 'hello') nonce = msg.nonce; };
function bridge(payload) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { __nexa: true, nonce, ...payload }, origin: window.location.origin, source: window,
  }));
}
const logs = [];
const origLog = console.log;
const strip = (a) => a.filter((x) => typeof x !== 'string' || !/^(%c\[AutoTrade\]|color:)/.test(x)).map(String).join(' ');
window.console = { ...console, log: (...a) => { logs.push(strip(a)); }, debug() {}, warn(...a) { logs.push('WARN ' + strip(a)); }, error(...a) { logs.push('ERROR ' + strip(a)); } };
const seen = (re) => logs.some((l) => re.test(l));
const last = (re) => logs.filter((l) => re.test(l)).pop() || '(none)';
const count = (re) => logs.filter((l) => re.test(l)).length;

(async () => {
  // ---- boot ------------------------------------------------------------------
  for (const f of ['strategy.js', 'autopilot.js', 'horizons.js', 'content.js']) {
    try { window.eval(read(f)); } catch (error) { console.log('  FAIL  ' + f + ' threw at boot: ' + error.stack); failures.push(f); }
  }
  const host = document.querySelector('[data-nexa-host]');
  ok(!!host, 'host div mounted under <html>');
  ok(!host || host.shadowRoot === null, 'shadow root is closed (host.shadowRoot is null)');
  const root = window.__nexaWidgetRoot;
  const dbg = window.__nexaDebug;
  const cfg = dbg.config;
  ok(!!root && !!dbg, 'isolated-world exposes __nexaWidgetRoot and __nexaDebug');
  const widget = root.getElementById('nexa-autotrade-widget');
  ok(!!widget, 'widget node inside the shadow root');
  ok(!document.getElementById('nexa-autotrade-widget'), 'widget id not reachable from the document');
  const pill = widget.querySelector('.nexa-pill');
  const pillText = () => widget.querySelector('.nexa-pill-text').textContent;
  const caption = () => widget.querySelector('.nexa-caption').textContent;
  const flash = root.querySelector('.nexa-flash');
  const state = () => widget.dataset.state;
  ok(!!pill && pillText() === 'TAP TO RUN' && state() === 'idle', 'one pill, reads TAP TO RUN, idle');
  ok(!!widget.querySelector('.nexa-logo svg') && widget.querySelector('.nexa-name').textContent === 'Nexa AI Bot',
     'logo + name rendered');
  ok(!widget.querySelector('.nexa-panel, .nexa-toggle, input, select'), 'no panels, toggles or settings inputs');
  ok(!!flash && flash.hidden, 'BUY/SELL flash exists, hidden');
  ok(nonce !== null, 'hello handshake posted with a nonce');
  await flush(); await flush();
  advance(100);
  ok(cssLoaded, 'style.css fetched into the shadow root');
  ok(dbg.storeReady, 'store ready');
  ok(storage['nexa.autotrade.dryrun'] === undefined && storage['nexa.autotrade.settings'] === undefined,
     'legacy dry-run and settings keys dropped (no UI for them any more)');
  ok(cfg.STRATEGY === 'auto' && cfg.TRADE_COOLDOWN_MS === 60_000, 'stored settings did NOT override CONFIG');
  ok(window.localStorage.getItem('nexa.autotrade.scores.X.60') === null, 'legacy scoreboard removed from page localStorage');
  ok(cfg.DRY_RUN === false && cfg.LIVE_ACCOUNT === 'confirm' && cfg.RUN_UNTIL_STOPPED && cfg.TRADE_ON_START,
     'defaults: live clicks, live account needs confirmation, run until Stop, trade on Start');
  ok(/^DEMO · 0W-0L/.test(caption()), 'caption shows the account badge and record: ' + caption());

  // ---- feed + lock -------------------------------------------------------------
  let price = 1.0800;
  let gbp = 1.2700;
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  function quote(delta = 0) {
    price = +(price * (1 + delta)).toFixed(7);
    gbp = +(gbp * (1 + (rand() - 0.5) * 0.00002)).toFixed(7);
    bridge({ kind: 'quotes', rows: [['EURUSD_otc', now / 1000, price], ['GBPUSD_otc', now / 1000, gbp]] });
  }
  const noise = (n) => { for (let i = 0; i < n; i += 1) { quote((rand() - 0.5) * 0.00002); advance(500); } };
  const trend = (n, perTick) => { for (let i = 0; i < n; i += 1) { quote(perTick); advance(500); } };
  const start = () => { if (!dbg.bot.running) pill.click(); };
  const stop = () => { if (dbg.bot.running) pill.click(); };
  bridge({ kind: 'socket', state: 'open' });
  bridge({ kind: 'balance', live: 0, demo: 10000 });
  pill.click();
  ok(state() === 'error' && pillText() === 'NO FEED', 'Start before quotes: pill says NO FEED');
  advance(4_100);
  ok(pillText() === 'TAP TO RUN', 'refusal reverts to TAP TO RUN after a few seconds');
  noise(12);
  ok(seen(/Locked to chart: EURUSDOTC/), 'locked to the header chart (EURUSDOTC), not the watchlist');

  // ---- Start (dry): instant BUY flash on the first tick --------------------------
  cfg.DRY_RUN = true;
  cfg.KEEP_TRADING_AFTER_SEC = 0;            // the scripted flow relies on model signals only
  trend(20, 0.00004);                        // a mild up-trend in the scanner buffer
  const t0 = now;
  pill.click();
  ok(dbg.bot.running && pillText() === 'RUNNING' && state() === 'running', 'tap -> RUNNING immediately');
  ok(now === t0, 'no time passed');
  ok(seen(/DRY RUN #1 — would click UP .*\(instant entry\)/), 'first trade on the first tick: ' + last(/DRY RUN #1/));
  ok(!flash.hidden && flash.textContent === 'BUY' && flash.dataset.dir === 'UP', 'BUY flash shown for an UP trade');
  ok(/^DEMO dry · 0W-0L/.test(caption()), 'caption: ' + caption());
  advance(3_100);
  ok(flash.hidden, 'flash hides after 3s');
  ok(seen(/Trade panel: payout 85% \| expiry (?!5s)\d+s/), 'the HH:MM clock initially wins as the nearest duration-like node (the trap)');
  noise(260);                                // two minute flips -> detected as a clock
  ok(seen(/moves like a clock/), 'clock node rejected: ' + last(/moves like a clock/));
  ok(dbg.panel.expirySec === 5, 'expiry now read from the real duration node: ' + dbg.panel.expirySec + 's');
  ok(seen(/Horizon 5s/), 'horizon retuned to 5s after the correction');
  // Cooldown follows the expiry: 5s + 5s margin, floored at 10s.
  cfg.STRATEGY = 'momentum';
  trend(30, -0.00004);
  trend(12, 0.00006);
  ok(seen(/DRY RUN #2 — would click UP .*\(momentum crossover\)/), 'model crossover trade: ' + last(/DRY RUN #2/));
  trend(12, 0.00004);
  ok(seen(/WIN \(dry\) UP/), 'dry trade settled virtually as a win: ' + last(/\(dry\)/));
  ok(/1W|2W/.test(caption()), 'caption counts the dry wins: ' + caption());
  ok(storage['nexa.autotrade.daily'] === undefined, 'daily (real) P&L untouched by a dry trade');

  // ---- stale signal: simulate a throttled tab -------------------------------------
  noise(30);
  trend(30, 0.00004);
  const parked = timers.splice(0);
  for (let i = 0; i < 30; i += 1) { now += 500; quote(-0.00006); }
  for (let i = 0; i < 20; i += 1) { now += 500; quote(-0.00002); }
  timers.push(...parked);
  for (const t of timers) t.at = now + 1;
  const dryBeforeStale = count(/^DRY RUN #/);
  advance(5);
  ok(seen(/Skipped \d+ stale signal/), 'stale signals skipped after the throttled gap: ' + last(/Skipped/));
  ok(count(/^DRY RUN #/) === dryBeforeStale, 'no trade was placed on the stale crossover');

  // ---- live clicks: payout unknown -> held, then ONE probe ------------------------
  stop();
  cfg.DRY_RUN = false;
  document.getElementById('payout').textContent = 'n/a';
  noise(130);                                 // sticky payout expires while stopped
  cfg.TRADE_ON_START = false;                 // the probe must not be confused with the instant entry
  start();
  ok(dbg.panel.payoutPct === null, 'payout unknown at start');
  let clicks = 0;
  document.getElementById('up').addEventListener('click', () => { clicks += 1; });
  document.getElementById('down').addEventListener('click', () => { clicks += 1; });
  trend(30, -0.00004);
  trend(6, 0.00006);                          // crossover ~ 18s in: held (20s hold)
  ok((dbg.bot.reasonCounts['held: payout unknown'] || 0) > 0 && clicks === 0, 'held while payout unknown, no click yet');
  noise(20);
  trend(30, -0.00004);
  trend(8, 0.00006);                          // next crossover: past the 20s hold -> probe
  ok(seen(/allowing one probe trade/), 'one probe trade allowed to learn the payout: ' + last(/probe/));
  ok(clicks === 1 && seen(/Clicked UP #1/), 'exactly one probe click');
  const probe = dbg.bot.trades.filter((t) => !t.dry).pop();
  advance(300);
  bridge({ kind: 'trade-open', id: 'p1', asset: 'EURUSD_otc', amount: 1, openPrice: probe.price,
    command: 0, isDemo: true, percentProfit: 82, closeTimestamp: (now + 5_000) / 1000 });
  ok(dbg.panel.payoutPct === 82 && dbg.panel.payoutUnknownSince === 0, 'server payout (82%) adopted from the probe order');
  noise(9);                                   // quotes keep flowing while the verdict timer runs
  ok(seen(/CONFIRMED: UP accepted/), 'probe confirmed inside CONFIRM_MS');
  bridge({ kind: 'trade-close', id: 'p1', asset: 'EURUSD_otc', amount: 1, profit: 0.82,
    openPrice: probe.price, closePrice: probe.price * 1.001, command: 0, isDemo: true });
  noise(2);
  ok(seen(/^WIN UP/) && storage['nexa.autotrade.daily'].pnl === 0.82, 'real win settled and persisted to daily P&L');
  ok(/^DEMO · 1W-0L/.test(caption()), 'caption shows the real win: ' + caption());
  // payout 82% clears MIN_PAYOUT_PCT (70): normal trading continues
  trend(30, -0.00004);
  trend(10, 0.00006);
  ok(clicks === 2, 'trading continues at 82% payout (min 70): clicks=' + clicks);
  const t2 = dbg.bot.trades.filter((t) => !t.dry).pop();
  advance(300);
  bridge({ kind: 'trade-open', id: 'p2', asset: 'EURUSD_otc', amount: 1, openPrice: t2.price,
    command: 0, isDemo: true, percentProfit: 82, closeTimestamp: (now + 60_000) / 1000 });
  ok(seen(/Expiry mismatch: the bot assumed 5s but this contract closes in 6\ds/),
     'expiry mismatch detected from closeTimestamp: ' + last(/Expiry mismatch/));
  ok(dbg.panel.expirySec === null, 'the contradicted duration node was dropped');
  // late settlement after a restart must not leak into the new run
  stop(); start();
  bridge({ kind: 'trade-close', id: 'p2', asset: 'EURUSD_otc', amount: 1, profit: -1,
    openPrice: t2.price, closePrice: t2.price * 0.999, command: 0, isDemo: true });
  ok(seen(/LOSS \(previous run\) UP/), 'late settlement attributed to the previous run');
  ok(dbg.bot.wins === 0 && dbg.bot.losses === 0 && dbg.bot.lossStreak === 0, 'new run counters untouched');
  ok(storage['nexa.autotrade.daily'].pnl === -0.18, 'daily P&L still counts it: ' + storage['nexa.autotrade.daily'].pnl);

  // ---- Run until Stop ----------------------------------------------------------------
  stop();
  cfg.DRY_RUN = true;
  cfg.STRATEGY = 'trend';
  cfg.COOLDOWN_FROM_EXPIRY = false;
  cfg.TRADE_COOLDOWN_MS = 5_000;
  cfg.MAX_TRADES_PER_SESSION = 2;
  cfg.MAX_LOSS_STREAK = 2;
  noise(20);
  const before = count(/^DRY RUN #/);
  start();
  trend(40, -0.00004);                        // 20s: 4 DOWN trades at a 5s cooldown, 60s expiry
  ok(dbg.bot.running && count(/^DRY RUN #/) - before >= 3, 'kept trading past the 2-trade limit (' + (count(/^DRY RUN #/) - before) + ')');
  ok(!seen(/Trade limit reached/), 'no "trade limit" stop');
  trend(130, 0.00003);                        // 65s up: the DOWN trades settle as losses
  ok(seen(/Paused for 5 min — 2 losses in a row/), 'loss streak paused instead of stopping');
  ok(dbg.bot.running && pillText().startsWith('PAUSED') && state() === 'paused', 'pill reads PAUSED with a countdown: ' + pillText());
  ok(dbg.bot.lossStreak === 0, 'streak reset for the resumed run');
  const duringPause = count(/^DRY RUN #/);
  noise(20);
  ok(count(/^DRY RUN #/) === duringPause, 'no trades during the pause');
  noise(600);                                 // 5 minutes of quotes: pause runs out
  trend(12, 0.00004);
  ok(seen(/Pause over/) && count(/^DRY RUN #/) > duringPause && pillText() === 'RUNNING', 'resumed after the pause');

  // keep-trading fallback: momentum mode with no crossover -> trend entry after idle
  stop();
  cfg.STRATEGY = 'momentum';
  cfg.KEEP_TRADING_AFTER_SEC = 10;
  trend(40, 0.00002);
  const kBefore = count(/^DRY RUN #/);
  start();
  trend(30, 0.00002);
  ok(count(/^DRY RUN #.*\(keep trading\)/) >= 1, 'idle model -> keep-trading trend entry: ' + last(/^DRY RUN #/));
  ok(count(/^DRY RUN #/) - kBefore <= 3, 'fallback paced by the idle limit');

  // unconfirmed clicks: live mode, no server order -> pause with backoff, not a stop
  stop();
  cfg.DRY_RUN = false;
  cfg.KEEP_TRADING_AFTER_SEC = 5;
  document.getElementById('payout').textContent = '+85%';
  noise(130);
  start();
  trend(40, 0.00002);
  ok(seen(/Paused for 2 min — clicks not registering/) && dbg.bot.running, 'two unconfirmed clicks paused (not stopped)');
  ok(pillText().startsWith('PAUSED'), 'pill: ' + pillText());
  noise(250);                                 // pause runs out with quotes flowing
  ok(seen(/Pause over \(clicks not registering\)/), 'unconfirmed pause ended');

  // missing button: retried, never fatal (dry mode so the payout gate does not mask it)
  stop();
  cfg.DRY_RUN = true;
  const upBtn = document.getElementById('up');
  const upParent = upBtn.parentNode;
  noise(20);
  start();
  trend(12, 0.00002);
  upParent.removeChild(upBtn);
  trend(20, 0.00002);
  ok(dbg.bot.running && seen(/retrying every tick/), 'missing button retried, run alive: ' + last(/Could not resolve/));
  ok(/button not found — retrying/.test(pill.title), 'tooltip says so');
  upParent.appendChild(upBtn);
  trend(12, 0.00002);
  ok(seen(/button is back after/), 'button recovery noticed');

  // the ONE thing that still stops it: the daily loss cap
  stop();
  cfg.DRY_RUN = false;
  cfg.DAILY_LOSS_CAP = 1;
  noise(130);
  start();
  trend(20, 0.00002);
  const capTrade = dbg.bot.trades.filter((t) => !t.dry && !t.orderId).pop();
  if (capTrade) {
    bridge({ kind: 'trade-open', id: 'cap1', asset: 'EURUSD_otc', amount: 1, openPrice: capTrade.price,
      command: capTrade.expectedCommand, isDemo: true, percentProfit: 85, closeTimestamp: (now + 5_000) / 1000 });
    bridge({ kind: 'trade-close', id: 'cap1', asset: 'EURUSD_otc', amount: 1, profit: -1,
      openPrice: capTrade.price, closePrice: capTrade.price * 0.999, command: capTrade.expectedCommand, isDemo: true });
  }
  ok(!!capTrade && !dbg.bot.running && pillText() === 'DAILY CAP', 'daily loss cap stops the run: ' + pillText());
  cfg.DAILY_LOSS_CAP = 0;
  advance(4_100);
  ok(pillText() === 'TAP TO RUN', 'pill back to TAP TO RUN');

  // ---- LIVE account: confirm with a second tap; a switch mid-run stops ------------
  dom.reconfigure({ url: 'https://market-qx.trade/en/trade' });
  noise(3);                                   // quotes keep flowing throughout (a stale feed refuses to start)
  ok(/^LIVE · /.test(caption()), 'caption badge follows the route: ' + caption());
  pill.click();
  ok(!dbg.bot.running && pillText() === 'LIVE? TAP AGAIN' && state() === 'confirm', 'first tap on LIVE asks for confirmation');
  ok(/real money/.test(caption()), 'caption explains: ' + caption());
  noise(14);                                  // 7s: the confirmation window closes
  ok(pillText() === 'TAP TO RUN' && !dbg.liveConfirmed, 'no second tap within 6s -> back to TAP TO RUN, not confirmed');
  pill.click();
  noise(2);
  pill.click();
  ok(dbg.bot.running && dbg.liveConfirmed && dbg.bot.account === 'live', 'second tap within the window starts on LIVE');
  ok(/^LIVE · /.test(caption()), 'caption: ' + caption());
  // real money: the account is re-read before every click — switch to demo mid-run
  dom.reconfigure({ url: 'https://market-qx.trade/en/demo-trade' });
  cfg.KEEP_TRADING_AFTER_SEC = 5;
  trend(13, 0.00002);                         // the keep-trading attempt at ~5s re-reads the route
  ok(!dbg.bot.running && seen(/account changed from live to demo/), 'account switch mid-run stops the run: ' + last(/BLOCKED/));
  ok(pillText() === 'ACCOUNT?', 'pill: ' + pillText());
  // LIVE_ACCOUNT 'never' refuses
  dom.reconfigure({ url: 'https://market-qx.trade/en/trade' });
  cfg.LIVE_ACCOUNT = 'never';
  noise(9);
  pill.click();
  ok(!dbg.bot.running && pillText() === 'LIVE BLOCKED', 'LIVE_ACCOUNT=never refuses the live route');
  cfg.LIVE_ACCOUNT = 'confirm';

  // ---- pagehide ----------------------------------------------------------------------
  dom.reconfigure({ url: 'https://market-qx.trade/en/demo-trade' });
  noise(9);
  start();
  ok(dbg.bot.running, 'running again on demo');
  window.dispatchEvent(new window.Event('pagehide'));
  ok(!dbg.bot.running && pillText() === 'TAP TO RUN', 'pagehide stops the bot');

  // ---- report -----------------------------------------------------------------
  const errors = logs.filter((l) => /^ERROR/.test(l));
  ok(errors.length === 0, 'no console.error during the run' + (errors.length ? ': ' + errors.join(' | ') : ''));
  origLog('\n' + (failures.length ? failures.length + ' FAILED' : 'ALL PASSED'));
  if (failures.length || process.argv.includes('--verbose')) { origLog('\n--- log tail ---'); origLog(logs.slice(-45).join('\n')); }
  process.exit(failures.length ? 1 : 0);
})();
