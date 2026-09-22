#!/usr/bin/env node
'use strict';
/* DOM smoke harness: boots the real content-script stack (strategy,
   autopilot, horizons, candles, settings, content) inside jsdom against a mock Quotex page with
   a fake bridge and a fake clock, then drives the one-pill UI through:
   boot/storage migration -> chart lock -> clock-node rejection -> Start
   (instant BUY flash) -> virtual settlement -> throttled-tab stale signal ->
   live clicks with the payout-unknown hold and probe -> server confirm ->
   settlement -> expiry cross-check -> run-until-Stop (limit ignored, loss
   streak pauses, unconfirmed pauses, missing button retried) -> daily cap
   -> daily profit target + kelly floor -> LIVE-account confirmation and
   account-switch stop -> HTF candle filter (held against the candle trend,
   allowed with it) -> pagehide -> click event order + Android native tap
   and stake typing + the humanized gesture (mouse path, held press, typed
   stake, finger tap) -> platform alarm (captcha, notice) -> timing profile.
   A signal let go on purpose (SKIP_SIGNAL_PCT) sits in the run-until-Stop
   section; the human stake ladder is checked with the kelly floor.

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
      <input id="amount" data-top="100" data-left="900" value="2">
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
const storageListeners = [];
const messageListeners = [];
window.chrome = {
  runtime: {
    getURL: (p) => 'chrome-extension://abc/' + p, lastError: undefined,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
  },
  storage: {
    local: {
      get(_k, cb) { cb({ ...storage }); },
      set(obj, cb) { Object.assign(storage, obj); cb && cb(); },
      remove(k, cb) { delete storage[k]; cb && cb(); },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
};
// What the popup does: write the prefs key, and the content script hears about it.
const popupWrites = (value) => {
  if (value === undefined) delete storage['nexa.autotrade.prefs']; else storage['nexa.autotrade.prefs'] = value;
  for (const fn of storageListeners) fn({ 'nexa.autotrade.prefs': { newValue: value } }, 'local');
};
const popupAsks = (type) => { let reply = null; for (const fn of messageListeners) fn({ type }, {}, (r) => { reply = r; }); return reply; };
// Saved prefs from a previous session: one valid override, one junk value.
storage['nexa.autotrade.prefs'] = { MIN_PAYOUT_PCT: 65, STAKE_MODE: 'bogus' };
// A neutral timing profile, so the scripted flows keep their timings; its own scenario draws a fresh one.
const NEUTRAL_PROFILE = { v: 1, created: 1, reaction: 1, jitter: 1, session: 1, rest: 1, skip: 1, sticky: 1, move: 1, aimX: 0, aimY: 0 };
storage['nexa.autotrade.profile'] = { ...NEUTRAL_PROFILE };
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
  for (const f of ['strategy.js', 'autopilot.js', 'horizons.js', 'candles.js', 'settings.js', 'content.js']) {
    try { window.eval(read(f)); } catch (error) { console.log('  FAIL  ' + f + ' threw at boot: ' + error.stack); failures.push(f); }
  }
  const host = document.querySelector('[data-nexa-host]');
  ok(!!host, 'host div mounted under <html>');
  ok(!host || host.shadowRoot === null, 'shadow root is closed (host.shadowRoot is null)');
  const root = window.__nexaWidgetRoot;
  const dbg = window.__nexaDebug;
  const cfg = dbg.config;
  ok(!!root && !!dbg, 'isolated-world exposes __nexaWidgetRoot and __nexaDebug');
  ok(!Object.keys(window).some((k) => /^__nexa/.test(k)) && window.__nexaBotLoaded === true,
     'the bot globals are reachable by name but do not enumerate on window (the Android app shares it with the page)');
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
  ok(cfg.STAKE_MODE === 'kelly' && cfg.DAILY_LOSS_CAP_PCT === 10 && cfg.DAILY_PROFIT_TARGET_PCT === 20 &&
     cfg.HTF_FILTER === true && cfg.RECORD_TICKS === false,
     'defaults: kelly stake, 10% daily cap, 20% daily target, candle filter on, recorder off');
  ok(cfg.MIN_PAYOUT_PCT === 65 && cfg.STAKE_MODE === 'kelly' && seen(/ignored invalid value\(s\) for STAKE_MODE/),
     'saved prefs applied at boot: valid override taken, junk value ignored');
  popupWrites({ MIN_PAYOUT_PCT: 60, HTF_FILTER: false, RECORD_TICKS: true });
  ok(cfg.MIN_PAYOUT_PCT === 60 && cfg.HTF_FILTER === false && dbg.recorder.enabled === true,
     'a popup change applies live: ' + last(/Settings \(popup\)/));
  popupWrites(undefined);
  ok(cfg.MIN_PAYOUT_PCT === 70 && cfg.HTF_FILTER === true && dbg.recorder.enabled === false,
     'removing the prefs restores every default');
  cfg.HTF_FILTER = false;                     // the scripted flows below drive short-trend entries; see the HTF scenario
  cfg.SKIP_SIGNAL_PCT = 0;                    // the random miss would make the flows below non-deterministic; see its own scenario
  cfg.HUMAN_CLICK = false;                    // the gesture's 0.5-2 s would too; see its own scenario (instant clicks here)
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
  const snap = popupAsks('nexa:status');
  ok(snap && snap.running === false && snap.account === 'demo' && snap.balance === 10000 &&
     snap.symbol === 'EURUSD_otc' && snap.pill === 'TAP TO RUN' && snap.daily.pnl === 0 && snap.recorder.enabled === false,
     'popup status snapshot: ' + JSON.stringify(snap));

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
  ok(/no real click|DEMO dry · 0W-0L/.test(caption()), 'caption shows the dry-run notice: ' + caption());
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
  ok(/UP placed|DEMO · 1W-0L/.test(caption()), 'caption shows the confirm notice or the win: ' + caption());
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

  // a signal let go on purpose (SKIP_SIGNAL_PCT): no click, one cooldown of rest, the caption says why
  cfg.SKIP_SIGNAL_PCT = 100;
  const keepAfter = cfg.KEEP_TRADING_AFTER_SEC;
  cfg.KEEP_TRADING_AFTER_SEC = 0;             // the idle fallback is not a signal and is never skipped — keep it out of this count
  noise(30);                                  // past the cooldown (+ jitter) of the last trade
  const skipBefore = count(/^DRY RUN #/);
  trend(40, 0.00004);                         // 20s of trend: several signals, every one let go
  ok(seen(/let go on purpose \(SKIP_SIGNAL_PCT 100%\)/) && count(/^DRY RUN #/) === skipBefore,
     'signal skipped on purpose, no trade: ' + last(/let go on purpose/));
  // The rest after a miss is one cooldown plus random jitter, so by the last
  // tick it may already be over (and the next signal let go again): the
  // histogram, not the final caption, is what proves the reason was shown.
  ok((dbg.bot.reasonCounts['held: missed on purpose'] || 0) > 0,
     'the miss shows as the held reason: ' + JSON.stringify(dbg.bot.reasonCounts['held: missed on purpose']) + ' tick(s)');
  cfg.SKIP_SIGNAL_PCT = 0;
  cfg.KEEP_TRADING_AFTER_SEC = keepAfter;

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

  // ---- the other daily rail: the profit target, per account, on the day's base balance
  const daily = () => storage['nexa.autotrade.daily'];
  ok(daily().start.demo === 10000 && daily().acct.demo === daily().pnl && daily().acct.live === undefined,
     'daily record pins the demo base balance and keeps a per-account P&L: ' + JSON.stringify(daily()));
  ok(seen(/Stake set to \$1 \(kelly\)/), 'kelly sizing rides the minimum while nothing is proven: ' + last(/Stake set/));
  ok(count(/Stake set to/) === 1 && document.getElementById('amount').value === '1',
     'the amount field was written once ($2 -> $1) and never retyped with the same figure: ' + count(/Stake set to/) + ' write(s)');
  cfg.DAILY_PROFIT_TARGET_PCT = 0.05;         // $5 on the $10,000 base
  noise(20);
  start();
  ok(dbg.bot.running, 'the loss-capped day restarts once the dollar cap is lifted (10% cap not reached)');
  trend(20, 0.00002);
  const tgtTrade = dbg.bot.trades.filter((t) => !t.dry && !t.orderId).pop();
  if (tgtTrade) {
    bridge({ kind: 'trade-open', id: 'tgt1', asset: 'EURUSD_otc', amount: 1, openPrice: tgtTrade.price,
      command: tgtTrade.expectedCommand, isDemo: true, percentProfit: 85, closeTimestamp: (now + 5_000) / 1000 });
    bridge({ kind: 'trade-close', id: 'tgt1', asset: 'EURUSD_otc', amount: 1, profit: 8,
      openPrice: tgtTrade.price, closePrice: tgtTrade.price * 1.001, command: tgtTrade.expectedCommand, isDemo: true });
  }
  ok(!!tgtTrade && !dbg.bot.running && pillText() === 'TARGET HIT', 'daily profit target stops the run: ' + pillText());
  ok(daily().acct.demo >= 5, 'demo day banked: ' + daily().acct.demo);
  pill.click();
  ok(!dbg.bot.running && seen(/daily profit target already reached/), 'refuses to restart for the rest of the day');
  cfg.DAILY_PROFIT_TARGET_PCT = 0;
  advance(4_100);
  ok(pillText() === 'TAP TO RUN', 'pill back to TAP TO RUN after the target refusal');

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

  // ---- HTF filter: the candle trend outranks a 2-minute signal ---------------------
  dom.reconfigure({ url: 'https://market-qx.trade/en/demo-trade' });
  cfg.HTF_FILTER = true;
  cfg.DRY_RUN = true;
  cfg.STRATEGY = 'trend';
  cfg.KEEP_TRADING_AFTER_SEC = 0;
  cfg.TRADE_ON_START = true;
  // ~27 minutes of a stair-stepping decline — 1.5 min down, 1.5 min up, net
  // down — so the 1m candles trend DOWN without the RSI reaching the
  // oversold gate.
  for (let i = 0; i < 9; i += 1) { trend(180, -0.000006); trend(180, 0.000004); }
  const htf = dbg.htf();
  ok(htf.warm && htf.dir === 'DOWN' && htf.rsi > 30 && htf.rsi < 50,
     'candles warm, trend DOWN, RSI moderate: ' + JSON.stringify(htf));
  const htfBefore = count(/^DRY RUN #/);
  start();                                    // the up-leg just ended: the short trend says UP
  ok(dbg.bot.running && count(/^DRY RUN #/) === htfBefore, 'instant UP entry held against the candle trend');
  ok((dbg.bot.reasonCounts['held: against candle trend'] || 0) > 0,
     'reason recorded: ' + JSON.stringify(dbg.bot.reasonCounts));
  ok(/1m ↓ rsi \d+/.test(pill.title), 'status carries the candle context: ' + pill.title);
  trend(40, -0.000006);                       // the short trend turns DOWN, with the candles
  ok(count(/^DRY RUN #/) > htfBefore && /would click DOWN/.test(last(/^DRY RUN #/)),
     'DOWN entry with the candle trend goes through: ' + last(/^DRY RUN #/));
  stop();
  cfg.HTF_FILTER = false;
  cfg.DRY_RUN = false;

  // ---- popup commands ------------------------------------------------------------------
  noise(9);
  ok(popupAsks('nexa:start').running === true && dbg.bot.running, 'popup Start starts the bot');
  ok(popupAsks('nexa:status').pill === 'RUNNING', 'popup sees RUNNING');
  ok(popupAsks('nexa:stop').running === false && !dbg.bot.running, 'popup Stop stops the bot');
  ok(popupAsks('nexa:export-trades').ok === true, 'popup export command acknowledged');
  {
    const reply = popupAsks('nexa:log');
    const tail = reply && reply.lines ? reply.lines : [];
    ok(tail.length > 0 && tail.length <= 300 && tail.every((l) => typeof l.n === 'number' && typeof l.t === 'number' && typeof l.text === 'string') &&
       tail[tail.length - 1].n > tail[0].n,
       'popup can fetch the log tail: ' + tail.length + ' lines, oldest first');
    ok(/^Environment: UA ".+" \| platform .* \| client hints .+ \| screen \d+x\d+ @[\d.]+ \| touch points \d+ \| GPU .+ \| running in the Chrome extension$/.test(reply.environment) &&
       tail.some((l) => l.text === reply.environment),
       'the environment line (what the site sees) heads the log: ' + reply.environment);
    ok(/^Identity check: consistent — the UA, client hints, platform, touch points and GPU all describe the same .+ \(nothing is spoofed\)\.$/.test(reply.identity) &&
       tail.some((l) => l.text === reply.identity),
       'the identity cross-check rides with it and agrees: ' + reply.identity);
    ok(popupAsks('nexa:export-log').ok === true && seen(/Exported \d+ log lines|Log export failed/), 'popup log export acknowledged');
  }

  // ---- the identity cross-check: real values agree; a faked one is named ----------
  {
    const nav = window.navigator;
    const swap = (name, value) => {
      const had = Object.getOwnPropertyDescriptor(nav, name);
      Object.defineProperty(nav, name, { value, configurable: true });
      return () => { if (had) Object.defineProperty(nav, name, had); else delete nav[name]; };
    };
    // jsdom's own UA/platform: whatever they are, they must not contradict each other.
    ok(dbg.identityCheck().problems.length === 0, 'untouched environment: no contradictions');

    // The exact mismatch the phone log once showed: a desktop Linux UA over
    // Android client hints, which is what spoofing the UA alone produces.
    let undo = [
      swap('userAgent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'),
      swap('platform', 'Linux x86_64'),
      swap('userAgentData', { mobile: true, platform: 'Android', brands: [{ brand: 'Chromium', version: '138' }] }),
    ];
    let found = dbg.identityCheck().problems;
    ok(found.length === 2 && found.some((m) => /client hints say platform "Android"/.test(m)) &&
       found.some((m) => /mobile=true but the UA has no "Mobile" token/.test(m)) &&
       /^Identity check: MISMATCH \(2\)/.test(dbg.identityLine()),
       'UA-only spoofing is caught: ' + found.join(' | '));

    // A phone UA whose client hints and touch agree: consistent, even though
    // it is a phone rather than a PC — the check is about agreement, not kind.
    for (const fn of undo) fn();
    undo = [
      swap('userAgent', 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36'),
      swap('platform', 'Linux armv8l'),
      swap('maxTouchPoints', 5),
      swap('userAgentData', { mobile: true, platform: 'Android', brands: [{ brand: 'Chromium', version: '138' }] }),
    ];
    ok(dbg.identityCheck().problems.length === 0 && /same Android phone/.test(dbg.identityLine()),
       'a real Android phone reads as consistent: ' + dbg.identityLine());

    // A phone that claims no touch, and a Chrome version the hints disagree with.
    for (const fn of undo) fn();
    undo = [
      swap('userAgent', 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36'),
      swap('platform', 'Linux armv8l'),
      swap('maxTouchPoints', 0),
      swap('userAgentData', { mobile: true, platform: 'Android', brands: [{ brand: 'Chromium', version: '120' }] }),
    ];
    found = dbg.identityCheck().problems;
    ok(found.length === 2 && found.some((m) => /an Android UA with no touch points/.test(m)) &&
       found.some((m) => /Chrome 138 but the client hints say Chromium 120/.test(m)),
       'a touchless phone and a version disagreement are both named: ' + found.join(' | '));
    // A real Windows laptop running the extension (a touchscreen model, so
    // 10 touch points on a desktop — normal, not a contradiction).
    for (const fn of undo) fn();
    undo = [
      swap('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'),
      swap('platform', 'Win32'),
      swap('maxTouchPoints', 10),
      swap('userAgentData', { mobile: false, platform: 'Windows', brands: [
        { brand: 'Google Chrome', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }] }),
    ];
    ok(dbg.identityCheck().problems.length === 0 && /same Windows desktop/.test(dbg.identityLine()),
       'a real Windows laptop (touchscreen) reads as consistent: ' + dbg.identityLine());

    // An Android emulator (BlueStacks): the UA claims a Galaxy S22 Ultra and
    // the GPU an Adreno 650, but navigator.platform leaks x86 — a phone is ARM.
    for (const fn of undo) fn();
    undo = [
      swap('userAgent', 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'),
      swap('platform', 'Linux i686'),
      swap('maxTouchPoints', 5),
      swap('userAgentData', { mobile: false, platform: 'Android', brands: [{ brand: 'Android WebView', version: '129' }] }),
    ];
    found = dbg.identityCheck().problems;
    ok(found.length === 1 && /navigator\.platform is "Linux i686" \(x86\)/.test(found[0]) &&
       /emulator or an x86 Android build/.test(found[0]),
       'an x86 platform under an Android UA is caught as an emulator: ' + found[0]);
    // The same UA on real ARM hardware: an Android tablet, and never called a
    // "desktop" just because the UA carries no "Mobile" token.
    for (const fn of undo) fn();
    undo = [
      swap('userAgent', 'Mozilla/5.0 (Linux; Android 13; SM-X900) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'),
      swap('platform', 'Linux aarch64'),
      swap('maxTouchPoints', 5),
      swap('userAgentData', { mobile: false, platform: 'Android', brands: [{ brand: 'Chromium', version: '129' }] }),
    ];
    ok(dbg.identityCheck().problems.length === 0 && /same Android tablet/.test(dbg.identityLine()) &&
       !/desktop/.test(dbg.identityLine()),
       'an ARM Android without the "Mobile" token is a tablet, never a desktop: ' + dbg.identityLine());

    for (const fn of undo) fn();
    ok(dbg.identityCheck().problems.length === 0, 'restored: no contradictions again');
  }

  // ---- pagehide ----------------------------------------------------------------------
  noise(9);
  start();
  ok(dbg.bot.running, 'running again on demo');
  window.dispatchEvent(new window.Event('pagehide'));
  ok(!dbg.bot.running && pillText() === 'TAP TO RUN', 'pagehide stops the bot');

  // ---- the popup: its own document, its own chrome stub -----------------------------
  // popup.html + settings.js + popup.js in a second jsdom, driven the way a
  // person would: the form is generated from the schema, every change saves
  // only the overrides, a bad number turns red and is not saved, Reset
  // clears the key, and the status card renders what the content script
  // reports (or says there is no page).
  {
    const pstore = { 'nexa.autotrade.prefs': { STRATEGY: 'trend' } };
    const sent = [];
    let snapshot = { running: true, state: 'running', pill: 'RUNNING', account: 'demo', balance: 9876.5,
      dry: false, symbol: 'EURUSD_otc', price: 1.08, wins: 3, losses: 1, pnl: 1.64, trades: 4,
      why: 'no cross', htf: '1m ↑ rsi 58', qualified: null,
      daily: { pnl: 6.82, start: 10000, cap: 1000, target: 2000 },
      recorder: { enabled: true, rows: 1234, open: true } };
    const pdom = new JSDOM(read('popup.html'), { url: 'chrome-extension://abc/popup.html', runScripts: 'outside-only' });
    const pwin = pdom.window;
    const pdoc = pwin.document;
    pwin.chrome = {
      runtime: { getManifest: () => ({ version: '9.9.9' }) },
      storage: { local: {
        get: (key) => Promise.resolve(key in pstore ? { [key]: pstore[key] } : {}),
        set: (obj) => { Object.assign(pstore, obj); return Promise.resolve(); },
        remove: (key) => { delete pstore[key]; return Promise.resolve(); },
      } },
      tabs: {
        query: () => Promise.resolve([{ id: 7 }]),
        sendMessage: (_id, msg) => {
          sent.push(msg.type);
          if (snapshot === null) return Promise.reject(new Error('no receiver'));
          if (msg.type === 'nexa:log') {
            return Promise.resolve({ environment: 'Environment: UA "Mozilla/5.0 (X11; Linux x86_64) Chrome/128" | platform Linux x86_64',
              identity: 'Identity check: MISMATCH (1) — the UA says Linux but the client hints say platform "Android".',
              lines: [{ n: 1, t: 1_800_000_000_000, text: 'Loaded. Tap the pill to start.' },
                      { n: 2, t: 1_800_000_005_000, text: 'Clicked UP #1 at 1.08 — awaiting confirmation' },
                      { n: 3, t: 1_800_000_009_000, text: 'PLATFORM ALARM: captcha / human check on the page.' }] });
          }
          return Promise.resolve(snapshot);
        },
      },
    };
    for (const f of ['settings.js', 'popup.js']) {
      try { pwin.eval(read(f)); } catch (error) { console.log('  FAIL  popup: ' + f + ' threw: ' + error.stack); failures.push('popup ' + f); }
    }
    const settle = async () => { for (let i = 0; i < 6; i += 1) await flush(); };
    await settle();
    const S = pwin.NexaSettings;
    const field = (key) => pdoc.querySelector('.field[data-key="' + key + '"]');
    const input = (key) => pdoc.querySelector('[name="' + key + '"]');
    ok(pdoc.querySelectorAll('.field').length === S.SCHEMA.length && pdoc.querySelectorAll('fieldset').length === S.GROUPS.length,
       'popup: one control per schema key, one fieldset per group');
    ok(pdoc.getElementById('version').textContent === 'v9.9.9', 'popup: version from the manifest');
    ok(input('STRATEGY').value === 'trend' && field('STRATEGY').classList.contains('changed') &&
       input('STAKE_MODE').value === 'kelly' && !field('STAKE_MODE').classList.contains('changed'),
       'popup: stored override shown and marked, defaults unmarked');
    const txt = (id) => pdoc.getElementById(id).textContent;
    ok(txt('pill') === 'RUNNING' && pdoc.getElementById('status').dataset.state === 'running' &&
       txt('toggle') === 'Stop bot' && !pdoc.getElementById('toggle').disabled,
       'popup: hero card renders the snapshot: ' + txt('pill') + ' / ' + txt('toggle'));
    ok(txt('account') === 'DEMO' && pdoc.getElementById('account').dataset.account === 'demo' &&
       txt('balance') === '$9,876.50' && txt('balance-label') === 'Demo balance' && /EURUSD_otc · 1\.08/.test(txt('symbol')),
       'popup: badge, hero balance and chart line: ' + [txt('account'), txt('balance'), txt('symbol')].join(' | '));
    ok(txt('session') === '3W-1L' && /\+\$1\.64 · 4 trades/.test(txt('session-sub')) &&
       txt('today') === '+$6.82' && /cap −\$1,000 · target \+\$2,000/.test(txt('today-sub')) &&
       txt('why') === 'no cross' && txt('htf') === '1m ↑ rsi 58' && txt('auto') === 'trend' && txt('auto-sub') === 'fixed model',
       'popup: session, today, signal and auto tiles: ' + ['session', 'session-sub', 'today', 'today-sub', 'why', 'htf', 'auto'].map(txt).join(' | '));
    ok(txt('cap-text') === '$0 / $1,000' && txt('target-text') === '$7 / $2,000' &&
       pdoc.getElementById('target-fill').style.width === '0.3%' && parseFloat(pdoc.getElementById('cap-fill').style.width) === 0,
       'popup: the daily rails measure today against the limits: ' + txt('cap-text') + ' | ' + txt('target-text'));
    ok(pdoc.getElementById('signal-only').getAttribute('aria-pressed') === 'false' && pdoc.getElementById('nav-trade').hidden &&
       !pdoc.getElementById('view-bot').hidden && pdoc.getElementById('view-settings').hidden,
       'popup: Signal-only quick toggle off, no Trade tab outside the app, Bot view first');
    ok(/Recorder on · 1,234 ticks/.test(pdoc.getElementById('recorder').textContent) && !pdoc.getElementById('export-ticks').disabled,
       'popup: recorder line and export button: ' + pdoc.getElementById('recorder').textContent);
    // a change saves only the overrides
    input('MIN_PAYOUT_PCT').value = '75';
    input('MIN_PAYOUT_PCT').dispatchEvent(new pwin.Event('change', { bubbles: true }));
    await settle();
    ok(JSON.stringify(pstore['nexa.autotrade.prefs']) === JSON.stringify({ STRATEGY: 'trend', MIN_PAYOUT_PCT: 75 }),
       'popup: a change stores only the overrides: ' + JSON.stringify(pstore['nexa.autotrade.prefs']));
    // an out-of-range number is flagged and not stored; the previous value stays
    input('KELLY_FRACTION').value = '5';
    input('KELLY_FRACTION').dispatchEvent(new pwin.Event('input', { bubbles: true }));
    await settle();
    ok(field('KELLY_FRACTION').classList.contains('invalid') && pstore['nexa.autotrade.prefs'].KELLY_FRACTION === undefined,
       'popup: out-of-range number turns red and is not saved');
    input('KELLY_FRACTION').value = '';
    input('KELLY_FRACTION').dispatchEvent(new pwin.Event('input', { bubbles: true }));
    await settle();
    ok(field('KELLY_FRACTION').classList.contains('invalid'), 'popup: a cleared number field is invalid, not zero');
    input('KELLY_FRACTION').value = '0.5';
    input('KELLY_FRACTION').dispatchEvent(new pwin.Event('change', { bubbles: true }));
    await settle();
    ok(!field('KELLY_FRACTION').classList.contains('invalid') && pstore['nexa.autotrade.prefs'].KELLY_FRACTION === 0.5,
       'popup: a valid number saves');
    // a checkbox
    input('DRY_RUN').checked = true;
    input('DRY_RUN').dispatchEvent(new pwin.Event('change', { bubbles: true }));
    await settle();
    ok(pstore['nexa.autotrade.prefs'].DRY_RUN === true, 'popup: checkbox saves');
    // the Signal-only quick toggle flips the form's own checkbox through save()
    pdoc.getElementById('signal-only').click();
    await settle();
    ok(pstore['nexa.autotrade.prefs'].SIGNAL_ONLY === true && input('SIGNAL_ONLY').checked &&
       pdoc.getElementById('signal-only').getAttribute('aria-pressed') === 'true' && field('SIGNAL_ONLY').classList.contains('changed'),
       'popup: Signal-only quick toggle saves the knob and reads as on');
    pdoc.getElementById('signal-only').click();
    await settle();
    ok(pstore['nexa.autotrade.prefs'].SIGNAL_ONLY === undefined && pdoc.getElementById('signal-only').getAttribute('aria-pressed') === 'false',
       'popup: ...and back off (default, so the override is dropped)');
    // the bottom nav switches views
    pdoc.querySelector('.nav-item[data-view="settings"]').click();
    ok(pdoc.getElementById('view-bot').hidden && !pdoc.getElementById('view-settings').hidden &&
       pdoc.querySelector('.nav-item[data-view="settings"]').classList.contains('active'),
       'popup: Settings tab shows the form');
    pdoc.querySelector('.nav-item[data-view="bot"]').click();
    ok(!pdoc.getElementById('view-bot').hidden && pdoc.getElementById('view-settings').hidden, 'popup: Bot tab shows the dashboard');
    // the Log tab: fetched on opening, newest first, the environment line on top, export enabled
    pdoc.querySelector('.nav-item[data-view="log"]').click();
    await settle();
    const logItems = [...pdoc.querySelectorAll('#log li')];
    ok(!pdoc.getElementById('view-log').hidden && logItems.length === 3 &&
       /PLATFORM ALARM/.test(logItems[0].textContent) && logItems[0].classList.contains('alarm') &&
       /Clicked UP/.test(logItems[1].textContent) && logItems[1].classList.contains('trade') &&
       /Loaded\./.test(logItems[2].textContent) && logItems[0].querySelector('time') !== null,
       'popup: Log tab lists the tail newest first, alarm and trade lines marked: ' + logItems.length + ' lines');
    ok(!pdoc.getElementById('environment').hidden && /^UA "Mozilla/.test(txt('environment')) && !pdoc.getElementById('export-log').disabled,
       'popup: the environment line heads the log: ' + txt('environment'));
    ok(!pdoc.getElementById('identity').hidden && /^MISMATCH \(1\)/.test(txt('identity')) &&
       pdoc.getElementById('identity').classList.contains('bad'),
       'popup: a mismatch verdict is shown under it and marked red: ' + txt('identity'));
    pdoc.getElementById('export-log').click();
    await settle();
    ok(sent.includes('nexa:export-log'), 'popup: Export sends nexa:export-log');
    pdoc.querySelector('.nav-item[data-view="bot"]').click();
    // Stop sends the command
    pdoc.getElementById('toggle').click();
    await settle();
    ok(sent.includes('nexa:stop'), 'popup: Stop button sends nexa:stop');
    // reset
    pdoc.getElementById('reset').click();
    await settle();
    ok(pstore['nexa.autotrade.prefs'] === undefined && input('STRATEGY').value === 'auto' && !input('DRY_RUN').checked &&
       !field('STRATEGY').classList.contains('changed'),
       'popup: Reset removes the key and shows the defaults');
    // no content script on the tab
    snapshot = null;
    await new Promise((resolve) => setTimeout(resolve, 1100));   // the popup's own 1s poll (real timers)
    ok(pdoc.getElementById('pill').textContent === 'NO PAGE' && pdoc.getElementById('toggle').disabled && !pdoc.getElementById('note').hidden,
       'popup: without a content script it says NO PAGE and disables Start');
    pwin.close();
  }

  // ---- clicks: event order + the Android native tap ---------------------------------
  {
    const up = document.getElementById('up');
    const order = [];
    const record = (e) => order.push(e.type);
    const types = ['pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'pointerout', 'pointerleave',
      'touchstart', 'touchend', 'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'];
    for (const t of types) up.addEventListener(t, record);
    dbg.simulateClick(up);
    // jsdom answers 'ontouchstart' in window, so this is the touch sequence
    // minus the touch events themselves (no Touch constructor): pointer
    // down/up first, the mouse-compatibility events after, click last.
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const expected = isTouch
      ? ['pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'pointerout', 'pointerleave',
         'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click']
      : ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove',
         'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const got = order.filter((t) => !/^touch/.test(t));
    ok(got.join(' ') === expected.join(' '), 'synthetic click order (' + (isTouch ? 'touch' : 'mouse') + '): ' + got.join(' > '));
    for (const t of types) up.removeEventListener(t, record);

    // Android: the app taps the screen for real — no synthetic events at all.
    const taps = [];
    window.__nexaNativeTap = (x, y) => { taps.push([x, y]); return true; };
    document.elementFromPoint = () => up.querySelector('span');   // the hit test lands inside the button
    window.visualViewport = { offsetLeft: 0, offsetTop: 100, scale: 0.5, width: 2000, height: 1000 };
    const dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true, writable: true });
    let synthetic = 0;
    const countSynthetic = () => { synthetic += 1; };
    up.addEventListener('click', countSynthetic);
    up.addEventListener('pointerdown', countSynthetic);
    dbg.simulateClick(up);
    ok(taps.length === 1 && synthetic === 0, 'native tap used, no synthetic events: taps=' + taps.length + ' synthetic=' + synthetic);
    // #up sits at left 900 / top 220, 80x20; the landing point is 12-88% in. View px =
    // (client - visual viewport offset) x page scale x DPR = (x - 0) x 1.5, (y - 100) x 1.5.
    const [tx, ty] = taps[0] || [NaN, NaN];
    ok(tx >= 909.6 * 1.5 && tx <= 970.4 * 1.5 && ty >= 122.4 * 1.5 && ty <= 137.6 * 1.5,
       'tap point in view pixels (visualViewport offset/scale x DPR): ' + tx.toFixed(1) + ',' + ty.toFixed(1));
    // Something else drawn over the button: a real tap would hit that, so synthetic events instead.
    document.elementFromPoint = () => document.getElementById('clock');
    dbg.simulateClick(up);
    ok(taps.length === 1 && synthetic === 2 && seen(/Native tap skipped — the button is covered/),
       'covered button: synthetic events instead');
    // Button outside the pinch-zoomed visible area.
    document.elementFromPoint = () => up.querySelector('span');
    window.visualViewport = { offsetLeft: 0, offsetTop: 0, scale: 2, width: 400, height: 200 };
    dbg.simulateClick(up);
    ok(taps.length === 1 && synthetic === 4 && seen(/outside the visible \(zoomed\) area/),
       'button outside the zoomed viewport: synthetic events instead');
    // The app says no (no page to tap): synthetic events.
    window.visualViewport = undefined;
    window.__nexaNativeTap = () => false;
    dbg.simulateClick(up);
    ok(taps.length === 1 && synthetic === 6 && seen(/Native tap unavailable/), 'bridge refusal: synthetic events instead');

    // The stake: typed by the app (field focused + selected, no synthetic
    // input events, value untouched here); without the app, the old setter.
    const amount = document.getElementById('amount');
    const typed = [];
    let inputEvents = 0;
    amount.addEventListener('input', () => { inputEvents += 1; });
    window.__nexaNativeType = (text) => { typed.push(text); return true; };
    dbg.setStake(5);
    ok(typed.length === 1 && typed[0] === '5' && inputEvents === 0 && amount.value === '1' &&
       document.activeElement === amount && seen(/Stake typed: \$5 \(kelly\)/),
       'native typing: field focused, "5" handed to the app, no synthetic input event');
    // App refusal, HUMAN_CLICK off: the instant setter path writes the field.
    window.__nexaNativeType = () => false;
    cfg.HUMAN_CLICK = false;
    dbg.setStake(5);
    ok(typed.length === 1 && inputEvents === 1 && amount.value === '5' && seen(/Stake set to \$5 \(kelly\)$/m),
       'app refusal, humanized click off: the synthetic setter path writes the field');
    cfg.HUMAN_CLICK = true;
    delete window.__nexaNativeType;
    delete window.__nexaNativeTap;
    delete document.elementFromPoint;
    if (dprDesc) Object.defineProperty(window, 'devicePixelRatio', dprDesc); else delete window.devicePixelRatio;
    up.removeEventListener('click', countSynthetic);
    up.removeEventListener('pointerdown', countSynthetic);

    // ---- the humanized gesture (HUMAN_CLICK): what the page sees over time ----
    const amountBox = amount.getBoundingClientRect();
    const upBox = up.getBoundingClientRect();
    const inside = (box, x, y) => x > box.left && x < box.right && y > box.top && y < box.bottom;
    // jsdom has no layout: a hit test from the stubbed rects (the deepest node whose box holds the point).
    const hitTest = (x, y) => {
      let best = null;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = el;
      }
      return best || document.body;
    };
    document.elementFromPoint = hitTest;
    const trace = [];                            // every event the page would see, with the fake time
    const traceTypes = ['pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'pointerout', 'pointerleave',
      'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'mouseout', 'mouseleave', 'click', 'focus', 'blur',
      'keydown', 'keypress', 'beforeinput', 'input', 'keyup', 'change'];
    const tracer = (e) => trace.push({ type: e.type, target: e.target, t: now, x: e.clientX, y: e.clientY, key: e.key });
    for (const t of traceTypes) document.addEventListener(t, tracer, true);
    const within = (target, e) => e.target === target || target.contains(e.target);   // the button's <span> is what a hit test finds
    const on = (target, type) => trace.filter((e) => within(target, e) && e.type === type);
    const onSelf = (target, type) => trace.filter((e) => e.target === target && e.type === type);
    const first = (target, type) => on(target, type)[0];
    const timeline = (target) => trace.filter((e) => within(target, e)).map((e) => e.type);

    // The landing point: never the exact centre, always inside, never the same twice.
    const points = Array.from({ length: 40 }, () => dbg.landingPoint(up));
    const centre = { x: upBox.left + upBox.width / 2, y: upBox.top + upBox.height / 2 };
    ok(points.every((p) => inside(upBox, p.x, p.y)) && points.filter((p) => Math.hypot(p.x - centre.x, p.y - centre.y) < 0.001).length === 0 &&
       new Set(points.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2))).size === 40,
       'landing points: 40 draws all inside the button, none the exact centre, none repeated');

    // A mouse: the stake is clicked into and typed, then the mouse travels to the button.
    dbg.realPointer.type = 'mouse'; dbg.realPointer.x = 300; dbg.realPointer.y = 400; dbg.realPointer.at = now;
    dbg.realPointer.over = document.getElementById('app');
    amount.blur();                             // the earlier native-typing check left it focused
    let landsIn = 0;
    trace.length = 0;
    dbg.setStake(15);
    const typingMs = dbg.gesture.readyAt - now;
    ok(typingMs > 400 && seen(/Stake set to \$15 \(kelly\) — typed, done in \d\.\d s/) && amount.value === '5' && trace.length === 0,
       'humanized stake: queued as a gesture, nothing has happened yet: done in ' + typingMs + ' ms');
    landsIn = dbg.humanClick(up);
    ok(landsIn > typingMs && landsIn < typingMs + 2000 && trace.length === 0,
       'humanized click: queued behind the typing, lands in ' + landsIn + ' ms');
    advance(60);
    ok(trace.length > 0 && trace.every((e) => /move|over|enter|out|leave/.test(e.type)) && on(amount, 'mousedown').length === 0,
       'after 60 ms the mouse is on its way (moves only, no press yet): ' + trace.length + ' events');
    advance(typingMs + 20);
    const amountLine = timeline(amount).filter((t) => !/^pointer|move|over|enter|out|leave/.test(t)).join(' ');
    ok(/^mousedown focus mouseup click (keydown keypress beforeinput input keyup ){2}change blur$/.test(amountLine) &&
       amount.value === '15' && document.activeElement !== amount,
       'the field: clicked, focused, "1" then "5" typed key by key, left with change + blur: ' + amountLine);
    const arrive = first(amount, 'mouseover');
    const movesBefore = trace.filter((e) => e.type === 'mousemove' && e.t <= first(amount, 'mousedown').t);
    const keyGaps = on(amount, 'keydown').map((e, i, all) => (i ? e.t - all[i - 1].t : 0)).slice(1);
    ok(!!arrive && inside(amountBox, arrive.x, arrive.y) && movesBefore.length >= 6 &&
       inside(amountBox, movesBefore[movesBefore.length - 1].x, movesBefore[movesBefore.length - 1].y) && !inside(amountBox, movesBefore[0].x, movesBefore[0].y) &&
       first(amount, 'mousedown').t - arrive.t >= 60 && keyGaps.every((g) => g >= 110 && g <= 250),
       'the mouse travelled into the field (' + movesBefore.length + ' moves, from outside), rested ' + (first(amount, 'mousedown').t - arrive.t) + ' ms, keys ' + keyGaps.join('/') + ' ms apart');
    const upBefore = on(up, 'click').length;
    advance(landsIn - typingMs + 60);
    const upLine = timeline(up).filter((t) => !/move/.test(t)).join(' ');
    const press = first(up, 'mousedown'); const release = first(up, 'mouseup');
    const pathToUp = trace.filter((e) => e.type === 'mousemove' && e.t > first(amount, 'blur').t && e.t <= press.t);
    ok(upBefore === 0 && on(up, 'click').length === 1 && onSelf(up, 'mouseenter').length === 1 &&
       /^pointerover( pointerenter)+ mouseover( mouseenter)+ pointerdown mousedown focus pointerup mouseup click$/.test(upLine),
       "the button: hover (enter on it and its span), press (which focuses it), release, click — in the browser's order: " + upLine);
    ok(pathToUp.length >= 6 && inside(upBox, press.x, press.y) && press.x === release.x && press.y === release.y &&
       release.t - press.t >= 55 && release.t - press.t <= 140 && first(up, 'click').t === release.t &&
       press.t - first(up, 'mouseover').t >= 60 && !inside(upBox, pathToUp[0].x, pathToUp[0].y),
       'the mouse travelled from the field to the button (' + pathToUp.length + ' moves), rested ' + (press.t - first(up, 'mouseover').t) + ' ms, held the press ' + (release.t - press.t) + ' ms');
    const leftField = trace.filter((e) => e.target === amount && (e.type === 'mouseout' || e.type === 'mouseleave'));
    const clickedNodes = trace.filter((e) => e.type === 'click').map((e) => e.target.id || e.target.tagName);
    ok(leftField.length >= 2 && leftField[0].t > first(amount, 'blur').t && trace.every((e) => e.type !== 'click' || within(up, e) || e.target === amount),
       'the field saw the mouse leave on its way to the button (' + leftField.map((e) => e.type).join('/') + '); only the field and the button were clicked: ' + clickedNodes.join(', '));

    // A finger (no real mouse seen; jsdom says the device has touch): the tap lands and lifts, then the compatibility events.
    dbg.realPointer.type = null; dbg.realPointer.x = null; dbg.realPointer.over = null;
    trace.length = 0;
    landsIn = dbg.humanClick(up);
    advance(30);
    ok(landsIn >= 60 && landsIn <= 145 && /^pointerover( pointerenter)+ pointerdown$/.test(timeline(up).join(' ')),
       'finger tap: landed (pointer events only so far), lifts in ' + landsIn + ' ms: ' + timeline(up).join(' '));
    advance(landsIn);
    const tapLine = timeline(up).join(' ');
    ok(/^pointerover( pointerenter)+ pointerdown pointerup pointerout( pointerleave)+ mouseover( mouseenter)+ mousemove mousedown mouseup click$/.test(tapLine) &&
       first(up, 'pointerup').t - first(up, 'pointerdown').t >= 60,
       'finger tap: lifted after ' + (first(up, 'pointerup').t - first(up, 'pointerdown').t) + ' ms, then the mouse-compatibility events and the click: ' + tapLine);

    // The app's finger: its answer (ms until it lifts) is the click's landing time; no synthetic events.
    trace.length = 0;
    window.__nexaNativeTap = () => 480;
    document.elementFromPoint = () => up.querySelector('span');
    ok(dbg.humanClick(up) === 480 && trace.length === 0, "app finger: humanClick answers the app's 480 ms, no synthetic events");
    document.elementFromPoint = hitTest;
    // ...and it waits behind a stake still being typed by synthetic keys (the app declined to type it).
    window.__nexaNativeType = () => false;
    let nativeTaps = 0;
    window.__nexaNativeTap = () => { nativeTaps += 1; return 200; };
    dbg.setStake(20);
    const typing20 = dbg.gesture.readyAt - now;
    landsIn = dbg.humanClick(up);
    advance(typing20 - 50);
    const notYet = nativeTaps;
    advance(300);
    ok(landsIn >= typing20 && notYet === 0 && nativeTaps === 1 && amount.value === '20',
       'app finger behind synthetic typing: the tap went out only after the keys (' + typing20 + ' ms), lands in ' + landsIn + ' ms');
    // A hidden tab (timers fire once a second there): a gesture under way finishes at once, a new one is not queued.
    delete window.__nexaNativeTap;
    delete window.__nexaNativeType;
    dbg.realPointer.type = 'mouse'; dbg.realPointer.x = 100; dbg.realPointer.y = 500; dbg.realPointer.at = now; dbg.realPointer.over = document.body;
    trace.length = 0;
    landsIn = dbg.humanClick(up);
    advance(60);
    const underWay = on(up, 'click').length === 0 && trace.length > 0;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    advance(20);
    ok(landsIn > 300 && underWay && on(up, 'click').length === 1 && dbg.gesture.steps.length === 0 && !dbg.gesture.running,
       'tab hidden mid-gesture: the rest went out at once (click landed ' + (landsIn - 80) + ' ms early), the queue is empty');
    ok(dbg.humanClick(up) === null && on(up, 'click').length === 1, 'tab hidden: no gesture is queued (the caller uses the instant click)');
    delete document.visibilityState;
    ok(document.visibilityState === 'visible', 'visibility restored: ' + document.visibilityState);
    dbg.realPointer.type = null; dbg.realPointer.x = null; dbg.realPointer.over = null;
    // HUMAN_CLICK off: the instant sequence, all in one go.
    cfg.HUMAN_CLICK = false;
    trace.length = 0;
    dbg.simulateClick(up);
    ok(on(up, 'click').length === 1 && on(up, 'pointerdown').length === 1 && first(up, 'pointerdown').t === first(up, 'click').t,
       'humanized click off: the instant synthetic sequence fires at once');
    for (const t of traceTypes) document.removeEventListener(t, tracer, true);

    // ---- end to end: a live entry is a gesture, and the verdict waits for it to land ----
    stop();
    cfg.HUMAN_CLICK = true;
    cfg.DRY_RUN = false;
    cfg.TRADE_ON_START = true;
    cfg.KEEP_TRADING_AFTER_SEC = 0;
    cfg.REACTION_DELAY = false;                // the entry on Start goes out on the first tick, synchronously
    document.getElementById('payout').textContent = '+85%';
    dbg.realPointer.type = 'mouse'; dbg.realPointer.x = 300; dbg.realPointer.y = 400; dbg.realPointer.at = now;
    dbg.realPointer.over = document.getElementById('app');
    let liveClicks = 0;
    const countLive = () => { liveClicks += 1; };
    up.addEventListener('click', countLive);
    document.getElementById('down').addEventListener('click', countLive);
    noise(30);
    trend(20, 0.00004);                        // the trend state says UP: an entry on Start
    const clickedBefore = count(/^Clicked (UP|DOWN) #/);
    start();
    ok(count(/^Clicked (UP|DOWN) #/) === clickedBefore + 1, 'a trade was placed on Start: ' + last(/^Clicked (UP|DOWN) #/));
    const clickLine = last(/^Clicked (UP|DOWN) #/);
    const landing = /the click lands in (\d+\.\d) s\)$/.exec(clickLine);
    ok(dbg.bot.running && count(/^Clicked (UP|DOWN) #/) === clickedBefore + 1 && !!landing && liveClicks === 0,
       'live entry on Start: a gesture still on its way, its landing time logged: ' + clickLine);
    const landsMs = landing ? Math.round(parseFloat(landing[1]) * 1000) : 0;
    advance(landsMs + 100);
    ok(liveClicks === 1, 'the button was clicked when the gesture said it would be (' + landsMs + ' ms)');
    const verdictsBefore = count(/^UNCONFIRMED/);
    advance(cfg.CONFIRM_MS - 200);
    ok(count(/^UNCONFIRMED/) === verdictsBefore && dbg.bot.running, 'no verdict yet: CONFIRM_MS is counted from the landing, not the decision');
    advance(300);
    ok(count(/^UNCONFIRMED/) === verdictsBefore + 1, 'the (unconfirmed: no server order here) verdict came CONFIRM_MS after the click landed');
    stop();
    up.removeEventListener('click', countLive);
    document.getElementById('down').removeEventListener('click', countLive);
    delete document.elementFromPoint;
    cfg.HUMAN_CLICK = false;
    cfg.REACTION_DELAY = true;
    ok(!seen(/something else is drawn over the button/), 'no press had to click through a cover');
  }

  // ---- platform alarm: captcha / notice -> the run stops, Start is refused --------
  {
    stop();
    cfg.PLATFORM_ALARM = true;
    noise(20);
    start();
    ok(dbg.bot.running, 'alarm scenario: running');
    const captcha = document.createElement('iframe');
    captcha.src = 'https://www.google.com/recaptcha/api2/anchor?k=x';
    document.body.appendChild(captcha);
    advance(3_100);                            // one sweep
    ok(!dbg.bot.running && seen(/PLATFORM ALARM: captcha \/ human check on the page — the run was stopped/) &&
       pillText() === 'ALARM' && dbg.alarm && dbg.alarm.reason.startsWith('captcha'),
       'a captcha on the page stops the run: ' + pillText() + ' / ' + caption());
    start();
    ok(!dbg.bot.running && seen(/Cannot start: platform alarm — captcha/), 'Start is refused while the captcha is up');
    const said = count(/PLATFORM ALARM:/);
    advance(6_200);
    ok(count(/PLATFORM ALARM:/) === said, 'a standing alarm is said once, not every sweep');
    captcha.remove();
    advance(3_100);
    noise(20);                                 // quotes keep flowing; the chart lock needs them
    start();
    ok(dbg.bot.running, 'the run starts again once the page is clean: ' + last(/Cannot start|Started|Account:/));
    const modal = document.createElement('div');
    modal.className = 'modal-window';
    modal.textContent = 'We have detected unusual activity on your account. Please contact support.';
    document.body.appendChild(modal);
    advance(3_100);
    ok(!dbg.bot.running && /platform notice: "unusual activity"/.test(dbg.alarm.reason) &&
       /^ALARM · platform notice/.test(caption()),
       'a visible notice with an alarming phrase stops the run: ' + dbg.alarm.reason);
    modal.remove();
    advance(3_100);
    cfg.PLATFORM_ALARM = false;
  }

  // ---- per-install timing profile -------------------------------------------------
  {
    ok(seen(/Timing profile \(saved, fixed for this install\)/) && dbg.profile.reaction === 1 && dbg.profile.skip === 1,
       'the saved (neutral) profile was loaded at boot');
    dbg.store.remove('nexa.autotrade.profile');
    const source = dbg.loadProfile();
    const fresh = storage['nexa.autotrade.profile'];
    const ranges = { reaction: [0.8, 1.4], jitter: [0.7, 1.6], session: [0.75, 1.35], rest: [0.7, 1.6], skip: [0.7, 1.4], sticky: [0.8, 1.3],
      move: [0.8, 1.3], aimX: [-0.08, 0.08], aimY: [-0.08, 0.08] };
    const inRange = Object.keys(ranges).every((k) => fresh && fresh[k] >= ranges[k][0] && fresh[k] <= ranges[k][1] && dbg.profile[k] === fresh[k]);
    ok(source === 'new' && fresh && fresh.v === 1 && inRange, 'without one, a fresh profile is drawn inside the ranges and stored: ' + JSON.stringify(fresh));
    dbg.store.set('nexa.autotrade.profile', { ...NEUTRAL_PROFILE });
    ok(dbg.loadProfile() === 'saved' && dbg.profile.jitter === 1, 'a stored profile is reused, not redrawn');
    dbg.store.set('nexa.autotrade.profile', { v: 1, reaction: 9, jitter: 1, session: 1, rest: 1, skip: 1, sticky: 1 });
    ok(dbg.loadProfile() === 'new' && dbg.profile.reaction <= 1.4, 'an out-of-range profile is replaced');
    // A profile from before the move/aim values existed: those are drawn and stored beside it, the rest kept.
    dbg.store.set('nexa.autotrade.profile', { v: 1, created: 1, reaction: 1.2, jitter: 1, session: 1, rest: 1, skip: 1, sticky: 1 });
    const extended = dbg.loadProfile();
    const kept = storage['nexa.autotrade.profile'];
    ok(extended === 'extended' && dbg.profile.reaction === 1.2 && kept.reaction === 1.2 &&
       kept.move >= 0.8 && kept.move <= 1.3 && Math.abs(kept.aimX) <= 0.08 && Math.abs(kept.aimY) <= 0.08 && seen(/Timing profile \(extended/),
       'an older profile is extended with the new values, its own kept: ' + JSON.stringify(kept));
    dbg.store.set('nexa.autotrade.profile', { ...NEUTRAL_PROFILE });
    dbg.loadProfile();
  }

  // ---- the Android shim: the bridge hidden, chrome.* off enumeration, storage round trip ----
  {
    const sdom = new JSDOM('<!doctype html><html><body></body></html>',
      { url: 'https://market-qx.trade/en/demo-trade', runScripts: 'outside-only' });
    const swin = sdom.window;
    const held = {};
    const fake = {
      storageGetAll: () => JSON.stringify(held),
      storageSet: (json) => { Object.assign(held, JSON.parse(json)); },
      storageRemove: (json) => { for (const k of JSON.parse(json)) delete held[k]; },
      version: () => '1.2.0', tap: () => 350, type: () => true, notify: () => {}, saveFile: () => 'ok',
    };
    swin.nxHost = fake;                          // as the WebView injects it: a plain, enumerable global
    try { swin.eval(read('android/app/src/main/assets/shim.js')); } catch (error) { ok(false, 'android shim threw: ' + error.stack); }
    ok(swin.chrome && typeof swin.chrome.storage.local.get === 'function' && swin.chrome.runtime.getManifest().version === '1.2.0',
       'android shim: chrome.storage / chrome.runtime provided, version from the bridge');
    let got = null;
    swin.chrome.storage.local.set({ 'nexa.autotrade.prefs': { STRATEGY: 'trend' } });
    swin.chrome.storage.local.get('nexa.autotrade.prefs', (items) => { got = items; });
    ok(got && got['nexa.autotrade.prefs'].STRATEGY === 'trend' && held['nexa.autotrade.prefs'].STRATEGY === 'trend',
       'android shim: storage round trip through the bridge');
    const keys = Object.keys(swin);
    const leaked = keys.filter((k) => /^__nexa|^nxHost$/.test(k));
    ok(leaked.length === 0 && !Object.keys(swin.chrome).includes('storage') && !Object.keys(swin.chrome.runtime).includes('getManifest'),
       'android shim: nothing of the bot enumerates on window or chrome: ' + JSON.stringify(leaked));
    ok(swin.nxHost === fake && typeof swin.__nexaNativeTap === 'function' && typeof swin.__nexaAndroid.message === 'function' &&
       swin.__nexaNativeTap(1, 2) === 350 && swin.__nexaNativeType('5') === true,
       'android shim: ...while everything stays reachable by name (the tap answers the ms until the finger lifts)');
    fake.tap = () => true;
    ok(swin.__nexaNativeTap(1, 2) === 0, 'android shim: an older bridge answering true counts as a tap that lands now');
    fake.tap = () => -1;
    ok(swin.__nexaNativeTap(1, 2) === false, 'android shim: a bridge refusal (-1) is false');
    ok(typeof swin.navigator.platform === 'string', 'android shim: native navigator.platform preserved');
    swin.close();
  }

  // ---- report -----------------------------------------------------------------
  const errors = logs.filter((l) => /^ERROR/.test(l));
  ok(errors.length === 0, 'no console.error during the run' + (errors.length ? ': ' + errors.join(' | ') : ''));
  origLog('\n' + (failures.length ? failures.length + ' FAILED' : 'ALL PASSED'));
  if (failures.length || process.argv.includes('--verbose')) { origLog('\n--- log tail ---'); origLog(logs.slice(-45).join('\n')); }
  process.exit(failures.length ? 1 : 0);
})();
