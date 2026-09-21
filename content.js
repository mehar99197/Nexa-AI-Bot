/* ==========================================================================
   Nexa AutoTrade Bot — content script (ISOLATED world)

   Sections:
     0. CONFIG             <- defaults; the popup (popup.js) overrides the
                              user-facing subset listed in settings.js
     1. UI                 (one card: logo, name, Start/Stop pill, caption; BUY/SELL flash)
     2. Price feed         (quotes relayed from inject.js)
     2b. Tick recorder     (IndexedDB journal + JSON export for tools/backtest.js)
     2c. Multi-asset scanner (per-symbol buffers: setup ranking + warm starts,
                              plus the candle series the HTF filter reads)
     3. Element resolution (finding the Up / Down buttons robustly)
     3b. Trade panel       (payout % and expiry read from the page)
     4. Trade execution    (clicking Call / Put)
     5. Strategy           (decide what to do with the price history)
     5b. Auto mode         (self-calibrating shadow scoreboard)
     6. Bot loop           (start / stop / tick)
     7. Wiring + debug helpers (globalThis.__nexaDebug in the isolated world)
     7b. Settings + popup channel (chrome.storage prefs, runtime messages)

   NOTE: the price does NOT come from the DOM. Quotex renders the chart to a
   single <canvas>, so there is nothing to scrape. inject.js runs in the MAIN
   world, taps the Socket.IO feed, and posts quotes over here. If inject.js
   fails to load, this file has no price and the bot will refuse to start.

   This runs at document_start, not document_idle. Quotex fires its load event
   around 2.5s on a warm cache and much later on a cold one, and document_idle
   is queued after that — the widget used to sit invisible for seconds. At
   document_start only <html> exists, so the widget is appended to
   document.documentElement and its saved position is applied on the first
   animation frame, once layout has actually run.
   ========================================================================== */

(() => {
  'use strict';

  const WIDGET_ID = 'nexa-autotrade-widget';
  const POSITION_KEY = 'nexa.autotrade.position';
  const DRY_RUN_KEY = 'nexa.autotrade.dryrun';
  const REC_KEY = 'nexa.autotrade.record';
  const SETTINGS_KEY = 'nexa.autotrade.settings';   // legacy (removed at boot)
  const PREFS_KEY = NexaSettings.SETTINGS_KEY;        // what the popup writes
  const DAILY_KEY = 'nexa.autotrade.daily';
  // Scoreboards: v2 — the v1 records were scored against a bar that a coin
  // flip cleared (see autopilot.js bestQualified) and with seed-biased EMAs,
  // so they are not evidence of anything and are not carried over.
  const SCORES_PREFIX = 'nexa.autotrade.scores2.';
  const LEGACY_SCORES_PREFIX = 'nexa.autotrade.scores.';

  // Guard against multiple instances - check this FIRST
  if (window.__nexaBotLoaded) return;

  // The few globals this file leaves on window are defined non-enumerable.
  // In the extension the isolated world hides them from the page anyway;
  // in the Android app the page shares the world, and a walk of
  // Object.keys(window) is a common way to look for injected tooling. A
  // property that does not enumerate is not found that way (the modules —
  // NexaStrategy and friends — already define themselves like this).
  const hiddenGlobal = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    } catch (_) {
      globalThis[name] = value;   // a non-configurable leftover: plain assignment still works
    }
  };
  hiddenGlobal('__nexaBotLoaded', true);

  /* =======================================================================
     0a. Storage

     chrome.storage.local (extension-scoped) behind a synchronous in-memory
     cache. It used to be the page's localStorage, which meant three things:
     Quotex's own scripts could read and enumerate every nexa.* key, a
     "clear site data" wiped the learner and the daily loss cap, and none of
     it followed the user across the mirror domains in the manifest.
     Everything here is loaded once at boot; reads are synchronous from the
     cache and writes are write-through. A one-time migration lifts the old
     keys out of localStorage and removes them from the page.
     ======================================================================= */

  const store = {
    cache: new Map(),
    ready: false,
    area: (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
      ? chrome.storage.local : null,
    get(key) {
      return this.cache.has(key) ? this.cache.get(key) : null;
    },
    set(key, value) {
      this.cache.set(key, value);
      if (this.area) {
        try {
          this.area.set({ [key]: value }, () => { void chrome.runtime.lastError; });
        } catch (_) { /* extension context gone (reload) — cache still serves */ }
      } else {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota */ }
      }
    },
    remove(key) {
      this.cache.delete(key);
      if (this.area) {
        try { this.area.remove(key, () => { void chrome.runtime.lastError; }); } catch (_) {}
      } else {
        try { localStorage.removeItem(key); } catch (_) {}
      }
    },
  };

  /** Read-and-delete every nexa.* key the page's localStorage still holds. */
  function migrateLocalStorage() {
    const lifted = [];
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith('nexa.')) keys.push(key);
      }
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        localStorage.removeItem(key);
        if (key.startsWith(LEGACY_SCORES_PREFIX) || store.cache.has(key)) continue;
        let value;
        if (key === DRY_RUN_KEY || key === REC_KEY) {
          value = raw === '1' ? true : raw === '0' ? false : null;
        } else {
          try { value = JSON.parse(raw); } catch (_) { value = null; }
        }
        if (value !== null) {
          store.set(key, value);
          lifted.push(key);
        }
      }
    } catch (_) { /* storage access denied — nothing to migrate */ }
    return lifted;
  }

  function loadStore(done) {
    const finish = () => {
      const lifted = migrateLocalStorage();
      store.ready = true;
      done(lifted);
    };
    if (!store.area) {
      // No chrome.storage (unexpected in a content script): serve from the
      // page's localStorage so nothing is lost, migration then no-ops.
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key || !key.startsWith('nexa.')) continue;
          const raw = localStorage.getItem(key);
          if (key === DRY_RUN_KEY || key === REC_KEY) {
            store.cache.set(key, raw === '1');
          } else {
            try { store.cache.set(key, JSON.parse(raw)); } catch (_) { /* skip */ }
          }
        }
      } catch (_) { /* nothing readable */ }
      store.ready = true;
      done([]);
      return;
    }
    try {
      store.area.get(null, (items) => {
        if (chrome.runtime.lastError) {
          console.debug('[AutoTrade] chrome.storage read failed:', chrome.runtime.lastError);
        } else if (items && typeof items === 'object') {
          for (const [key, value] of Object.entries(items)) store.cache.set(key, value);
        }
        finish();
      });
    } catch (error) {
      console.debug('[AutoTrade] chrome.storage unavailable:', error);
      finish();
    }
  }

  /* =======================================================================
     0. CONFIG
     ======================================================================= */

  const CONFIG = {
    // When true, trades are journaled and settled virtually, nothing is
    // clicked. There is no toggle any more (the UI is a single Start/Stop
    // pill); flip it from the console with __nexaDebug.config.DRY_RUN = true.
    DRY_RUN: false,

    // Live (real-money) account policy, checked on Start and before every
    // click: 'never' refuses the live route, 'confirm' (default) asks for a
    // second tap on the pill within 6s the first time in a page session,
    // 'allow' trades without asking. The account is re-read before every
    // click; a run that started on one account stops if the route changes.
    LIVE_ACCOUNT: 'confirm',

    TICK_MS: 1000,               // how often the loop runs
    // Gap between two trades. With COOLDOWN_FROM_EXPIRY the gap follows the
    // contract on the panel — one open trade at a time: expiry + a settle
    // margin, never under MIN_COOLDOWN_MS (a 5s option trades every 10s, a
    // 60s option every 65s). TRADE_COOLDOWN_MS is the fixed fallback.
    COOLDOWN_FROM_EXPIRY: true,
    SETTLE_MARGIN_MS: 5_000,
    MIN_COOLDOWN_MS: 10_000,
    TRADE_COOLDOWN_MS: 60_000,
    MAX_TRADES_PER_SESSION: 20,  // only enforced when RUN_UNTIL_STOPPED is false; 0 = unlimited
    MAX_HISTORY: 300,            // price samples kept in memory

    // Which signal model runs. 'auto' (default) hands the wheel to the
    // self-calibrating scoreboard in section 5b: every variant in its pool
    // trades VIRTUALLY on the live feed, each virtual trade is settled one
    // expiry later against the real price, and real clicks go only to a
    // variant whose rolling record clears break-even by AUTO_MARGIN across
    // at least AUTO_MIN_SAMPLES decided outcomes. Until then the bot
    // watches and learns — clicking nothing is the correct behaviour when
    // nothing is proven. 'momentum' / 'zscore' pin a single fixed model
    // (the pre-auto behaviour).
    STRATEGY: 'auto',

    // Auto-mode calibration knobs. Learning is per symbol AND per expiry
    // (a 60s record says nothing about 120s options) and persists across
    // reloads in chrome.storage. (No settings UI: change them here.)
    //
    // The bar is the Wilson LOWER confidence bound of the hit-rate, not the
    // observed ratio. The old values (30 samples, 4 points, raw ratio) were
    // simulated against a pure coin flip: with eight variants re-tested on
    // every outcome a variant qualified in 100% of runs, after a median of
    // 31 outcomes, and real trades stayed armed 50% of the time on zero
    // edge. With these values that is ~4% of runs and 0.2% of the time,
    // while a genuine 60% model is armed ~94% of the time once it has 100
    // decided outcomes. Proving a small edge needs hundreds of outcomes;
    // there is no setting that makes that untrue.
    AUTO_MIN_SAMPLES: 100,  // decided (win/loss) outcomes before real trades
    AUTO_MARGIN: 0.01,      // required edge of the LOWER bound over break-even
    AUTO_ROLLING: 300,      // rolling outcomes kept per variant (caps n)
    AUTO_CONFIDENCE_Z: 2.0, // one-sided ~97.7% for the Wilson bound

    // Statistical filters measure trend quality, not a guaranteed trading edge.
    //
    // Calibrated against 6 minutes of LIVE CHFJPY_otc ticks captured through
    // this extension (234 rolling windows), where the real distributions were:
    //   |z|        median 0.46, p95 1.54, max 2.08  -> the old 2.5 gate could
    //              literally never pass on this feed
    //   efficiency median 0.123, p90 0.257, max 0.332 -> the original 0.55 was
    //              above the observed maximum; even 0.25 passed only 12%
    //   volatility median 3.5e-4, max 4.6e-4 -> 1e-3 passes normal ticks and
    //              blocks genuine spikes (the old 0.015 never bound at all)
    // At 1.5 / 0.10 the recorded series produced a signal ~every 20s of
    // ticking; even so, a 4-minute live run fired nothing (see STRATEGY note)
    // — treat zscore as the conservative option, not the workhorse.
    FAST_WINDOW: 12,
    SLOW_WINDOW: 48,
    Z_SCORE_THRESHOLD: 1.5,
    MIN_EFFICIENCY_RATIO: 0.10,
    MAX_REALIZED_VOLATILITY: 0.001,

    // Momentum strategy (STRATEGY: 'momentum'): EMA crossover, confirmed by
    // the drift over the last MOMENTUM_TICKS samples. 10/30 gave the sanest
    // cadence (~1 trade per 2 min) on the same live series.
    //
    // These are the 60s-horizon values and they are OVERWRITTEN at runtime by
    // applyHorizon() to match the expiry actually selected on the page — see
    // HORIZONS in horizons.js. A 10/30 EMA spans ~14s of a 2.2Hz feed, which is
    // nonsense as the basis for a 5-SECOND forecast; that mismatch, not the
    // model, is why short-expiry signals were noise.
    EMA_FAST: 10,
    EMA_SLOW: 30,
    MOMENTUM_TICKS: 6,
    MIN_MOMENTUM: 0.00001,

    // When true, applyHorizon() retunes the windows above (and the z-score
    // ones) from the live expiry. Set false to pin whatever is configured.
    HORIZON_AUTO: true,

    // A signal is only tradeable if the move it predicts is bigger than what
    // execution costs. Slippage measured live at a 5s expiry was 0.0117% of
    // price while MIN_MOMENTUM demanded 0.001% — the threshold was an order
    // of magnitude BELOW the cost, so entries were negative-EV before the
    // strategy had any say. This requires |expected move| >= this multiple of
    // the recent median slippage. 0 disables; the gate stands aside until
    // enough real fills have been measured.
    EDGE_OVER_COST: 1.0,
    MIN_SLIPPAGE_SAMPLES: 5,

    // After clicking, wait this long for a matching server-side open order.
    // Two unconfirmed trades in a row stops the bot.
    CONFIRM_MS: 4000,

    // Quotes arrive roughly twice a second. If nothing has arrived for this
    // long the feed is considered dead and trading halts.
    QUOTE_STALE_MS: 10_000,

    // A history window that spans a feed outage mixes two unrelated price
    // contexts — the catch-up jump after the gap reads as a huge instant
    // move and poisons every return-based statistic. If consecutive samples
    // arrive more than this far apart, the history restarts from scratch.
    MAX_SAMPLE_GAP_MS: 5_000,

    // Place the first trade of a run within its first tick instead of waiting
    // for the next crossover (minutes) or, in auto mode, for a variant to
    // qualify (hours). Direction = the trend state right now: fast EMA above
    // the slow one → UP, below → DOWN, over the active horizon's windows and
    // the warm-start history. This is NOT a model signal — it is a coin flip
    // with a trend tilt — so it passes the safety gates (demo route, payout,
    // feed health, daily cap) but skips the quality ones (edge-vs-cost, entry
    // window). It also clears the cooldown left by the previous run: Start is
    // a deliberate act. The remaining trades of the run follow the strategy.
    TRADE_ON_START: true,
    INSTANT_START_WINDOW_MS: 30_000,   // keep trying this long if a gate holds it

    // Run until the user presses Stop. The bot used to stop itself on the
    // session trade limit, on a loss streak, on two unconfirmed clicks and on
    // a missing button. With this on none of those end the run: the trade
    // limit is ignored, a loss streak PAUSES trading for LOSS_STREAK_PAUSE_MS
    // (then resumes with a fresh streak), two unconfirmed clicks pause it for
    // UNCONFIRMED_PAUSE_MS (doubling each time it recurs, up to 10 min — a
    // clicker that does not register must not hammer the button), and a
    // missing button is simply retried on the next tick. What still stops
    // the bot: the user, the daily loss cap they set, leaving the demo route
    // (a hard rail), and the page unloading. Analysis never pauses — the
    // history and the scoreboard keep learning through a pause.
    RUN_UNTIL_STOPPED: true,
    LOSS_STREAK_PAUSE_MS: 5 * 60_000,
    UNCONFIRMED_PAUSE_MS: 2 * 60_000,
    UNCONFIRMED_PAUSE_MAX_MS: 10 * 60_000,

    // Keep trading: when the model has been silent for this long since the
    // last trade (and the cooldown has passed), take the trend state instead
    // — the same entry Trade-on-Start uses. A model signal still wins
    // whenever one fires. Without this, momentum/zscore trade only on their
    // (sporadic) events and auto mode trades nothing until a variant
    // qualifies, which takes hours. 0 disables the fallback.
    KEEP_TRADING_AFTER_SEC: 15,

    // A signal is only actionable on the sample it fired on. tick() drains
    // every sample buffered since it last ran; in a foreground tab that is
    // ~2 samples, but Chrome throttles a hidden tab's timers to ONE run per
    // minute after five minutes, so the drain can hold a crossover from 55s
    // ago — which then became a click at today's price. Any signal older
    // than this is recorded by the scoreboard but never executed.
    SIGNAL_MAX_AGE_MS: 2_500,

    // ---- Signal-quality gates (checked AFTER a signal, before the click) --

    // Assumed option expiry, used for trade journaling and backtest labeling.
    // The trade panel's duration readout overrides it whenever readable.
    EXPIRY_SEC: 60,

    // Skip trades while the visible payout is below this percentage
    // (0 disables). Payout is the cheapest edge there is: at 85% the
    // break-even hit-rate is 54.1%, at 70% it is 58.8% — same model, very
    // different bar. If the payout cannot be read off the page the filter
    // logs once and stands aside rather than silently blocking every trade.
    MIN_PAYOUT_PCT: 70,

    // When the payout cannot be read off the page, real clicks are held —
    // but the only other source of the payout is the server's percentProfit
    // on a confirmed order, which needs a click. So after
    // PAYOUT_PROBE_AFTER_MS of "unknown", ONE probe trade is allowed through
    // (then at most one every PAYOUT_PROBE_EVERY_MS) to learn it; from then
    // on the min-payout gate works on the server's figure.
    PAYOUT_PROBE_AFTER_MS: 20_000,
    PAYOUT_PROBE_EVERY_MS: 120_000,

    // How often to re-read payout/duration from the trade panel (ms).
    PANEL_RECHECK_MS: 3_000,

    // Minimum samples over the last 10s. Below this the feed is too thin
    // for any statistic computed from it to mean much.
    MIN_TICKS_10S: 8,

    // No trades for this long after a feed gap, socket drop, or chart
    // switch — the first moments after a reset are exactly when the series
    // lies about itself.
    POST_RESET_QUIET_MS: 30_000,

    // If > 0, trade only during the first N seconds of each minute
    // (candle-aligned entries). Off by default: turn it on only after
    // tools/backtest.js shows it helps on YOUR recorded feed.
    ENTRY_WINDOW_SEC: 0,

    // ---- Higher-timeframe context (candles.js) ----

    // Every model above looks at ~300 ticks — about 2.5 minutes. Candles
    // rebuilt from the same feed (per symbol, since the page loaded) give
    // the trade a longer view: with HTF_FILTER on, a click AGAINST the
    // candle trend (fast EMA of closes vs slow) is held, and so is a buy
    // into an overbought RSI or a sell into an oversold one (HTF_RSI_BLOCK
    // and its mirror 100 - HTF_RSI_BLOCK; 0 disables that gate). The filter
    // stands aside while the candles are still warming up (HTF_EMA_SLOW + 1
    // closed candles: ~22 minutes on the page at 1m), so a fresh start still
    // trades — the status says "warming". The instant entry and the
    // keep-trading fallback are held by it too: those follow the SHORT
    // trend, which is exactly the entry a longer trend runs over.
    // tools/backtest.js --htf replays the same gate on a recording; turn
    // this off if it does not help on YOUR feed.
    HTF_FILTER: true,
    HTF_CANDLE_SEC: 60,
    HTF_EMA_FAST: 8,
    HTF_EMA_SLOW: 21,
    HTF_RSI_PERIOD: 14,
    HTF_RSI_BLOCK: 70,

    // ---- Alerts & money management ----

    // Signal-only: never click — flash the arrow on the widget (and beep)
    // and let the human decide. Ideal while validating accuracy.
    SIGNAL_ONLY: false,
    ALERT_SOUND: true,

    // Stake sizing before each click (the amount is written into the
    // platform's field; best-effort — if the input can't be found the trade
    // goes through with whatever is set):
    //   'off'     leave the platform's amount alone
    //   'fixed'   STAKE_VALUE dollars every trade
    //   'percent' STAKE_VALUE percent of the balance of the account traded
    //   'kelly'   (default) fractional Kelly on MEASURED evidence: the
    //             qualified variant's Wilson lower bound (auto mode) or the
    //             session record once it has 30 decided trades. Where there
    //             is no evidence — the instant entry after Start, the
    //             keep-trading fallback, an unproven model — the stake is
    //             STAKE_MIN. So the money scales with proof and the coin-flip
    //             entries ride the minimum. KELLY_FRACTION 0.25 = quarter
    //             Kelly (full Kelly assumes the hit-rate is exactly known);
    //             STAKE_MAX_PCT caps any single stake.
    STAKE_MODE: 'kelly',
    STAKE_VALUE: 1,
    STAKE_MIN: 1,
    KELLY_FRACTION: 0.25,
    STAKE_MAX_PCT: 5,
    // Human-looking stakes. The sizer's figure (kelly, percent) is rounded
    // DOWN to a value a person types — 1 2 3 5 10 15 20 25 30 40 50 75 100 …
    // — and the amount field is left alone while it already holds a figure
    // within STAKE_STICKY_PCT of the new one: nobody retypes $2 as $2.40
    // forty times an hour, and a stake that drifts by cents every trade is
    // a machine's signature the server can read. A fixed stake is the
    // user's own number and is used as typed.
    STAKE_HUMAN: true,
    STAKE_STICKY_PCT: 30,

    // Daily circuit breakers, per account (a demo loss never locks the live
    // account and the other way round), on today's REALIZED bot P&L:
    //   DAILY_LOSS_CAP_PCT      stop for the day at -N% of the balance the
    //                           account had when the bot first traded today
    //   DAILY_PROFIT_TARGET_PCT stop for the day at +N% — banking a good day
    //                           is the one edge that needs no model
    //   DAILY_LOSS_CAP          absolute dollar cap, for accounts whose
    //                           balance the feed does not report
    // 0 disables each. A stopped day refuses restarts until midnight (local).
    // MAX_LOSS_STREAK pauses (RUN_UNTIL_STOPPED) or stops after N losses in
    // a row; 0 disables.
    DAILY_LOSS_CAP_PCT: 10,
    DAILY_PROFIT_TARGET_PCT: 20,
    DAILY_LOSS_CAP: 0,
    MAX_LOSS_STREAK: 4,

    // Journal every streaming tick to IndexedDB for tools/backtest.js (see
    // section 2b). Off by default: a busy watchlist writes ~100 rows/s and
    // the journal caps at 500k rows (tens of MB), so recording is a choice.
    // Export from the popup or with __nexaDebug.exportTicks(), drop the file
    // into recordings/, then `npm run backtest -- --walk-forward`.
    RECORD_TICKS: false,

    // Manual instrument override, e.g. 'AUDNZD_otc'. Leave null and the bot
    // locks onto whichever chart is actually open, reading the asset title from
    // the page header. quotes/stream carries EVERY subscribed asset (the
    // watchlist and asset picker add more), so without this lock the bot would
    // mix several pairs into one price history.
    SYMBOL: null,

    // How often to re-read the chart title from the DOM (ms).
    SYMBOL_RECHECK_MS: 2000,

    // Humanized timing & stealth
    MAX_TRADES_PER_HOUR: 20,           // max trades in a rolling 60 min window (0 = unlimited)
    REST_CYCLE_ENABLED: true,          // take periodic human rest breaks
    SESSION_WORK_MINUTES: 25,          // active trading work interval before a rest
    SESSION_WORK_JITTER_MIN: 5,        // +/- random variation on work interval
    REST_BREAK_MINUTES: 5,             // rest break duration
    REST_BREAK_JITTER_MIN: 2,          // +/- random variation on break duration
    REACTION_DELAY: true,              // natural reaction delay on algorithmic signals
    REACTION_DELAY_MIN_MS: 800,        // min reaction delay (read the signal, move the thumb)
    REACTION_DELAY_MAX_MS: 2000,       // max reaction delay
    // The click as a person makes it (see "Humanized input" below): the
    // mouse travels to the button and rests on it, the press is held, the
    // stake is typed key by key; a finger lands and lifts. Off = the
    // instant synthetic sequence (every event in the same millisecond).
    HUMAN_CLICK: true,
    COOLDOWN_JITTER_MIN_MS: 1_000,     // min jitter added to cooldown
    COOLDOWN_JITTER_MAX_MS: 5_000,     // max jitter added to cooldown
    // People miss signals; a bot that takes every one it sees trades on a
    // rhythm no person keeps. This share of model signals is let go on
    // purpose, and a missed signal then rests for one cooldown as a taken
    // trade would (so a level-type signal is not simply caught on the next
    // tick). The entry after Start and the keep-trading fallback are not
    // signals and are never skipped; Signal-only never skips an alert.
    // 0 = take every signal.
    SKIP_SIGNAL_PCT: 15,

    // Platform alarm. When the platform itself looks alarmed — a captcha or
    // human check, a notice about unusual or automated activity, a blocked
    // or suspended account, a forced re-login — the run stops on the spot,
    // the pill says ALARM and Start is refused while it lasts. Trading on
    // through a challenge is how a suspicious session becomes a closed
    // account; use the platform by hand for a while instead. The page is
    // swept every PLATFORM_ALARM_EVERY_MS, running or not.
    PLATFORM_ALARM: true,
    PLATFORM_ALARM_EVERY_MS: 3_000,
  };

  // The defaults of the knobs the popup can change (settings.js SCHEMA),
  // captured before anything touches CONFIG: a removed override goes back
  // to exactly this, not to whatever applyHorizon left behind.
  const USER_DEFAULTS = {};
  for (const row of NexaSettings.SCHEMA) USER_DEFAULTS[row.key] = CONFIG[row.key];

  // Horizon presets and the auto-mode variant pool live in horizons.js so
  // tools/backtest.js replays exactly the windows the live bot runs for a
  // given expiry — they used to be a hardcoded 60s copy over there.
  const horizonFor = (seconds) => NexaHorizons.horizonFor(seconds);

  let activeHorizon = null;   // label of the preset currently written into CONFIG

  /** Retune CONFIG for the expiry the page is actually offering. */
  function applyHorizon() {
    if (!CONFIG.HORIZON_AUTO) return;
    const row = horizonFor(effectiveExpirySec());
    if (row.label === activeHorizon) return;
    activeHorizon = row.label;
    Object.assign(CONFIG, row.momentum, row.zscore);
    log('Horizon ' + row.label + ' (' + effectiveExpirySec() + 's expiry): EMA ' +
        CONFIG.EMA_FAST + '/' + CONFIG.EMA_SLOW + ' momo ' + CONFIG.MOMENTUM_TICKS +
        ' | z ' + CONFIG.FAST_WINDOW + '/' + CONFIG.SLOW_WINDOW +
        ' thr ' + CONFIG.Z_SCORE_THRESHOLD);
  }

  /**
   * How to find each trade button, in priority order.
   *
   * VERIFIED live on market-qx.trade — tier 1 resolves both buttons:
   *   UP   -> <button class="KtjVk JQZcs _5qIw LzVPu">  (text "Up")
   *   DOWN -> <button class="KtjVk twQq3 _5qIw LzVPu">  (text "Down")
   *
   * Tiers 1-2 key off the SVG sprite name, which is a semantic asset id rather
   * than a build hash, so they survive CSS rebuilds and language changes.
   */
  const BUTTON_STRATEGIES = {
    UP: {
      iconClass:   'icon-arrow-up-circle',           // 1. <svg class="icon-arrow-up-circle">
      spriteId:    '#icon-arrow-up-circle',          // 2. <use xlink:href="...#icon-arrow-up-circle">
      hashClasses: '.KtjVk.JQZcs',                   // 3. build hashes — WILL rot
      labelText:   /^(up|call|higher)$/i,            // 4. visible label
    },
    DOWN: {
      iconClass:   'icon-arrow-down-circle',
      spriteId:    '#icon-arrow-down-circle',
      hashClasses: '.KtjVk.twQq3',
      labelText:   /^(down|put|lower)$/i,
    },
  };

  /* =======================================================================
     1. UI injection
     ======================================================================= */

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const svgEl = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  };

  // The label the pill wears whenever the bot is not running. Romio reads
  // "TAP TO RUN" rather than "START" — it tells a first-time user what the
  // card is for, not just what the button does.
  const IDLE_LABEL = 'TAP TO RUN';
  const IDLE_TITLE = 'Tap to run';

  const ICONS = {
    // The brand mark: a hand-drawn double scribble ring (its two loops drift
    // slowly in opposite directions, and both spin fast while the bot runs —
    // see .nexa-ring-a / .nexa-ring-b and the *-spin groups in style.css)
    // around a navy tile with a robot face. One blue→violet→pink
    // gradient, `nexa-g`, paints every stroke; the id is safe because the
    // whole widget lives in a closed shadow root, where it cannot collide
    // with the page's own defs. tools/make-icons.js renders the same literal
    // into the extension and Android icons.
    LOGO: '<svg class="nexa-logo-svg" viewBox="0 0 100 100" aria-hidden="true">' +
      // userSpaceOnUse, not the objectBoundingBox default: the antenna stem and
      // the mouth are straight lines, and a bounding box of zero width or
      // height makes an objectBoundingBox gradient render nothing at all. It
      // also gives every shape one shared ramp instead of its own.
      '<defs><linearGradient id="nexa-g" gradientUnits="userSpaceOnUse"' +
      ' x1="10" y1="10" x2="90" y2="90">' +
      '<stop offset="0" stop-color="#60a5fa"/><stop offset=".52" stop-color="#a78bfa"/>' +
      '<stop offset="1" stop-color="#f0abfc"/></linearGradient></defs>' +
      // the scribble: two rough loops, deliberately not concentric. Each
      // loop sits in its own group: the group carries the fast "working"
      // spin, the path keeps the slow idle drift, so start/stop only pauses
      // or resumes the spin and a ring never jumps to a new angle
      '<g fill="none" stroke="url(#nexa-g)" stroke-linecap="round" stroke-linejoin="round">' +
      '<g class="nexa-ring-a-spin">' +
      '<path class="nexa-ring-a" stroke-width="2.6" opacity=".9" d="M31 13' +
      ' C19 13.6 13.2 20.4 12.6 31.4 C12 42.4 12 56.6 12.9 68' +
      ' C13.8 79.6 20.4 87.4 32 88 C44 88.6 57 88.3 68 87.4' +
      ' C79.8 86.5 87.5 79.8 88 68 C88.5 56 88.4 43 87.6 31' +
      ' C86.8 19.2 80 12.8 68 12.5 C56.4 12.2 42.6 12.4 31 13"/>' +
      '</g>' +
      '<g class="nexa-ring-b-spin">' +
      '<path class="nexa-ring-b" stroke-width="2" opacity=".55" d="M35 9.6' +
      ' C21.6 10.6 10.8 18.2 9.8 31.2 C8.8 44.2 9.1 58.2 10.3 70.2' +
      ' C11.5 82 19.2 90.6 32.2 91.1 C45.2 91.6 58.2 91.3 70.2 90.1' +
      ' C82 88.9 90.6 81.2 91.1 68.2 C91.6 55.2 91.3 42.2 90.1 30.2' +
      ' C88.9 18.2 81.2 10.2 68.2 9.7 C57 9.3 46 9.1 35 9.6"/>' +
      '</g>' +
      '</g>' +
      // the tile
      '<rect x="23" y="23" width="54" height="54" rx="17" fill="#0b1020"/>' +
      '<rect x="23" y="23" width="54" height="54" rx="17" fill="none" stroke="url(#nexa-g)" stroke-width="2.6"/>' +
      // antenna
      '<path d="M50 23 V15.5" stroke="url(#nexa-g)" stroke-width="2.6" stroke-linecap="round"/>' +
      '<circle cx="50" cy="12" r="3.4" fill="url(#nexa-g)"/>' +
      // ears
      '<rect x="17.6" y="44" width="4.4" height="13" rx="2.2" fill="url(#nexa-g)" opacity=".85"/>' +
      '<rect x="78" y="44" width="4.4" height="13" rx="2.2" fill="url(#nexa-g)" opacity=".85"/>' +
      // visor, eyes, mouth
      '<rect x="32" y="38" width="36" height="27" rx="11" fill="none" stroke="url(#nexa-g)" stroke-width="2.4"/>' +
      '<circle cx="42" cy="48.5" r="4" fill="url(#nexa-g)"/>' +
      '<circle cx="58" cy="48.5" r="4" fill="url(#nexa-g)"/>' +
      '<path d="M43.5 57.5 H56.5" stroke="url(#nexa-g)" stroke-width="2.4" stroke-linecap="round"/>' +
      '</svg>',
  };

  /**
   * One card: the scribble-ring logo, the name, a single pill that is
   * Start/Stop and the status readout in one, and a two-line caption
   * (account · W-L · why) underneath. Plus a BUY/SELL flash in the middle of
   * the screen when a trade goes in. No panels, no settings, no toggles —
   * the popup (popup.js) is where the knobs live.
   */
  function buildWidget() {
    const root = el('div');
    root.id = WIDGET_ID;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Nexa AI Bot');
    root.dataset.state = 'idle';

    const card = el('div', 'nexa-card');
    card.setAttribute('aria-label', 'Drag to move');

    const logo = el('div', 'nexa-logo');
    logo.appendChild(svgEl(ICONS.LOGO));

    const name = el('div', 'nexa-name', 'Nexa AI Bot');

    const pill = el('button', 'nexa-pill');
    pill.type = 'button';
    const dot = el('span', 'nexa-dot');
    dot.setAttribute('aria-hidden', 'true');
    const pillText = el('span', 'nexa-pill-text', IDLE_LABEL);
    pill.appendChild(dot);
    pill.appendChild(pillText);
    pill.title = IDLE_TITLE;
    pill.setAttribute('aria-label', IDLE_TITLE);

    const caption = el('div', 'nexa-caption', '…');
    caption.setAttribute('role', 'status');
    caption.setAttribute('aria-live', 'polite');

    card.appendChild(logo);
    card.appendChild(name);
    card.appendChild(pill);
    card.appendChild(caption);
    root.appendChild(card);

    // The trade flash lives outside the card: fixed, centred on the screen.
    const flash = el('div', 'nexa-flash');
    flash.hidden = true;
    flash.setAttribute('role', 'status');
    flash.setAttribute('aria-live', 'assertive');

    return { root, card, logo, name, pill, pillText, dot, caption, flash };
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function savePosition(root) {
    store.set(POSITION_KEY, { left: root.offsetLeft, top: root.offsetTop });
  }

  /** No-op until the store has loaded; called again from the ready hook. */
  function restorePosition(root) {
    const saved = store.get(POSITION_KEY);
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;
    applyPosition(root, saved.left, saved.top);
  }

  function applyPosition(root, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
    root.style.left = clamp(left, 0, maxLeft) + 'px';
    root.style.top = clamp(top, 0, maxTop) + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function makeDraggable(root, handle) {
    let pointerId = null;
    let originX = 0, originY = 0, startLeft = 0, startTop = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button')) return;

      const rect = root.getBoundingClientRect();
      applyPosition(root, rect.left, rect.top);

      pointerId = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      root.classList.add('nexa-dragging');
      handle.setPointerCapture(pointerId);

      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      applyPosition(
        root,
        startLeft + (event.clientX - originX),
        startTop + (event.clientY - originY)
      );
      event.preventDefault();
    });

    const endDrag = (event) => {
      if (event.pointerId !== pointerId) return;
      try { handle.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      root.classList.remove('nexa-dragging');
      savePosition(root);
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      if (root.style.left) applyPosition(root, root.offsetLeft, root.offsetTop);
    });
  }

  const HOST_ATTR = 'data-nexa-host';

  const ui = (() => {
    // A host node can only pre-exist after a manual re-injection (DevTools,
    // an extension reload) — its listeners belong to a dead script world, so
    // adopting it would stack a second set of handlers. Replace it instead.
    for (const stale of document.querySelectorAll('[' + HOST_ATTR + ']')) stale.remove();
    const built = buildWidget();
    // The widget lives in a CLOSED shadow root. In the light DOM every page
    // script could find it with one querySelector('#nexa-autotrade-widget'),
    // and the page's stylesheet could restyle it; inside a shadow root
    // neither the id nor the class names are reachable from the document,
    // and the page's CSS stops at the boundary. The host is a bare
    // display:contents div so it adds no box of its own to <html>.
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTR, '');
    host.style.display = 'contents';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(built.root);
    shadow.appendChild(built.flash);
    return { ...built, host, shadow };
  })();

  // For selftest.js only. This is the ISOLATED world's global — page scripts
  // cannot see it; the DevTools console has to be switched to the extension's
  // context to reach it. (In the Android app it is on the page's own window,
  // hence hidden from enumeration.)
  hiddenGlobal('__nexaWidgetRoot', ui.shadow);

  // The stylesheet is a web-accessible resource fetched into the shadow root
  // — manifest `css` injection only ever reaches the light DOM. Until it
  // lands (a few ms, before first paint on a document_start script) the
  // widget is unstyled but harmless.
  (function loadWidgetStyles() {
    const apply = (css) => {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in ui.shadow) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        ui.shadow.adoptedStyleSheets = [sheet];
      } else {
        const styleEl = document.createElement('style');
        styleEl.textContent = css;
        ui.shadow.insertBefore(styleEl, ui.shadow.firstChild);
      }
    };
    // The Android wrapper (android/) hands the stylesheet over as text before
    // this script runs: a fetch from the page's own origin is subject to the
    // site's CSP, and there is no extension origin to fetch from anyway.
    if (typeof globalThis.__nexaInlineStyle === 'string') {
      apply(globalThis.__nexaInlineStyle);
      try { delete globalThis.__nexaInlineStyle; } catch (_) { /* leave it */ }   // used once; nothing to find later
      return;
    }
    let url = null;
    try {
      url = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL('style.css') : null;
    } catch (_) { /* no extension context */ }
    if (!url) return;
    fetch(url).then((response) => response.ok ? response.text() : Promise.reject(response.status))
      .then(apply)
      .catch((error) => console.error('[AutoTrade] Widget stylesheet failed to load:', error));
  })();

  makeDraggable(ui.root, ui.card);

  /**
   * Attach the widget as soon as there is anything to attach it to.
   *
   * Running at document_start means <html> is usually present but not
   * guaranteed — inject this a fraction earlier and document.documentElement is
   * still null, which threw and killed the whole script. So mount defensively
   * and retry, rather than assuming a host exists.
   *
   * This doubles as the re-attach handler: Quotex is an SPA and can drop our
   * node, in which case the observer below calls this again.
   *
   * @returns {boolean} true once the widget is in the document
   */
  function ensureMounted() {
    if (ui.host.isConnected) return true;
    const parent = document.documentElement;
    if (!parent) return false;
    try {
      parent.appendChild(ui.host);
      return true;
    } catch (error) {
      console.error('[AutoTrade] Failed to mount widget:', error);
      return false;
    }
  }

  let mountObserver = null;
  let hostWaitTimer = null;

  function onMounted() {
    // offsetWidth is 0 until the first layout pass, and clamping against a zero
    // width would slam the widget into the corner. Restore after a frame.
    requestAnimationFrame(() => restorePosition(ui.root));

    // Watch for SPA navigation that might remove our widget
    const docElement = document.documentElement;
    if (docElement) {
      mountObserver = new MutationObserver(ensureMounted);
      mountObserver.observe(docElement, { childList: true, subtree: false });
    }
  }

  let cleanupExtras = null;   // set in section 7 once its timers exist

  function cleanupMount() {
    if (mountObserver) {
      mountObserver.disconnect();
      mountObserver = null;
    }
    if (hostWaitTimer) {
      clearInterval(hostWaitTimer);
      hostWaitTimer = null;
    }
    if (cleanupExtras) {
      cleanupExtras();
      cleanupExtras = null;
    }
  }

  if (ensureMounted()) {
    onMounted();
  } else {
    hostWaitTimer = setInterval(() => {
      if (!ensureMounted()) return;
      clearInterval(hostWaitTimer);
      hostWaitTimer = null;
      onMounted();
    }, 10);
    // Safety timeout to prevent infinite polling
    setTimeout(() => {
      if (hostWaitTimer) {
        clearInterval(hostWaitTimer);
        hostWaitTimer = null;
        console.warn('[AutoTrade] Failed to mount widget within timeout');
      }
    }, 15_000);
  }

  /**
   * The pill is the whole status vocabulary: TAP TO RUN (idle) · RUNNING ·
   * PAUSED m:ss · a short red reason for a few seconds after a refusal or a
   * self-stop, then TAP TO RUN again · LIVE? TAP AGAIN while a live-account start
   * waits for its second tap. The full message goes on the tooltip.
   * data-state on the root drives the colours: idle | running | paused |
   * error | confirm.
   */
  let pillRevertTimer = null;

  function setPill(text, state, title) {
    ui.pillText.textContent = text;
    ui.root.dataset.state = state;
    ui.pill.title = title || text;
    ui.pill.setAttribute('aria-label', title || text);
  }

  // Refusals and self-stops, compressed to fit a 100px pill.
  const SHORT_REASON = [
    [/button not found/i, 'NO BUTTONS'],
    [/no price feed/i, 'NO FEED'],
    [/identifying chart/i, 'CHART? RETRY'],
    [/chart not identified/i, 'NO CHART'],
    [/daily loss cap/i, 'DAILY CAP'],
    [/daily profit target/i, 'TARGET HIT'],
    [/loading/i, 'LOADING'],
    [/trade limit/i, 'LIMIT'],
    [/clicks not registering/i, 'NO CLICKS'],
    [/not a trading page/i, 'NOT TRADE PAGE'],
    [/live account blocked/i, 'LIVE BLOCKED'],
    [/account changed/i, 'ACCOUNT?'],
    [/losses in a row/i, 'LOSSES'],
    [/extension broken/i, 'BROKEN'],
    [/platform alarm/i, 'ALARM'],
  ];

  function shortReason(message) {
    for (const [pattern, label] of SHORT_REASON) if (pattern.test(message)) return label;
    return message.replace(/^cannot start:\s*/i, '').toUpperCase().slice(0, 14);
  }

  /** The single status entry point the bot logic calls; maps onto the pill. */
  function setStatus(message, state) {
    if (pillRevertTimer) {
      clearTimeout(pillRevertTimer);
      pillRevertTimer = null;
    }
    if (state === 'running') {
      const paused = bot.pausedUntil > Date.now();
      setPill(paused ? 'PAUSED ' + mmss(bot.pausedUntil - Date.now()) : 'RUNNING',
        paused ? 'paused' : 'running', message);
      return;
    }
    if (state === 'stopped' && message && message !== 'Stopped') {
      setPill(shortReason(message), 'error', message);
      pillRevertTimer = setTimeout(() => {
        pillRevertTimer = null;
        setPill(IDLE_LABEL, 'idle', IDLE_TITLE);
      }, 4_000);
      return;
    }
    setPill(IDLE_LABEL, 'idle', IDLE_TITLE);
  }

  function setCaption(text) {
    ui.caption.textContent = text;
  }

  // The last LOG_KEEP lines, for the popup's Log tab and its export. On a
  // phone the console is out of reach (the release app allows no remote
  // inspection), so the bot keeps its own tail.
  const LOG_KEEP = 300;
  const logLines = [];   // [{ n, t, text }], oldest first
  let logSeq = 0;
  const logText = (value) => {
    if (value instanceof Error) return value.message;
    if (typeof value === 'object' && value !== null) {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  };

  const log = (...args) => {
    console.log('%c[AutoTrade]', 'color:#22c55e;font-weight:bold', ...args);
    logLines.push({ n: ++logSeq, t: Date.now(), text: args.map(logText).join(' ') });
    if (logLines.length > LOG_KEEP) logLines.splice(0, logLines.length - LOG_KEEP);
  };

  /**
   * What the page — and, through the User-Agent, the server — can tell
   * about where the site is running. Logged first thing, so the Log tab
   * answers "does Quotex see a PC or a phone?" at a glance: the UA and
   * platform are what the server is told, the screen, touch points and GPU
   * are what a script on the page can see.
   */
  function environmentLine() {
    const n = navigator;
    let gpu = 'n/a';
    try {
      if (typeof WebGLRenderingContext === 'function') {
        const gl = document.createElement('canvas').getContext('webgl');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        if (gl && info) gpu = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      }
    } catch (_) { /* no WebGL here */ }
    const hints = n.userAgentData
      ? 'mobile=' + n.userAgentData.mobile + ' platform=' + n.userAgentData.platform +
        ' brands=' + (Array.isArray(n.userAgentData.brands)
          ? n.userAgentData.brands.map((entry) => entry.brand + ' ' + entry.version).join(', ') : '?')
      : 'none';
    return 'Environment: UA "' + n.userAgent + '" | platform ' + n.platform +
      ' | client hints ' + hints +
      ' | screen ' + screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) +
      ' | touch points ' + (n.maxTouchPoints || 0) + ' | GPU ' + gpu +
      ' | running in ' + (typeof globalThis.__nexaNativeTap === 'function' ? 'the Android app' : 'the Chrome extension');
  }

  // The pure modules load ahead of this file from the same manifest entry.
  // If one is missing, the sections below would throw a ReferenceError
  // half-way through the script — AFTER the widget was mounted but BEFORE
  // its buttons were wired, leaving a widget whose Start does nothing and an
  // error only the console ever saw. Say so on the widget itself and stop.
  {
    const missing = [
      ['NexaStrategy', typeof NexaStrategy], ['NexaAutopilot', typeof NexaAutopilot],
      ['NexaHorizons', typeof NexaHorizons],
    ].filter(([, type]) => type === 'undefined').map(([name]) => name);
    if (missing.length > 0) {
      console.error('[AutoTrade] Missing module(s): ' + missing.join(', ') +
        ' — the extension files are incomplete. Reinstall it.');
      setPill('BROKEN', 'error', 'Extension broken: ' + missing.join(', ') + ' missing — reinstall');
      setCaption('reinstall the extension');
      ui.pill.disabled = true;
      return;
    }
  }

  /* =======================================================================
     2. Price feed
     ======================================================================= */

  /** "AUD/NZD (OTC)" and "AUDNZD_otc" both reduce to "AUDNZDOTC". */
  function normalizeSymbol(value) {
    return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  const symbolLock = { key: null, pendingKey: null, checkedAt: 0, node: null };

  /**
   * Which chart is actually open? Read the asset title out of the page header
   * and match it against the symbols currently streaming.
   *
   * Matching against the live symbol set (rather than a hardcoded pattern)
   * means this works for FX pairs, OTC pairs, stocks and commodities alike —
   * whatever Quotex calls it, the label and the symbol normalize to the same
   * string. The topmost match on screen is the header title; identical labels
   * further down belong to the asset picker.
   *
   * @returns {string|null} normalized symbol key, or null if undetermined
   */
  function activeChartKey() {
    if (feed.seenSymbols.size === 0) return null;

    const streaming = new Map();
    for (const sym of feed.seenSymbols) streaming.set(normalizeSymbol(sym), sym);

    // Fast path: re-read the node the last full scan identified as the
    // header. The full scan below forces a layout pass per candidate across
    // the whole SPA every SYMBOL_RECHECK_MS — jank the page can feel — while
    // this costs a single rect. A chart switch that reuses the node just
    // changes its text, which this read picks up; a node that was swapped
    // out, hidden, or no longer names a streaming symbol falls through to a
    // fresh scan.
    const cached = symbolLock.node;
    if (cached) {
      if (cached.isConnected) {
        const text = shallowText(cached);
        const key = text && text.length <= 32 ? normalizeSymbol(text) : '';
        if (key && streaming.has(key)) {
          const rect = cached.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0) return key;
        }
      }
      symbolLock.node = null;
    }

    let best = null;
    let bestNode = null;
    let bestTop = Infinity;

    for (const node of document.querySelectorAll('span, button, div, h1, h2')) {
      const text = shallowText(node);
      if (!text || text.length > 32) continue;

      const key = normalizeSymbol(text);
      if (!key || !streaming.has(key)) continue;        // '' would match punctuation nodes
      if (node.closest('#' + WIDGET_ID)) continue;      // never match our own UI

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < 0) continue;                       // scrolled-away watchlist rows

      // Topmost wins (the header sits above the watchlist). Between labels on
      // the same row, the longer key is the more specific one — "EURUSDOTC"
      // beats the "EURUSD" nested inside it.
      if (rect.top < bestTop - 4 ||
          (Math.abs(rect.top - bestTop) <= 4 && best !== null && key.length > best.length)) {
        bestTop = Math.min(bestTop, rect.top);
        best = key;
        bestNode = node;
      } else if (best === null) {
        bestTop = rect.top;
        best = key;
        bestNode = node;
      }
    }
    symbolLock.node = bestNode;
    return best;
  }

  /**
   * Text of a node that holds a label rather than a section of the page.
   *
   * A leaf is the common case, but Quotex splits the header title across
   * spans ("EUR/USD" + "(OTC)"), and requiring a leaf missed it entirely —
   * which left the bot unable to identify the chart. Shallow subtrees are
   * therefore allowed, while anything deeper is skipped: reading textContent
   * off a page-level container is both meaningless and expensive.
   *
   * @returns {string|null} trimmed text, or null if the node is not a label
   */
  function shallowText(node) {
    if (node.children.length > 3) return null;
    for (const child of node.children) {
      if (child.children.length !== 0) return null;
    }
    const text = node.textContent.trim();
    return text || null;
  }

  /**
   * The symbol the bot is allowed to act on. Re-reads the DOM at most every
   * SYMBOL_RECHECK_MS. Switching charts is a deliberate reset — unlike a
   * foreign tick, which is simply ignored.
   *
   * @returns {string|null} normalized key, or null while still undetermined
   */
  function lockedSymbol() {
    if (CONFIG.SYMBOL) return normalizeSymbol(CONFIG.SYMBOL);

    const now = Date.now();
    if (now - symbolLock.checkedAt >= CONFIG.SYMBOL_RECHECK_MS) {
      symbolLock.checkedAt = now;
      const key = activeChartKey();
      // Require the same reading on two consecutive checks before acting on
      // it — a transiently open asset picker can win the topmost-match race
      // for one cycle, and flapping the lock wipes the history.
      if (key && key !== symbolLock.key) {
        if (key === symbolLock.pendingKey) {
          if (symbolLock.key) log('Chart switched:', symbolLock.key, '->', key);
          else log('Locked to chart:', key);
          symbolLock.key = key;
          symbolLock.pendingKey = null;
          // Whatever streamed before the (re)lock belongs to another pair;
          // never let it bleed into the new history — the pending buffer
          // included, or tick() would drain the old pair into the new run.
          // The scanner has been buffering the NEW pair all along, so the
          // fresh history is seeded from it instead of starting cold.
          if (normalizeSymbol(feed.symbol || '') !== key) {
            bot.history.length = 0;
            for (const sample of scannerSeed(key)) bot.history.push(sample);
            feed.pending.length = 0;
            feed.price = null;
            feed.symbol = null;
            feed.lastResetAt = Date.now();
            if (bot.history.length > 0) {
              log('Warm start: seeded', bot.history.length, 'samples from the scanner');
            }
          }
        } else {
          symbolLock.pendingKey = key;
        }
      } else {
        symbolLock.pendingKey = null;
      }
    }

    if (symbolLock.key) return symbolLock.key;
    // Header unreadable so far. If exactly one symbol is streaming it must be
    // the open chart; with several on the wire, refuse to guess — trading a
    // chart against another pair's statistics is worse than not starting.
    if (feed.seenSymbols.size === 1) {
      return normalizeSymbol(feed.seenSymbols.values().next().value);
    }
    return null;
  }

  const feed = {
    price: null,
    symbol: null,
    receivedAt: 0,
    pending: [],         // accepted quotes not yet drained into bot.history
    lastResetAt: 0,      // last gap / socket drop / chart switch — gates trading
    balance: null,
    socketOpen: false,
    seenSymbols: new Set(),
  };

  // seenSymbols only ever grew — every asset that has streamed once stayed
  // forever. Insertion order approximates recency, so on overflow the entry
  // most likely to be stale goes first; an evicted-but-live symbol re-adds
  // itself on its next quote within a second.
  const MAX_SEEN_SYMBOLS = 64;

  // Feed health telemetry, surfaced on the stats panel.
  const health = {
    latencyEma: null,   // server timestamp -> arrival, seconds (EMA)
    gaps: 0,            // history restarts due to receive gaps
    drops: 0,           // socket close events seen
  };

  function createBridgeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const bridgeNonce = createBridgeNonce();
  let bridgeAlive = false;   // set by the first valid message from inject.js

  /** One [symbol, ts, price] row of a quotes batch. */
  function validQuoteRow(row) {
    return Array.isArray(row) && row.length === 3 &&
      typeof row[0] === 'string' && row[0].length >= 1 && row[0].length <= 64 &&
      Number.isFinite(row[1]) && Number.isFinite(row[2]) && row[2] > 0;
  }

  const nullOrFinite = (value) => value == null || Number.isFinite(value);

  function validBridgeMessage(data) {
    if (!data || data.__nexa !== true || data.nonce !== bridgeNonce) return false;
    switch (data.kind) {
      case 'quotes':
        // inject.js forwards a whole quotes/stream frame as one batch. Rows
        // are validated individually on consumption (a bad row is skipped,
        // not the frame); here it only has to be a bounded array.
        return Array.isArray(data.rows) && data.rows.length >= 1 && data.rows.length <= 1000;
      case 'balance':
        return (data.live === null || Number.isFinite(data.live)) &&
          (data.demo === null || Number.isFinite(data.demo));
      case 'trade-open':
        return typeof data.id === 'string' && data.id.length >= 1 && data.id.length <= 64 &&
          typeof data.asset === 'string' && data.asset.length >= 1 && data.asset.length <= 64 &&
          Number.isFinite(data.amount) && data.amount > 0 && Number.isFinite(data.openPrice) &&
          data.openPrice > 0 && (data.command === 0 || data.command === 1) &&
          typeof data.isDemo === 'boolean' &&
          // Server-side payout and contract close time. Both were already
          // forwarded and silently ignored; they now cross-check the panel
          // readings (see attachOrder). Optional, so an older inject.js
          // that omits them still confirms trades.
          nullOrFinite(data.percentProfit) && nullOrFinite(data.closeTimestamp);
      case 'trade-close':
        return typeof data.id === 'string' && data.id.length >= 1 && data.id.length <= 64 &&
          typeof data.asset === 'string' && data.asset.length >= 1 && data.asset.length <= 64 &&
          Number.isFinite(data.profit) && Number.isFinite(data.openPrice) &&
          Number.isFinite(data.closePrice) && typeof data.isDemo === 'boolean';
      case 'socket':
        return data.state === 'open' || data.state === 'closed';
      default:
        return false;
    }
  }

  /** One validated quote off the wire. `now` is the frame's arrival time. */
  function onQuote(symbol, ts, price, now) {
    if (!feed.seenSymbols.has(symbol)) {
      if (feed.seenSymbols.size >= MAX_SEEN_SYMBOLS) {
        feed.seenSymbols.delete(feed.seenSymbols.values().next().value);
      }
      feed.seenSymbols.add(symbol);
    }

    // Journal and scan EVERY streaming symbol, not just the locked one —
    // the backtester compares assets, and the watchlist streams for free.
    recordTick(symbol, ts, now, price);
    scannerRecord(symbol, now, price);

    // Ignore every asset except the one whose chart is open. Previously a
    // foreign tick wiped the history, so it never reached the lookback
    // length and no signal could ever fire.
    const want = lockedSymbol();
    if (want === null) {
      // No lock yet AND more than one asset on the wire: accepting
      // whichever arrived last mixed several pairs into feed.price /
      // feed.symbol, so the pre-start readout (and readCurrentPrice)
      // described a chart nobody had opened. The scanner above already
      // buffered this tick; just don't promote it.
      if (feed.seenSymbols.size > 1) return;
    } else if (normalizeSymbol(symbol) !== want) {
      return;
    }

    feed.price = price;
    feed.symbol = symbol;
    feed.receivedAt = now;
    feed.socketOpen = true;   // quotes arriving means the socket is alive

    // Feed latency: server stamp vs arrival. The stamp's unit is
    // heuristic (epoch seconds vs ms) — anything not within a day of
    // now after normalization is ignored rather than trusted.
    const tsMs = ts > 1e11 ? ts : ts * 1000;
    if (Math.abs(now - tsMs) < 86_400_000) {
      const latency = (now - tsMs) / 1000;
      health.latencyEma = health.latencyEma === null
        ? latency
        : health.latencyEma * 0.9 + latency * 0.1;
    }

    // Buffer EVERY accepted quote for tick() to drain. The loop runs at
    // 1Hz while the feed ticks at ~2Hz — sampling only the latest price
    // per tick threw away half the series and could skip the exact
    // sample a momentum crossover fires on. Arrival time is captured
    // here, not at drain time, so a throttled background tab still
    // records accurate spacing; the server timestamp rides along for
    // telemetry. Capped at MAX_HISTORY: anything older would be shifted
    // straight out of the history it feeds.
    if (bot.running) {
      feed.pending.push({ t: now, ts, price });
      if (feed.pending.length > CONFIG.MAX_HISTORY) feed.pending.shift();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!validBridgeMessage(data)) return;
    bridgeAlive = true;

    switch (data.kind) {
      case 'quotes': {
        const now = Date.now();
        for (const row of data.rows) {
          if (validQuoteRow(row)) onQuote(row[0], row[1], row[2], now);
        }
        break;
      }

      case 'balance':
        feed.balance = { live: data.live, demo: data.demo };
        break;

      case 'trade-open':
        attachOrder(data);
        break;

      case 'trade-close':
        recordResult(data);
        break;

      case 'socket':
        feed.socketOpen = data.state === 'open';
        if (data.state === 'closed') {
          feed.lastResetAt = Date.now();
          health.drops += 1;
          log('Quotex socket closed — feed will go stale');
        }
        break;
    }
  });

  // Ask inject.js to replay the socket/balance state it saw before we loaded.
  // Both scripts run at document_start and their relative order is not
  // guaranteed, so retry briefly rather than firing once and hoping.
  (function sayHello(attempt) {
    // Stop once the bridge has actually produced something, not merely when a
    // balance frame happens to have arrived. inject.js drops every quote
    // until it has the nonce, so if all the hellos fired before its listener
    // was registered the extension stayed silently dead forever. 40 attempts
    // over ~16s covers a cold start; bridgeAlive ends it on the first real
    // message, which is normally the first or second try.
    if (attempt > 40 || bridgeAlive) return;
    // location.origin can be the string "null" this early, which postMessage
    // rejects. Same window on both ends, so '*' is a safe fallback.
    const origin = window.location.origin;
    try {
      window.postMessage({ __nexa: true, kind: 'hello', nonce: bridgeNonce },
                         origin && origin !== 'null' ? origin : '*');
    } catch (_) { /* retry on the next attempt */ }
    setTimeout(() => sayHello(attempt + 1), 400);
  })(0);

  /**
   * Latest price from the WebSocket feed.
   * @returns {number|null} null if no quote yet, or the feed has gone stale.
   */
  function readCurrentPrice() {
    if (feed.price === null) return null;
    if (Date.now() - feed.receivedAt > CONFIG.QUOTE_STALE_MS) return null;
    return feed.price;
  }

  /* =======================================================================
     2b. Tick recorder — IndexedDB journal + JSON export

     Every validated quote (ALL streaming symbols, not just the locked one)
     is journaled so tools/backtest.js has real data to calibrate against —
     the current thresholds were tuned on six minutes of one pair, which is
     statistically nothing. Settled bot trades are journaled too: real
     outcomes to compare with simulated labels. Storage is page-origin
     IndexedDB, FIFO-capped at REC_CAP rows. Everything here is best-effort
     and must never break trading.
     ======================================================================= */

  const REC_DB_NAME = 'nexa-ticks';
  const REC_CAP = 500_000;        // ≈ several hours of an active multi-asset feed
  const REC_FLUSH_MS = 5_000;
  const REC_BUFFER_MAX = 5_000;   // hard cap in case the DB never opens
  const REC_BYTES_PER_ROW = 120;  // rough on-disk cost of one journaled tick

  const recorder = {
    db: null,
    // Follows CONFIG.RECORD_TICKS (the popup persists it). OFF for a fresh
    // install: at ~100 rows/s across a watchlist the journal reaches its
    // 500k-row cap (tens of MB in the profile) within hours, and a passive
    // default that writes that much deserves an explicit opt-in.
    enabled: CONFIG.RECORD_TICKS,
    buffer: [],        // ticks awaiting the next flush
    count: 0,          // approximate rows in the ticks store
    exporting: false,
    flushTimer: null,  // cleared on a real unload
  };

  function openRecorder() {
    let request;
    try {
      request = indexedDB.open(REC_DB_NAME, 1);
    } catch (error) {
      log('Tick recorder unavailable:', error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('ticks')) {
        db.createObjectStore('ticks', { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('trades')) {
        db.createObjectStore('trades', { autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      recorder.db = request.result;
      const countReq = recorder.db.transaction('ticks', 'readonly')
        .objectStore('ticks').count();
      countReq.onsuccess = () => {
        recorder.count += countReq.result;
      };
      recorder.flushTimer = setInterval(flushRecorder, REC_FLUSH_MS);
    };
    request.onerror = () => {
      console.debug('[AutoTrade] Tick recorder failed to open:', request.error);
    };
  }

  function recordTick(symbol, ts, t, price) {
    if (!recorder.enabled) return;
    recorder.buffer.push({ s: symbol, ts, t, p: price });
    if (recorder.buffer.length >= 400) flushRecorder();
    // flushRecorder is a no-op until the DB opens — never hoard unbounded.
    if (recorder.buffer.length > REC_BUFFER_MAX) {
      recorder.buffer.splice(0, recorder.buffer.length - REC_BUFFER_MAX);
    }
  }

  function flushRecorder() {
    if (!recorder.db || recorder.buffer.length === 0) return;
    const rows = recorder.buffer.splice(0);
    try {
      const txn = recorder.db.transaction('ticks', 'readwrite');
      const store = txn.objectStore('ticks');
      for (const row of rows) store.add(row);
      txn.oncomplete = () => {
        recorder.count += rows.length;
        if (recorder.count > REC_CAP * 1.05) pruneRecorder();
      };
      txn.onerror = () => console.debug('[AutoTrade] Tick flush failed:', txn.error);
    } catch (error) {
      console.debug('[AutoTrade] Tick flush failed:', error);
    }
  }

  /** FIFO cap. autoIncrement keys are chronological, so a cursor from the
      start of the store walks the oldest rows first. */
  function pruneRecorder() {
    const excess = recorder.count - REC_CAP;
    if (excess <= 0 || !recorder.db) return;
    try {
      const txn = recorder.db.transaction('ticks', 'readwrite');
      let removed = 0;
      const cursorReq = txn.objectStore('ticks').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || removed >= excess) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
      txn.oncomplete = () => { recorder.count -= removed; };
    } catch (error) {
      console.debug('[AutoTrade] Tick prune failed:', error);
    }
  }

  function recordTradeRow(row) {
    // Settled trades are journaled even while tick recording is paused —
    // real outcomes are the scarcest data the backtester gets.
    if (!recorder.db) return;
    try {
      recorder.db.transaction('trades', 'readwrite').objectStore('trades').add(row);
    } catch (error) {
      console.debug('[AutoTrade] Trade journal failed:', error);
    }
  }

  /** Read a whole store in keyed getAll batches — a cursor walk over half a
      million rows takes tens of seconds; this takes a couple. */
  function readAllRows(storeName) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const CHUNK = 50_000;
      const step = (afterKey) => {
        let txn;
        try {
          txn = recorder.db.transaction(storeName, 'readonly');
        } catch (error) {
          reject(error);
          return;
        }
        const store = txn.objectStore(storeName);
        const range = afterKey === undefined
          ? undefined
          : IDBKeyRange.lowerBound(afterKey, true);
        const valReq = store.getAll(range, CHUNK);
        const keyReq = store.getAllKeys(range, CHUNK);
        let vals = null;
        let keys = null;
        const maybeFinish = () => {
          if (vals === null || keys === null) return;
          for (const value of vals) rows.push(value);
          if (keys.length < CHUNK) resolve(rows);
          else step(keys[keys.length - 1]);
        };
        valReq.onsuccess = () => { vals = valReq.result; maybeFinish(); };
        keyReq.onsuccess = () => { keys = keyReq.result; maybeFinish(); };
        valReq.onerror = () => reject(valReq.error);
        keyReq.onerror = () => reject(keyReq.error);
      };
      step(undefined);
    });
  }

  async function exportRecording() {
    if (!recorder.db) {
      log('Nothing to export — the tick recorder never opened.');
      return;
    }
    if (recorder.exporting) return;
    recorder.exporting = true;
    try {
      // A readonly transaction created after this readwrite one is queued
      // behind it, so the read below sees these rows.
      flushRecorder();
      const [ticks, trades] = await Promise.all([
        readAllRows('ticks'),
        readAllRows('trades'),
      ]);
      const payload = {
        format: 'nexa-ticks-v1',
        exportedAt: new Date().toISOString(),
        ticks: ticks.map((row) => [row.s, row.ts, row.t, row.p]),
        trades,
      };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      downloadBlob(blob, 'nexa-ticks-' + fileStamp() + '.json');
      log('Exported', ticks.length, 'ticks +', trades.length, 'trades.',
          'Analyze with: node tools/backtest.js <file>');
    } catch (error) {
      log('Export failed:', error);
    } finally {
      recorder.exporting = false;
    }
  }

  function fileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  function downloadBlob(blob, filename) {
    // The Android wrapper has no download manager for blob: URLs; it takes
    // the text and writes the file into the phone's Downloads folder.
    if (typeof globalThis.__nexaSaveFile === 'function') {
      blob.text().then((text) => globalThis.__nexaSaveFile(filename, text))
        .catch((error) => log('Export failed:', error));
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** The settled-trade journal as CSV, for spreadsheets. */
  async function exportTradesCsv() {
    if (!recorder.db) {
      log('No trade journal yet — the recorder never opened.');
      return;
    }
    try {
      const rows = await readAllRows('trades');
      if (rows.length === 0) {
        log('No settled trades recorded yet.');
        return;
      }
      const header = 'time,symbol,direction,clickPrice,openPrice,closePrice,' +
        'amount,profit,payoutPct,expirySec,slippage,mode,variant,reason,serverPayoutPct,serverExpirySec';
      const lines = rows.map((row) => [
        new Date(row.t).toISOString(), row.sym, row.dir, row.clickPrice,
        row.openPrice, row.closePrice, row.amount, row.profit, row.payout,
        row.expiry, row.slippage, row.dry ? 'dry' : 'real', row.variant,
        row.reason, row.serverPayout, row.serverExpiry,
      ].map((v) => v === null || v === undefined ? '' : String(v)).join(','));
      downloadBlob(new Blob([header + '\n' + lines.join('\n')], { type: 'text/csv' }),
        'nexa-trades-' + fileStamp() + '.csv');
      log('Exported', rows.length, 'trades to CSV.');
    } catch (error) {
      log('CSV export failed:', error);
    }
  }

  /* =======================================================================
     2c. Multi-asset scanner

     quotes/stream already carries every subscribed asset, so a small price
     buffer is kept per symbol. Two uses: the stats panel ranks assets by
     trend quality (efficiency ratio) to show where the strongest setup is
     right now, and a chart switch seeds the fresh history from the buffer
     instead of starting cold (instant warm start).
     ======================================================================= */

  const scanner = new Map();   // normalized key -> {sym, samples: [{t, price}], htf}
  const SCANNER_KEEP = 120;    // ~1 minute of ~2Hz ticks per symbol
  const HTF_KEEP = 240;        // closed candles per symbol (4 hours at 1m)

  function scannerRecord(symbol, t, price) {
    const key = normalizeSymbol(symbol);
    if (!key) return;
    let entry = scanner.get(key);
    if (!entry) {
      if (scanner.size >= MAX_SEEN_SYMBOLS) {
        // Oldest-first eviction, but never the chart we are actually trading:
        // it is usually the first key inserted, so a busy watchlist evicted
        // exactly the buffer the warm start and the ER ranking need.
        for (const candidate of scanner.keys()) {
          if (candidate !== symbolLock.key) { scanner.delete(candidate); break; }
        }
      }
      entry = { sym: symbol, samples: [], htf: null };
      scanner.set(key, entry);
    }
    entry.samples.push({ t, price });
    if (entry.samples.length > SCANNER_KEEP) entry.samples.shift();
    // The candle series for the HTF filter. Candles survive feed gaps and
    // chart switches (they are per symbol and coarse enough not to care);
    // a period change from the popup starts the series over.
    const periodMs = CONFIG.HTF_CANDLE_SEC * 1000;
    if (entry.htf === null || entry.htf.periodMs !== periodMs) {
      entry.htf = NexaCandles.createSeries(periodMs, HTF_KEEP);
    }
    NexaCandles.push(entry.htf, t, price);
  }

  /** The higher-timeframe read for the locked chart (see CONFIG.HTF_FILTER). */
  function htfView() {
    const entry = symbolLock.key ? scanner.get(symbolLock.key) : null;
    return NexaCandles.bias(entry ? entry.htf : null, {
      fast: CONFIG.HTF_EMA_FAST,
      slow: CONFIG.HTF_EMA_SLOW,
      rsiPeriod: CONFIG.HTF_RSI_PERIOD,
      rsiBlock: CONFIG.HTF_RSI_BLOCK,
    });
  }

  /** "1m ↑ rsi 58" / "1m warming 7/22" for the status readout. */
  function htfLabel(view) {
    const period = CONFIG.HTF_CANDLE_SEC % 60 === 0
      ? (CONFIG.HTF_CANDLE_SEC / 60) + 'm' : CONFIG.HTF_CANDLE_SEC + 's';
    if (!view.warm) return period + ' warming ' + view.candles + '/' + view.needed;
    return period + ' ' + (view.dir === 'UP' ? '↑' : view.dir === 'DOWN' ? '↓' : '→') +
      (view.rsi === null ? '' : ' rsi ' + Math.round(view.rsi));
  }

  /** Gap-free recent samples for a symbol — safe to seed a history from. */
  function scannerSeed(key) {
    const entry = scanner.get(key);
    if (!entry) return [];
    return NexaAutopilot.gapFreeSuffix(
      entry.samples, CONFIG.MAX_SAMPLE_GAP_MS, CONFIG.MAX_HISTORY);
  }

  /** Top `count` symbols by trend quality right now. */
  function scannerTop(count) {
    const rows = [];
    for (const entry of scanner.values()) {
      const samples = NexaAutopilot.gapFreeSuffix(
        entry.samples, CONFIG.MAX_SAMPLE_GAP_MS, SCANNER_KEEP);
      if (samples.length < 31) continue;
      const er = NexaAutopilot.efficiencyRatio(samples, 30);
      if (er === null) continue;
      const last = samples[samples.length - 1].price;
      const back = samples[Math.max(0, samples.length - 11)].price;
      rows.push({
        sym: entry.sym,
        er,
        dir: last > back ? '↑' : last < back ? '↓' : '→',
      });
    }
    rows.sort((a, b) => b.er - a.er);
    return rows.slice(0, count);
  }

  /* =======================================================================
     3. Element resolution
     ======================================================================= */

  /** A node is usable only if it is attached, laid out, and not hidden. */
  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' &&
           style.display !== 'none' &&
           style.opacity !== '0';
  }

  // --- tier 1: semantic icon class on the <svg> ---
  function byIconClass(iconClass) {
    for (const svg of document.querySelectorAll('svg.' + iconClass)) {
      const button = svg.closest('button');
      if (isVisible(button)) return { button, via: 'svg.' + iconClass };
    }
    return null;
  }

  // --- tier 2: sprite id on the <use> element ---
  // The attribute is xlink:href, which needs getAttribute() rather than a
  // plain CSS attribute selector because of the XML namespace.
  function bySpriteId(spriteId) {
    for (const use of document.querySelectorAll('use')) {
      const href = use.getAttribute('xlink:href') || use.getAttribute('href') || '';
      if (!href.endsWith(spriteId)) continue;
      const button = use.closest('button');
      if (isVisible(button)) return { button, via: 'use[href$="' + spriteId + '"]' };
    }
    return null;
  }

  // --- tier 3: the build-hash classes (expected to rot on redeploy) ---
  function byHashClasses(selector) {
    for (const button of document.querySelectorAll('button' + selector)) {
      if (isVisible(button)) return { button, via: selector + ' (hashed — may rot)' };
    }
    return null;
  }

  // --- tier 4: visible label text (breaks if the UI language changes) ---
  function byLabelText(pattern) {
    for (const button of document.querySelectorAll('button')) {
      if (button.closest('#' + WIDGET_ID)) continue;   // never our own Start/Stop
      const span = button.querySelector('span');
      const text = ((span && span.textContent) || button.textContent || '').trim();
      if (pattern.test(text) && isVisible(button)) {
        return { button, via: 'label "' + text + '"' };
      }
    }
    return null;
  }

  const buttonCache = { UP: null, DOWN: null };

  /**
   * Resolve a trade button, trying each strategy in order. Results are cached
   * but re-validated every call, so a re-render that swaps the node out is
   * picked up automatically.
   *
   * @param {'UP'|'DOWN'} direction
   * @returns {{button: HTMLButtonElement, via: string}|null}
   */
  function findTradeButton(direction) {
    const cached = buttonCache[direction];
    if (cached && isVisible(cached.button)) return cached;

    const strategy = BUTTON_STRATEGIES[direction];
    const result =
      byIconClass(strategy.iconClass) ||
      bySpriteId(strategy.spriteId) ||
      byHashClasses(strategy.hashClasses) ||
      byLabelText(strategy.labelText);

    buttonCache[direction] = result;
    return result;
  }

  /* =======================================================================
     3b. Trade panel readout — payout % and expiry, best-effort

     A binary option's expected value depends on the payout as much as on
     the signal, and its forecast horizon IS the expiry — so both are read
     from the trade panel next to the Up/Down buttons. Heuristic by nature,
     and deliberately fail-safe: an unreadable payout stands the filter
     aside (loudly), an unreadable duration falls back to CONFIG.EXPIRY_SEC.
     ======================================================================= */

  const panel = {
    payoutPct: null,
    expirySec: null,
    payoutNode: null,
    expiryNode: null,
    stakeNode: null,
    checkedAt: 0,
    misses: 0,             // consecutive scans that found nothing → back off
    warnedUnreadable: false,
    lastLoggedPayout: null,
    payoutReadAt: 0,       // last scan that actually resolved a payout
    expiryReadAt: 0,       // ...and a duration
    payoutUnknownSince: 0, // when the payout became unreadable (0 = it is known)
    payoutProbeAt: 0,      // last probe trade allowed to learn the payout
  };

  // A readout that briefly can't be resolved (the node re-rendered, the UP
  // button was momentarily invisible, the duration scrolled behind a popup)
  // used to drop straight to null for that scan. For the expiry that is
  // destructive: statsStorageKey() is keyed on it, so one unreadable scan
  // swapped the auto scoreboard to a different bucket and wiped the pending
  // virtual trades and the z-distribution — the learner could never
  // accumulate. Hold the last good reading for a bounded window instead.
  const PANEL_STICKY_MS = 60_000;

  const PAYOUT_RE = /^\+?(\d{1,3})\s?%$/;
  const DURATION_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  // Nodes proven NOT to be the duration readout. DURATION_RE cannot tell a
  // duration from a wall clock: "14:35" parses as 14m35s = 875s, inside the
  // accepted range, so any HH:MM clock in the panel column was a valid
  // "expiry" — and it retuned the horizon, the virtual settlement time and
  // the scoreboard bucket. A duration SETTING holds still until the user
  // changes it, and then it is one change; a clock or a countdown changes
  // BY ITSELF, again and again. The tracker below counts value changes on
  // the node between scans and blacklists any node that changed twice
  // inside CLOCK_WINDOW_MS — an HH:MM clock does that in two minutes, an
  // MM:SS countdown in two scans. checkServerExpiry adds nodes the server
  // contradicted. A clock stays a clock, so distrust lasts the session (a
  // 10-minute box let the clock back in, and re-detecting it cost another
  // two minutes of wrong expiries). The false-positive case — a user who
  // really did change the duration twice in two minutes — is undone by the
  // server: when a confirmed order's real remaining time matches what a
  // distrusted node shows, that node is the setting after all and is
  // trusted again (see reinstateExpiryNode).
  const distrustedExpiryNodes = new WeakMap();   // node -> distrusted until (ms)
  const distrustedList = [];                     // the same nodes, iterable, newest last
  const CLOCK_WINDOW_MS = 130_000;
  const CLOCK_DISTRUST_MS = 6 * 60 * 60_000;
  const SERVER_DISTRUST_MS = 6 * 60 * 60_000;
  const expiryTrack = { node: null, value: null, changedAt: 0, changes: 0 };

  function distrustExpiryNode(node, forMs) {
    if (!node) return;
    distrustedExpiryNodes.set(node, Date.now() + (forMs || CLOCK_DISTRUST_MS));
    if (!distrustedList.includes(node)) {
      distrustedList.push(node);
      if (distrustedList.length > 8) distrustedList.shift();
    }
    if (expiryTrack.node === node) expiryTrack.node = null;
  }

  function isDistrustedExpiryNode(node, now) {
    const until = distrustedExpiryNodes.get(node);
    if (until === undefined) return false;
    if (now < until) return true;
    distrustedExpiryNodes.delete(node);
    return false;
  }

  /**
   * The server said a contract lasts `seconds`. If a distrusted node shows
   * exactly that, it was the duration setting all along (the user changed it
   * twice, or a stale server check hit the right node) — trust it again and
   * adopt its reading. Returns the reinstated node or null.
   */
  function reinstateExpiryNode(seconds, tolerance, now) {
    for (let index = distrustedList.length - 1; index >= 0; index -= 1) {
      const node = distrustedList[index];
      if (!node.isConnected) { distrustedList.splice(index, 1); continue; }
      const text = panelText(node);
      const shown = text === null ? null : parseDuration(text);
      if (shown === null || Math.abs(shown - seconds) > tolerance) continue;
      distrustedExpiryNodes.delete(node);
      distrustedList.splice(index, 1);
      panel.expiryNode = node;
      panel.expirySec = shown;
      panel.expiryReadAt = now;
      log('Expiry: the server\'s ' + seconds + 's matches the "' + text +
          '" node that was distrusted — trusting it again.');
      return node;
    }
    return null;
  }

  /**
   * True once the same node's parsed duration has changed twice within
   * CLOCK_WINDOW_MS — a value that keeps changing on its own is a clock or a
   * countdown, not a setting.
   */
  function movesLikeAClock(node, seconds, now) {
    const track = expiryTrack;
    if (track.node !== node) {
      track.node = node;
      track.value = seconds;
      track.changedAt = 0;
      track.changes = 0;
      return false;
    }
    if (track.value === seconds) return false;
    track.value = seconds;
    if (track.changedAt !== 0 && now - track.changedAt <= CLOCK_WINDOW_MS) {
      track.changes += 1;
    } else {
      track.changes = 1;
    }
    track.changedAt = now;
    return track.changes >= 2;
  }

  /** "01:00" -> 60s, "00:01:00" -> 60s. Values outside 5s..4h (an hours
      countdown, most wall clocks in HH:MM:SS) are rejected here; HH:MM
      clocks are caught by movesLikeAClock / checkServerExpiry instead. */
  function parseDuration(text) {
    const match = DURATION_RE.exec(text);
    if (!match) return null;
    const first = +match[1];
    const second = +match[2];
    const third = match[3] === undefined ? null : +match[3];
    if (second >= 60 || (third !== null && third >= 60)) return null;
    const seconds = third === null
      ? first * 60 + second
      : first * 3600 + second * 60 + third;
    return seconds >= 5 && seconds <= 14_400 ? seconds : null;
  }

  /** Label text of a panel candidate; inputs carry theirs in .value. */
  function panelText(node) {
    if (node instanceof HTMLInputElement) {
      const value = (node.value || '').trim();
      return value.length > 0 && value.length <= 12 ? value : null;
    }
    const text = shallowText(node);
    return text && text.length <= 12 ? text : null;
  }

  /** Both readouts live in the trade panel column with the Up/Down buttons. */
  function inPanelColumn(rect, anchor) {
    if (rect.width === 0 || rect.height === 0) return false;
    return rect.right >= anchor.left - 60 && rect.left <= anchor.right + 60 &&
           Math.abs(rect.top - anchor.top) <= 600;
  }

  function readPayoutFrom(node, anchor) {
    if (!node || !node.isConnected) return null;
    const text = panelText(node);
    const match = text === null ? null : PAYOUT_RE.exec(text);
    if (!match) return null;
    const value = +match[1];
    if (value < 5 || value > 98) return null;
    return inPanelColumn(node.getBoundingClientRect(), anchor) ? value : null;
  }

  function readExpiryFrom(node, anchor) {
    if (!node || !node.isConnected || isDistrustedExpiryNode(node, Date.now())) return null;
    const text = panelText(node);
    const seconds = text === null ? null : parseDuration(text);
    if (seconds === null) return null;
    return inPanelColumn(node.getBoundingClientRect(), anchor) ? seconds : null;
  }

  /**
   * Refresh panel.payoutPct / panel.expirySec. Cached nodes are re-read
   * first (one rect each); the full scan runs only when a cache is cold or
   * a re-render invalidated it, and backs off up to 10× while the page
   * simply doesn't expose the readouts.
   */
  function updateTradePanel() {
    const now = Date.now();
    const backoff = Math.min(10, panel.misses + 1);
    if (now - panel.checkedAt < CONFIG.PANEL_RECHECK_MS * backoff) return;
    panel.checkedAt = now;

    const up = findTradeButton('UP');
    if (!up) {
      // Don't discard good readings just because the button is between
      // renders — let them age out through the sticky window below.
      expirePanelReadings(now);
      return;
    }
    const anchor = up.button.getBoundingClientRect();

    let payout = readPayoutFrom(panel.payoutNode, anchor);
    let expiry = readExpiryFrom(panel.expiryNode, anchor);

    if (payout === null || expiry === null) {
      const needPayout = payout === null;
      const needExpiry = expiry === null;
      let bestPayout = null, payoutDist = Infinity, payoutNode = null;
      let bestExpiry = null, expiryDist = Infinity, expiryNode = null;
      for (const node of document.querySelectorAll('span, div, input')) {
        if (node.closest('#' + WIDGET_ID)) continue;
        if (needPayout) {
          const value = readPayoutFrom(node, anchor);
          if (value !== null) {
            const dist = Math.abs(node.getBoundingClientRect().top - anchor.top);
            if (dist < payoutDist) {
              payoutDist = dist; bestPayout = value; payoutNode = node;
            }
          }
        }
        if (needExpiry) {
          const seconds = readExpiryFrom(node, anchor);
          if (seconds !== null) {
            const dist = Math.abs(node.getBoundingClientRect().top - anchor.top);
            if (dist < expiryDist) {
              expiryDist = dist; bestExpiry = seconds; expiryNode = node;
            }
          }
        }
      }
      if (needPayout && bestPayout !== null) {
        payout = bestPayout;
        panel.payoutNode = payoutNode;
      }
      if (needExpiry && bestExpiry !== null) {
        expiry = bestExpiry;
        panel.expiryNode = expiryNode;
      }
    }

    // A node whose value drifts by one second per second is a clock or a
    // countdown, whatever it parsed as. Drop it for good and forget the
    // reading it just produced.
    if (expiry !== null && panel.expiryNode &&
        movesLikeAClock(panel.expiryNode, expiry, now)) {
      log('Trade panel: the "' + panelText(panel.expiryNode) + '" node moves like a clock — ' +
          'ignoring it as the expiry readout.');
      distrustExpiryNode(panel.expiryNode);
      panel.expiryNode = null;
      expiry = null;
    }

    if (payout !== null) {
      panel.payoutPct = payout;
      panel.payoutReadAt = now;
      panel.payoutUnknownSince = 0;
    }
    if (expiry !== null) {
      panel.expirySec = expiry;
      panel.expiryReadAt = now;
    }
    expirePanelReadings(now);
    panel.misses = payout === null && expiry === null ? panel.misses + 1 : 0;

    if (payout !== null) {
      panel.warnedUnreadable = false;
      if (payout !== panel.lastLoggedPayout) {
        panel.lastLoggedPayout = payout;
        log('Trade panel: payout ' + payout + '% | expiry ' +
            (expiry !== null ? expiry + 's' : CONFIG.EXPIRY_SEC + 's (assumed)'));
      }
    } else if (CONFIG.MIN_PAYOUT_PCT > 0 && panel.payoutPct === null &&
               !panel.warnedUnreadable) {
      panel.warnedUnreadable = true;
      log('Payout % not readable on this page. Real clicks are HELD until it is ' +
          '(the server\'s own payout on a confirmed order also counts); dry-run ' +
          'and signal-only continue.');
    }
  }

  /** Drop readings older than PANEL_STICKY_MS — stale is worse than absent
      once the page has genuinely changed. */
  function expirePanelReadings(now) {
    if (panel.payoutPct !== null && now - panel.payoutReadAt > PANEL_STICKY_MS) {
      panel.payoutPct = null;
      panel.payoutNode = null;
    }
    if (panel.expirySec !== null && now - panel.expiryReadAt > PANEL_STICKY_MS) {
      panel.expirySec = null;
      panel.expiryNode = null;
    }
  }

  function effectiveExpirySec() {
    return panel.expirySec !== null ? panel.expirySec : CONFIG.EXPIRY_SEC;
  }

  /* =======================================================================
     4. Trade execution
     ======================================================================= */

  /**
   * Which account is selected? Quotex encodes it in the path:
   *   /en/demo-trade  -> demo      /en/trade -> live
   *
   * The route is authoritative. The account switcher contains both DEMO and
   * LIVE labels, so using its text produces false live-account detections.
   * @returns {'demo'|'live'|'unknown'}
   */
  function accountType() {
    try {
      const path = location.pathname || '';
      const demoPath = /^\/(?:[a-z]{2}\/)?demo-trade(?:\/|$)/i.test(path);
      const livePath = /^\/(?:[a-z]{2}\/)?trade(?:\/|$)/i.test(path);

      if (demoPath) return 'demo';
      if (livePath) return 'live';
      return 'unknown';
    } catch (error) {
      console.error('[AutoTrade] Failed to determine account type:', error);
      return 'unknown';
    }
  }

  /**
   * Android app: tap the screen for real where the element is. shim.js routes
   * this to Bridge.tap, which sends finger-down / finger-up MotionEvents
   * through the WebView, so the page sees the trusted touch a finger makes
   * rather than a synthetic click (every event simulateClick builds is
   * `isTrusted: false`, which a page can read in one line). Returns the ms
   * until the finger lifts — the app queues the tap behind any typing still
   * going out, with a pause between — or null, and the caller falls back to
   * synthetic events: without the app, with the point off the screen, or
   * with something else drawn over the element there (a real tap would land
   * on that instead).
   */
  function nativeTap(element, clientX, clientY) {
    const tap = globalThis.__nexaNativeTap;
    if (typeof tap !== 'function') return null;
    let hit = null;
    try { hit = document.elementFromPoint(clientX, clientY); } catch (_) { hit = null; }
    if (!hit || !element.contains(hit)) {
      log('Native tap skipped — the button is covered or off the viewport; sending synthetic events instead.');
      return null;
    }
    // Client coordinates are layout-viewport CSS px. The screen shows the
    // visual viewport (pinch zoom and pan) at page scale × device pixel
    // ratio, and that is the space a MotionEvent lives in.
    const vv = window.visualViewport;
    const vx = clientX - (vv ? vv.offsetLeft : 0);
    const vy = clientY - (vv ? vv.offsetTop : 0);
    if (vv && (vx < 0 || vy < 0 || vx >= vv.width || vy >= vv.height)) {
      log('Native tap skipped — the button is outside the visible (zoomed) area; sending synthetic events instead.');
      return null;
    }
    const scale = (vv && vv.scale > 0 ? vv.scale : 1) * (window.devicePixelRatio || 1);
    let result = null;
    try { result = tap(vx * scale, vy * scale); } catch (_) { result = null; }
    // The bridge answers with the ms until the finger lifts (older shims: true).
    const ms = result === true ? 0
      : (typeof result === 'number' && Number.isFinite(result) && result >= 0 ? Math.round(result) : null);
    if (ms === null) log('Native tap unavailable — sending synthetic events instead.');
    return ms;
  }

  /**
   * Dispatch the event sequence a real tap or click produces. A bare
   * element.click() fires only a 'click' event, which many trading UIs ignore
   * because they listen on pointerdown/mousedown instead.
   *
   * In the Android app the click is a real tap instead (nativeTap above) and
   * this sequence is the fallback. The touch order is the one browsers
   * themselves produce: pointer events, the touch events they mirror, and
   * only once the finger has lifted the mouse-compatibility events and the
   * click. (It used to go mouse first and touch last — an order no finger
   * produces.)
   *
   * Every event here goes out in the same millisecond. With HUMAN_CLICK on
   * (the default) trades are placed by humanClick instead, which spreads
   * the same events over the time a hand takes; this is the instant form
   * for HUMAN_CLICK off and for the fallback when a gesture cannot be
   * queued.
   */
  function simulateClick(element) {
    if (!element) return;
    const { x: clientX, y: clientY } = landingPoint(element);

    if (nativeTap(element, clientX, clientY) !== null) return;

    if (typeof element.dispatchEvent !== 'function') {
      if (typeof element.click === 'function') element.click();
      return;
    }

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      screenX: clientX + (window.screenX || 0),
      screenY: clientY + (window.screenY || 0),
      pageX: clientX + (window.scrollX || 0),
      pageY: clientY + (window.scrollY || 0),
    };
    const up = { buttons: 0 };
    const enter = { bubbles: false };            // enter/leave events never bubble

    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const hasPointer = typeof PointerEvent !== 'undefined';
    const pointer = {
      ...base,
      pointerId: 1,
      pointerType: isTouch ? 'touch' : 'mouse',
      isPrimary: true,
      width: isTouch ? 24 : 1,
      height: isTouch ? 24 : 1,
      pressure: 0.5,
    };
    const lifted = { ...up, pressure: 0 };

    const mouse = (type, extra) => element.dispatchEvent(new MouseEvent(type, { ...base, ...extra }));
    const point = (type, extra) => {
      if (hasPointer) element.dispatchEvent(new PointerEvent(type, { ...pointer, ...extra }));
    };
    // Best effort: the Touch/TouchEvent constructors are not on every engine,
    // and the pointer/mouse events around them fire either way.
    const touch = (type, ended) => {
      if (typeof window.Touch !== 'function' || typeof window.TouchEvent !== 'function') return;
      try {
        const finger = new window.Touch({
          identifier: 1, target: element,
          clientX, clientY, pageX: base.pageX, pageY: base.pageY,
          screenX: base.screenX, screenY: base.screenY, radiusX: 12, radiusY: 12, force: 0.5,
        });
        const active = ended ? [] : [finger];
        element.dispatchEvent(new window.TouchEvent(type, {
          bubbles: true, cancelable: true, composed: true, view: window,
          touches: active, targetTouches: active, changedTouches: [finger],
        }));
      } catch (_) { /* constructor unsupported */ }
    };

    if (isTouch) {
      // Finger down: each pointer event, then the touch event it mirrors.
      point('pointerover');
      point('pointerenter', enter);
      point('pointerdown');
      touch('touchstart', false);
      // Finger up. A touch pointer leaves the element as it lifts.
      point('pointerup', lifted);
      point('pointerout', lifted);
      point('pointerleave', { ...lifted, ...enter });
      touch('touchend', true);
      // The mouse-compatibility events a tap ends with, then the click.
      mouse('mouseover', up);
      mouse('mouseenter', { ...up, ...enter });
      mouse('mousemove', up);
      mouse('mousedown');
      mouse('mouseup', up);
      mouse('click', up);
      return;
    }

    // A mouse: every pointer event is followed by its mouse counterpart.
    point('pointerover', up);
    mouse('mouseover', up);
    point('pointerenter', { ...up, ...enter });
    mouse('mouseenter', { ...up, ...enter });
    point('pointermove', up);
    mouse('mousemove', up);
    point('pointerdown');
    mouse('mousedown');
    point('pointerup', lifted);
    mouse('mouseup', up);
    mouse('click', up);
  }

  /* ---- Humanized input --------------------------------------------------
     A trade is placed the way a person places one. In the Android app the
     finger is real (nativeTap / nativeType: trusted events, queued on the
     app's own timeline). In the extension nothing the bot dispatches can be
     trusted, but it can at least happen the way a hand makes it happen:
     the mouse travels to the button along a curve and settles on it, rests
     a moment, the press is held for the time a finger takes, then the
     click; a finger lands and lifts; the stake is clicked into, selected
     and typed key by key with the gaps of a thumb. The point pressed is
     never the exact centre and never the same twice. Everything goes out on
     one serial timeline, like one hand: typing first, then the button. */

  const rand = (min, max) => min + Math.random() * (max - min);

  /** A standard normal deviate, clamped to ±2.5σ (Box–Muller). */
  function gaussian() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-2.5, Math.min(2.5, z));
  }

  /**
   * Where on the element the press lands. A person aims at the middle and
   * misses a little: by the same habit each time (the install's aim bias,
   * PROFILE_RANGES aimX/aimY) plus the scatter of the moment — never the
   * exact centre, never the edge.
   */
  function landingPoint(element) {
    const rect = (typeof element.getBoundingClientRect === 'function')
      ? element.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    const width = rect.width || 0;
    const height = rect.height || 0;
    const fx = Math.max(0.12, Math.min(0.88, 0.5 + profile.aimX + gaussian() * 0.11));
    const fy = Math.max(0.12, Math.min(0.88, 0.5 + profile.aimY + gaussian() * 0.11));
    return { x: (rect.left || 0) + width * fx, y: (rect.top || 0) + height * fy, rect };
  }

  /**
   * The real pointer, from trusted events only (the bot's own are never
   * trusted): where the cursor actually is and what it is over, so a
   * synthetic mouse path starts from there; and whether the last thing
   * seen was a finger or a mouse, so the gesture is of that kind.
   */
  const realPointer = { x: null, y: null, type: null, over: null, at: 0 };
  (function trackRealPointer() {
    if (typeof document.addEventListener !== 'function') return;
    const options = { capture: true, passive: true };
    const seen = (event) => {
      if (!event.isTrusted) return;
      realPointer.x = event.clientX;
      realPointer.y = event.clientY;
      realPointer.type = event.pointerType || 'mouse';
      realPointer.over = event.target;
      realPointer.at = Date.now();
    };
    document.addEventListener('pointermove', seen, options);
    document.addEventListener('pointerdown', seen, options);
    document.addEventListener('pointerout', (event) => {
      // The mouse left the window: nothing is under it any more.
      if (event.isTrusted && event.relatedTarget === null && (event.pointerType || 'mouse') === 'mouse') {
        realPointer.over = null;
        realPointer.at = Date.now();
      }
    }, options);
  })();

  /** A finger or a mouse: whatever was last seen for real, else the device's word. */
  function pointerKind() {
    if (realPointer.type === 'touch' || realPointer.type === 'pen') return 'touch';
    if (realPointer.type === 'mouse') return 'mouse';
    return (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) ? 'touch' : 'mouse';
  }

  /**
   * One serial timeline for everything the bot does to the page with a
   * pointer or keys, like a person with one hand: a gesture queued while
   * another is going out starts when it is done. A step is a synchronous
   * function run `delay` ms after the one before; it may return more steps
   * to run next (a path is worked out only as it starts, from wherever the
   * pointer is by then). Timings are rolled when a gesture is queued, so
   * the moment its last event lands is known then: confirmTrade waits
   * from there.
   */
  const gesture = {
    steps: [],
    running: false,
    readyAt: 0,
    /** Queues `steps`, which take `ms` in all; returns the ms until they are done. */
    add(steps, ms) {
      const now = Date.now();
      this.readyAt = Math.max(now, this.readyAt) + Math.max(0, Math.round(ms));
      this.steps.push(...steps);
      if (!this.running) this.next();
      return this.readyAt - now;
    },
    next() {
      const step = this.steps.shift();
      if (!step) {
        this.running = false;
        return;
      }
      this.running = true;
      // A hidden tab's timers fire once a second: the rest of the gesture
      // would take a minute and the click would miss its confirmation
      // window. What is left goes out at once instead — the events still
      // matter, the pace no longer does (nobody clicks in a hidden tab).
      if (document.visibilityState === 'hidden') {
        this.finish(step);
        return;
      }
      setTimeout(() => {
        const more = this.perform(step);
        if (more) this.steps.unshift(...more);
        this.next();
      }, Math.max(0, Math.round(step.delay) || 0));
    },
    perform(step) {
      let more = null;
      try { more = step.run(); } catch (error) { console.debug('[AutoTrade] gesture step failed:', error); }
      return Array.isArray(more) && more.length > 0 ? more : null;
    },
    /** Runs `step` and everything queued behind it now. */
    finish(step) {
      for (let current = step; current; current = this.steps.shift()) {
        const more = this.perform(current);
        if (more) this.steps.unshift(...more);
      }
      this.running = false;
      this.readyAt = 0;
    },
    get pending() { return this.readyAt > Date.now(); },
  };

  /** Where the page last saw the bot's pointer, and over what. */
  const pointerState = { x: null, y: null, over: null, at: 0 };

  /** The element the page's own hit test finds at a point (never null). */
  function elementAt(x, y) {
    let hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (_) { hit = null; }
    return hit || document.documentElement || document.body;
  }

  /** The element and its ancestors, innermost first (enter/leave walk these). */
  function lineage(node) {
    const list = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) list.push(n);
    return list;
  }

  /** The offset from client to screen coordinates a real event carries. */
  function screenOffset() {
    const dx = Math.max(0, ((window.outerWidth || 0) - (window.innerWidth || 0)) / 2);
    const dy = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0) - dx);
    return { x: (window.screenX || 0) + dx, y: (window.screenY || 0) + dy };
  }

  /** The init dictionary of a mouse-class event at a client point. */
  function eventInit(x, y, extra) {
    const screen = screenOffset();
    return {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 0,
      button: 0, buttons: 0,
      clientX: x, clientY: y,
      screenX: x + screen.x, screenY: y + screen.y,
      pageX: x + (window.scrollX || 0), pageY: y + (window.scrollY || 0),
      movementX: 0, movementY: 0,
      ...(extra || null),
    };
  }
  const NO_BUBBLE = { bubbles: false, cancelable: false };   // enter/leave never bubble

  const pointerFields = (kind, pressed) => ({
    pointerId: 1, pointerType: kind, isPrimary: true,
    width: kind === 'touch' ? 24 : 1, height: kind === 'touch' ? 24 : 1,
    pressure: pressed ? 0.5 : 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0,
  });
  function firePointer(target, type, init, kind, pressed) {
    if (typeof PointerEvent === 'undefined') return;
    try { target.dispatchEvent(new PointerEvent(type, { ...init, ...pointerFields(kind, pressed) })); } catch (_) { /* unsupported */ }
  }
  function fireMouse(target, type, init) {
    try { target.dispatchEvent(new MouseEvent(type, init)); } catch (_) { /* unsupported */ }
  }
  /** Best effort: not every engine has the Touch/TouchEvent constructors. */
  function fireTouch(target, type, x, y, ended) {
    if (typeof window.Touch !== 'function' || typeof window.TouchEvent !== 'function') return;
    try {
      const init = eventInit(x, y);
      const finger = new window.Touch({
        identifier: 1, target,
        clientX: x, clientY: y, pageX: init.pageX, pageY: init.pageY,
        screenX: init.screenX, screenY: init.screenY, radiusX: 12, radiusY: 12, force: 0.5,
      });
      const active = ended ? [] : [finger];
      target.dispatchEvent(new window.TouchEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window,
        touches: active, targetTouches: active, changedTouches: [finger],
      }));
    } catch (_) { /* constructor unsupported */ }
  }

  /**
   * The mouse crosses from what it was over to what it is over now: out
   * and leave on what it left, over and enter on what it reached, leave
   * and enter walking the ancestors the two do not share — the pointer
   * events first, then their mouse twins, as the browser orders them (the
   * mouse twins alone for the virtual mouse a finger leaves behind).
   */
  function crossTo(next, x, y, pressed, families = ['pointer', 'mouse']) {
    const prev = pointerState.over;
    if (prev === next) return;
    const leaving = prev ? lineage(prev).filter((node) => !next || !node.contains(next)) : [];
    const entering = next ? lineage(next).filter((node) => !prev || !node.contains(prev)).reverse() : [];
    const init = eventInit(x, y, pressed ? { buttons: 1 } : null);
    const bubbling = (related) => ({ ...init, relatedTarget: related });
    const quiet = (related) => ({ ...init, ...NO_BUBBLE, relatedTarget: related });
    for (const family of families) {
      const fire = family === 'pointer'
        ? (target, type, dict) => firePointer(target, type, dict, 'mouse', pressed)
        : fireMouse;
      if (prev) {
        fire(prev, family + 'out', bubbling(next));
        for (const node of leaving) fire(node, family + 'leave', quiet(next));
      }
      if (next) {
        fire(next, family + 'over', bubbling(prev));
        for (const node of entering) fire(node, family + 'enter', quiet(prev));
      }
    }
    pointerState.over = next;
  }

  /** The mouse at (x, y): whatever it crossed on the way, then the move. */
  function mouseTo(x, y, pressed) {
    const target = elementAt(x, y);
    crossTo(target, x, y, pressed);
    const init = eventInit(x, y, {
      movementX: pointerState.x === null ? 0 : Math.round(x - pointerState.x),
      movementY: pointerState.y === null ? 0 : Math.round(y - pointerState.y),
      ...(pressed ? { buttons: 1 } : null),
    });
    firePointer(target, 'pointermove', init, 'mouse', pressed);
    fireMouse(target, 'mousemove', init);
    pointerState.x = x;
    pointerState.y = y;
    pointerState.at = Date.now();
  }

  /**
   * Where a mouse path starts: the real cursor when it has moved since the
   * page last saw the bot's pointer, else where that was, else somewhere
   * over the page (a cursor left alone while the chart is watched).
   */
  function mouseOrigin() {
    if (realPointer.type === 'mouse' && realPointer.x !== null && realPointer.at >= pointerState.at) {
      pointerState.x = realPointer.x;
      pointerState.y = realPointer.y;
      pointerState.over = realPointer.over;
      pointerState.at = realPointer.at;
    }
    if (pointerState.x !== null) return { x: pointerState.x, y: pointerState.y };
    return {
      x: (window.innerWidth || 800) * rand(0.2, 0.8),
      y: (window.innerHeight || 600) * rand(0.2, 0.8),
    };
  }

  /** Fitts's law: further and smaller targets take longer, with the install's pace. */
  function mouseTravelMs(from, to, targetSize) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const width = Math.max(8, targetSize || 20);
    return Math.round((100 + 120 * Math.log2(1 + distance / width)) * rand(0.85, 1.25) * profile.move);
  }

  /**
   * The steps of a mouse path to `to` taking `ms`: a gentle curve, quick
   * in the middle and settling at the end (a minimum-jerk profile), with
   * the small wander of a hand, sampled at the frame rate mouse moves
   * arrive at. Worked out as it starts, from wherever the pointer is then.
   */
  function mousePathSteps(to, ms, pressed) {
    const from = mouseOrigin();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return [{ delay: 0, run: () => mouseTo(to.x, to.y, pressed) }];
    const count = Math.max(2, Math.round(ms / 16));
    const bend = rand(-0.2, 0.2) * distance;            // sideways, either way
    const cx = from.x + dx / 2 - (dy / distance) * bend;
    const cy = from.y + dy / 2 + (dx / distance) * bend;
    const steps = [];
    for (let i = 1; i <= count; i += 1) {
      const t = i / count;
      const s = t * t * t * (10 + t * (-15 + 6 * t));   // 10t³ − 15t⁴ + 6t⁵
      const u = 1 - s;
      const last = i === count;
      const x = last ? to.x : u * u * from.x + 2 * u * s * cx + s * s * to.x + rand(-0.6, 0.6);
      const y = last ? to.y : u * u * from.y + 2 * u * s * cy + s * s * to.y + rand(-0.6, 0.6);
      steps.push({ delay: ms / count, run: () => mouseTo(x, y, pressed) });
    }
    return steps;
  }

  /**
   * A real mousedown moves the focus; a synthetic one does not, so it is
   * moved here: to the control pressed, else away from whatever had it.
   */
  function focusAfterPress(target) {
    try {
      const control = typeof target.closest === 'function'
        ? target.closest('button, input, select, textarea, a[href], [tabindex]') : null;
      if (control && typeof control.focus === 'function') control.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement !== document.body &&
               typeof document.activeElement.blur === 'function') document.activeElement.blur();
    } catch (_) { /* best effort */ }
  }

  /** What the press should hit: the page's own hit test, unless something covers the element. */
  function pressTarget(element, point) {
    const hit = elementAt(point.x, point.y);
    if (element.contains(hit)) return hit;
    log('Click: something else is drawn over the button — clicking it through that.');
    return element;
  }

  /**
   * A mouse click on `element` as a hand makes it: the path (worked out as
   * it starts), a rest on the spot, the button down, held, up, the click.
   */
  function mouseClickSteps(element, point, travelMs, dwellMs, holdMs) {
    let target = element;
    return [
      { delay: 0, run: () => mousePathSteps(point, travelMs, false) },
      { delay: dwellMs, run: () => {
        target = pressTarget(element, point);
        const down = eventInit(point.x, point.y, { buttons: 1 });
        firePointer(target, 'pointerdown', down, 'mouse', true);
        fireMouse(target, 'mousedown', down);
        focusAfterPress(target);
      } },
      { delay: holdMs, run: () => {
        const up = eventInit(point.x, point.y);
        firePointer(target, 'pointerup', up, 'mouse', false);
        fireMouse(target, 'mouseup', up);
        fireMouse(target, 'click', eventInit(point.x, point.y, { detail: 1 }));
      } },
    ];
  }

  /**
   * A finger tap on `element`: it lands (pointer events, the touch event
   * they mirror), rests for the time a fingertip does, lifts — and only
   * then the mouse-compatibility events and the click, as browsers order
   * a tap. The sequence of simulateClick, spread over the hold.
   */
  function touchTapSteps(element, point, holdMs) {
    let target = element;
    const { x, y } = point;
    return [
      { delay: 0, run: () => {
        target = pressTarget(element, point);
        const down = eventInit(x, y, { buttons: 1 });
        firePointer(target, 'pointerover', down, 'touch', true);
        for (const node of lineage(target).reverse()) firePointer(node, 'pointerenter', { ...down, ...NO_BUBBLE }, 'touch', true);
        firePointer(target, 'pointerdown', down, 'touch', true);
        fireTouch(target, 'touchstart', x, y, false);
      } },
      { delay: holdMs, run: () => {
        const up = eventInit(x, y);
        firePointer(target, 'pointerup', up, 'touch', false);
        firePointer(target, 'pointerout', up, 'touch', false);
        for (const node of lineage(target)) firePointer(node, 'pointerleave', { ...up, ...NO_BUBBLE }, 'touch', false);
        fireTouch(target, 'touchend', x, y, true);
        // The mouse-compatibility events a tap ends with, then the click.
        // They leave a virtual mouse resting where the finger was.
        pointerState.over = null;
        crossTo(target, x, y, false, ['mouse']);
        fireMouse(target, 'mousemove', up);
        fireMouse(target, 'mousedown', eventInit(x, y, { buttons: 1 }));
        focusAfterPress(target);
        fireMouse(target, 'mouseup', up);
        fireMouse(target, 'click', eventInit(x, y, { detail: 1 }));
        pointerState.x = x;
        pointerState.y = y;
        pointerState.at = Date.now();
      } },
    ];
  }

  /** The steps of a click or tap on `element` at `point`, and how long they take. */
  function pressSteps(element, point) {
    if (pointerKind() === 'touch') {
      const hold = rand(60, 130);
      return { steps: touchTapSteps(element, point, hold), ms: hold + 10 };
    }
    const travel = mouseTravelMs(mouseOrigin(), point, Math.min(point.rect.width, point.rect.height));
    const dwell = rand(60, 220);
    const hold = rand(55, 140);
    return { steps: mouseClickSteps(element, point, travel, dwell, hold), ms: travel + dwell + hold };
  }

  const KEY_CODES = { '.': ['Period', 190], ',': ['Comma', 188] };
  function keyInit(ch, pressType) {
    const digit = /^[0-9]$/.test(ch);
    const keyCode = digit ? 48 + Number(ch) : KEY_CODES[ch][1];
    const charCode = pressType === 'keypress' ? ch.charCodeAt(0) : 0;
    return {
      key: ch, code: digit ? 'Digit' + ch : KEY_CODES[ch][0],
      keyCode: pressType === 'keypress' ? charCode : keyCode, which: pressType === 'keypress' ? charCode : keyCode,
      charCode, bubbles: true, cancelable: true, composed: true, view: window,
    };
  }
  function fireKey(target, type, ch) {
    try { target.dispatchEvent(new KeyboardEvent(type, keyInit(ch, type))); } catch (_) { /* unsupported */ }
  }
  function fireInput(target, type, ch) {
    let event = null;
    try {
      event = new InputEvent(type, { inputType: 'insertText', data: ch, bubbles: true, cancelable: type === 'beforeinput', composed: true });
    } catch (_) {
      event = new Event(type, { bubbles: true, cancelable: type === 'beforeinput' });
    }
    try { target.dispatchEvent(event); } catch (_) { /* unsupported */ }
  }

  /**
   * Types `text` into `input` as a person does: the field is clicked (mouse
   * or finger, like the button), what it holds is selected, then one key at
   * a time — keydown, keypress, beforeinput, the character, input, keyup —
   * with the gaps of a thumb on a keypad; then the field is left (change,
   * blur), as it is when the hand moves on to the button. Queued on the
   * gesture timeline; returns the ms until it is done, or null when the
   * text is not something the keys can type.
   */
  function humanType(input, text) {
    if (!/^[0-9.,]{1,12}$/.test(text) || typeof input.dispatchEvent !== 'function') return null;
    if (document.visibilityState === 'hidden') return null;   // see gesture.next
    let setter = null;
    try { setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; } catch (_) { setter = null; }
    if (typeof setter !== 'function') return null;
    const point = landingPoint(input);
    const press = pressSteps(input, point);
    const steps = press.steps.slice();
    let ms = press.ms;
    // A person selects what is there (a double-click, a drag: the result is
    // the same selection), so the first key replaces it.
    const settle = rand(120, 260);
    steps.push({ delay: settle, run: () => {
      input.focus({ preventScroll: true });
      input.select();
    } });
    ms += settle;
    let value = '';
    for (const ch of text) {
      const gap = rand(70, 160);
      const hold = rand(40, 90);
      steps.push({ delay: gap, run: () => {
        fireKey(input, 'keydown', ch);
        fireKey(input, 'keypress', ch);
        fireInput(input, 'beforeinput', ch);
        value += ch;
        setter.call(input, value);
        fireInput(input, 'input', ch);
      } });
      steps.push({ delay: hold, run: () => fireKey(input, 'keyup', ch) });
      ms += gap + hold;
    }
    const leave = rand(80, 200);
    steps.push({ delay: leave, run: () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (document.activeElement === input) input.blur();
    } });
    ms += leave;
    return gesture.add(steps, ms);
  }

  /**
   * The click that places the trade, as a hand makes it: the app's real
   * finger when there is one, else the gesture of the kind of pointer last
   * seen. Queued behind the stake typing. Returns the ms until the click
   * lands, or null when no gesture could be queued (the caller falls back
   * to the instant simulateClick).
   */
  function humanClick(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const point = landingPoint(element);
    if (typeof globalThis.__nexaNativeTap === 'function' && gesture.pending) {
      // The stake is still being typed by synthetic keys (the app declined
      // to type it): the real finger waits its turn behind them.
      const after = gesture.readyAt - Date.now();
      gesture.add([{ delay: 0, run: () => {
        if (nativeTap(element, point.x, point.y) === null) simulateClick(element);
      } }], 200);
      return after + 200;
    }
    const native = nativeTap(element, point.x, point.y);
    if (native !== null) return native;
    if (typeof element.dispatchEvent !== 'function') return null;
    if (document.visibilityState === 'hidden') return null;   // see gesture.next
    const press = pressSteps(element, point);
    return gesture.add(press.steps, press.ms);
  }

  /** The click of a trade. Returns the ms until it lands (0: it already has). */
  function placeClick(element) {
    if (CONFIG.HUMAN_CLICK) {
      const ms = humanClick(element);
      if (ms !== null) return ms;
    }
    simulateClick(element);
    return 0;
  }

  /** The stake a dry-run trade is scored with: what the stake sizer would
      write for this entry, else what the platform's amount field shows,
      else $1 — so a dry run's P&L means the same thing a real run's would. */
  function dryStake(view) {
    const planned = plannedStake(view);
    if (planned !== null) return planned;
    const input = findStakeInput();
    if (input) {
      const value = parseFloat(String(input.value).replace(/[^\d.]/g, ''));
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 1;
  }

  /**
   * Place a trade.
   * @param {'UP'|'DOWN'} direction
   * @param {string} [variantId] the auto-mode variant that fired, for the journal
   * @param {string} [reason] the signal's reason, for the log and the journal
   * @param {Object} [view] the signal view, for evidence-based stake sizing
   * @returns {boolean} true if a click was actually dispatched.
   */
  function executeTrade(direction, variantId, reason, view) {
    const found = findTradeButton(direction);

    if (!found) {
      bot.buttonMisses += 1;
      if (CONFIG.RUN_UNTIL_STOPPED) {
        // Never end the run over a missing button: the page re-renders, a
        // modal covers it, the layout shifts — it usually comes back. Say so
        // on the widget and try again next tick (log every 10th miss).
        if (bot.buttonMisses === 1 || bot.buttonMisses % 10 === 0) {
          log('Could not resolve the', direction, 'button (' + bot.buttonMisses +
              ' consecutive misses) — retrying every tick.');
        }
        setStatus(direction + ' button not found — retrying (' + bot.buttonMisses + ')', 'running');
        return false;
      }
      if (bot.buttonMisses < MAX_BUTTON_MISSES) {
        log('Could not resolve the', direction, 'button (miss ' + bot.buttonMisses +
            '/' + MAX_BUTTON_MISSES + ') — skipping this tick.');
        return false;
      }
      log('Could not resolve the', direction, 'button', MAX_BUTTON_MISSES,
          'times in a row — every strategy failed.');
      stopBot(direction + ' button not found');
      return false;
    }
    if (bot.buttonMisses > 0) log('The', direction, 'button is back after', bot.buttonMisses, 'misses.');
    bot.buttonMisses = 0;

    const { button, via } = found;

    const disabled = button.disabled ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.classList.contains('disabled');

    if (disabled) {
      log('The', direction, 'button is disabled right now — skipping this tick.');
      return false;
    }

    const why = reason ? ' (' + reason + ')' : '';

    // Signal-only outranks everything: the human trades, the bot advises.
    if (CONFIG.SIGNAL_ONLY) {
      bot.lastTradeAt = Date.now();
      showAlert(direction);
      log('SIGNAL (alert-only):', direction, 'at', feed.price + why, '— no click by design.');
      notice('SIGNAL only — you place the trade (Signal-only is ON)', 6000);
      return false;
    }

    const now = Date.now();
    const trade = {
      t: now, direction, price: feed.price, symbol: feed.symbol,
      expectedCommand: direction === 'UP' ? 0 : 1, runId: bot.runId,
      payoutPct: panel.payoutPct, expirySec: effectiveExpirySec(),
      variantId: variantId || null, reason: reason || null,
    };

    if (CONFIG.DRY_RUN) {
      // A dry run used to log a line and forget: no trade object, no
      // settlement, no P&L, and the session cap never counted it — so "Dry
      // Run (Virtual Testing)" tested nothing. The trade is now journaled and
      // settled against the live feed one expiry later (settleDryTrades), at
      // the stake the platform shows, so the Session stats mean the same
      // thing in both modes. Daily P&L is real money and stays untouched.
      trade.dry = true;
      trade.account = 'dry';
      trade.amount = dryStake(view);
      bot.trades.push(trade);
      trimTrades();
      dryPendings.push({
        trade,
        expiresAt: now + trade.expirySec * 1000,
        // Same handicap the shadow scoreboard applies: the fill would not
        // have been the tick on screen.
        entry: (() => {
          const cost = medianSlippagePct();
          const handicap = cost === null ? 0 : cost / 100;
          return direction === 'UP' ? feed.price * (1 + handicap) : feed.price * (1 - handicap);
        })(),
      });
      bot.lastTradeAt = now;
      bot.tradeCount += 1;
      bot.nextCooldownJitter = rollCooldownJitter();
      showAlert(direction);
      log('DRY RUN #' + bot.tradeCount + ' — would click', direction, 'at', feed.price + why,
          'via', via, '| $' + trade.amount + ' virtual, settles in ' + trade.expirySec + 's');
      notice('DRY RUN — no real click (Dry-run is ON in settings)', 6000);
      return false;
    }

    // Re-check the account on every click, not just at start — the user can
    // switch accounts while the bot is running, and a run that started on
    // demo must never click on live (or the other way round) unnoticed.
    const account = accountType();
    if (account !== bot.account) {
      log('BLOCKED: the account changed from ' + bot.account + ' to ' + account +
          ' while running. Press Start again to trade on it.');
      stopBot('Account changed');
      return false;
    }
    if (account === 'live' && !liveAllowed()) {
      log('BLOCKED: live account — ' + (CONFIG.LIVE_ACCOUNT === 'never'
        ? 'LIVE_ACCOUNT is "never".' : 'not confirmed.'));
      stopBot('Live account blocked');
      return false;
    }

    setStake(plannedStake(view));
    // The stake typing and the click go out as one hand's gestures (or the
    // app's real finger): the click lands a little later, and the
    // confirmation window is counted from then.
    const landsIn = placeClick(button);
    showAlert(direction);
    bot.lastTradeAt = now;
    bot.tradeCount += 1;
    bot.hourlyTrades.push(now);
    bot.nextCooldownJitter = rollCooldownJitter();
    trade.account = account;
    bot.trades.push(trade);
    trimTrades();
    log('Clicked', direction, '#' + bot.tradeCount, 'at', feed.price + why, '— awaiting confirmation' +
        (landsIn > 0 ? ' (the click lands in ' + (landsIn / 1000).toFixed(1) + ' s)' : ''));
    notice(direction + ' clicked #' + bot.tradeCount + ' — confirming…', CONFIG.CONFIRM_MS + landsIn + 2000);

    confirmTrade(trade, landsIn);
    return true;
  }

  /** Keep bot.trades bounded during a run, not only across restarts — with
      an unlimited session cap and a short cooldown a long run grew it (and
      every find() over it) for hours. Oldest first; a trade that old has
      long settled or never will. */
  function trimTrades() {
    if (bot.trades.length > MAX_KEPT_TRADES) {
      bot.trades.splice(0, bot.trades.length - MAX_KEPT_TRADES);
    }
  }

  /**
   * Settle dry-run trades whose expiry the feed has reached. Mirrors the
   * shadow scoreboard: the first sample at/after expiry decides, a sample
   * more than SHADOW_TOLERANCE_MS late means the outcome is unknowable and
   * the trade is voided rather than guessed.
   */
  function settleDryTrades(sample) {
    if (dryPendings.length === 0) return;
    const keep = [];
    for (const pending of dryPendings) {
      if (sample.t < pending.expiresAt) { keep.push(pending); continue; }
      const { trade } = pending;
      if (sample.t - pending.expiresAt > SHADOW_TOLERANCE_MS) {
        trade.settled = true;
        trade.voided = true;
        trade.profit = 0;
        log('DRY RUN', trade.direction, '— no price at expiry (feed hole); voided.');
        continue;
      }
      const diff = sample.price - pending.entry;
      const won = diff !== 0 && (trade.direction === 'UP') === (diff > 0);
      const payout = trade.payoutPct === null ? ASSUMED_PAYOUT_PCT : trade.payoutPct;
      const profit = diff === 0 ? 0 : won ? +(trade.amount * payout / 100).toFixed(2)
                                          : -trade.amount;
      settleTrade(trade, {
        profit, openPrice: pending.entry, closePrice: sample.price,
      });
    }
    dryPendings = keep;
  }

  /**
   * A synthetic click carries isTrusted: false. If Quotex rejects those, the
   * button click is a silent no-op — so verify against the server rather than
   * assuming success. Only a matching server-side open order is confirmation.
   * `landsIn`: the ms until the click actually lands (a gesture or the
   * app's finger is still on its way); the window is counted from then.
   */
  function confirmTrade(trade, landsIn = 0) {
    setTimeout(() => {
      // The bot was stopped (or restarted) while this timer was pending — a
      // verdict either way would poison another run's counters and status
      // line. This must gate the confirmed branch too: startBot resets
      // bot.confirmed, so a leftover timer from the previous run would
      // otherwise credit the new run with a trade it never placed.
      if (!bot.running || bot.runId !== trade.runId) return;

      if (trade.orderId) {
        bot.confirmed += 1;
        bot.unconfirmed = 0;
        log('CONFIRMED:', trade.direction, 'accepted —',
            '$' + trade.amount + ' @ ' + trade.openPrice,
            '| balance $' + (feed.balance ? feed.balance.demo : '?'));
        notice('✓ ' + trade.direction + ' placed — trade confirmed', 6000);
        return;
      }

      trade.verdict = 'unconfirmed';
      bot.unconfirmed += 1;
      log('UNCONFIRMED:', trade.direction, '— no matching server order arrived.');
      notice('✗ ' + trade.direction + ' click did not register on the page', 6000);

      if (bot.unconfirmed >= 2) {
        if (CONFIG.RUN_UNTIL_STOPPED) {
          // Pause with backoff instead of stopping. If the clicks really do
          // not register the pause costs nothing; if they register but the
          // confirmation matching is what is broken, the backoff keeps a
          // blind clicker to one attempt per 2–10 minutes.
          bot.unconfirmedPauses += 1;
          const ms = Math.min(CONFIG.UNCONFIRMED_PAUSE_MAX_MS,
            CONFIG.UNCONFIRMED_PAUSE_MS * 2 ** (bot.unconfirmedPauses - 1));
          bot.unconfirmed = 0;   // a fresh two strikes after the pause
          log('Two unconfirmed trades in a row. Quotex may be rejecting synthetic ' +
              'clicks (event.isTrusted === false), or the order match failed.');
          pauseTrading(ms, 'clicks not registering');
        } else {
          log('Two unconfirmed trades in a row. Quotex is most likely rejecting ' +
              'synthetic clicks (event.isTrusted === false). Stopping.');
          stopBot('Clicks not registering');
        }
      }
    }, CONFIG.CONFIRM_MS + Math.max(0, Math.round(landsIn) || 0));
  }

  /**
   * Match on immutable server properties (asset + direction + account) so an
   * arbitrary balance update can never count as confirmation. Residual
   * ambiguity: a manual order on the same asset, in the same direction,
   * inside the 15s window is indistinguishable from ours and gets attributed
   * to the bot — the platform exposes nothing tying an order to a click.
   */
  function attachOrder(order) {
    // Orders arrive in the order the clicks were placed, so the OLDEST
    // unattached click inside the window is the one this order belongs to.
    // Matching newest-first swapped the attributions (fill price, slippage,
    // stake) whenever a slow server delivered order A after click B — routine
    // at the 5s minimum cooldown.
    let match = null;
    for (let i = bot.trades.length - 1; i >= 0; i--) {
      const t = bot.trades[i];
      if (Date.now() - t.t > 15_000) break;   // too old to be ours
      if (t.orderId || t.dry) continue;
      if (normalizeSymbol(t.symbol) !== normalizeSymbol(order.asset) ||
          t.expectedCommand !== order.command ||
          (t.account === 'demo') !== order.isDemo) continue;
      match = t;
    }
    if (!match) return;
    const t = match;
    t.orderId = order.id;
    t.amount = order.amount;
    t.openPrice = order.openPrice;
    // Slippage: the server's fill price vs the price on screen at click
    // time. Feeds the edge-vs-cost gate and the shadow scoreboard's entry
    // handicap.
    if (Number.isFinite(t.price) && t.price > 0) {
      t.slippage = order.openPrice - t.price;
      const costPct = Math.abs(t.slippage / t.price) * 100;
      noteSlippage(costPct);
      log('Slippage', t.slippage.toFixed(6),
          '(' + costPct.toFixed(4) + '% of price)');
    }
    // The server's own figures for this contract — the ground truth the
    // panel readings are only guessing at.
    adoptServerPayout(t, order.percentProfit);
    checkServerExpiry(t, order.closeTimestamp);
    // The server can be slower than CONFIRM_MS. A verdict already rendered
    // against this trade gets corrected instead of being left to stop the
    // bot for clicks that actually registered. The counters belong to the
    // run that placed the trade — after a stop/restart inside the 15s
    // window they describe a different run and must be left alone.
    if (t.verdict === 'unconfirmed') {
      t.verdict = 'confirmed-late';
      if (bot.running && t.runId === bot.runId) {
        bot.unconfirmed = Math.max(0, bot.unconfirmed - 1);
        bot.confirmed += 1;
      }
      log('LATE CONFIRMATION:', t.direction, '— server order arrived after the verdict window.');
    }
  }

  /**
   * The payout the server actually applied to a confirmed order is the most
   * accurate reading there is; it becomes the live payout (sticky like a
   * panel reading) and calls out a panel reading that disagreed.
   */
  function adoptServerPayout(trade, percentProfit) {
    if (!Number.isFinite(percentProfit) || percentProfit < 5 || percentProfit > 98) return;
    trade.serverPayoutPct = percentProfit;
    const panelRead = panel.payoutPct;
    if (panelRead !== null && Math.abs(panelRead - percentProfit) >= 3) {
      log('Payout: panel shows ' + panelRead + '% but the server paid ' + percentProfit +
          '% on this order — using the server figure.');
      panel.payoutNode = null;   // that node is not the payout readout
    }
    panel.payoutPct = percentProfit;
    panel.payoutReadAt = Date.now();
    panel.payoutUnknownSince = 0;
    panel.warnedUnreadable = false;
  }

  /**
   * closeTimestamp - now is the contract's REAL remaining life. If it does
   * not match the duration read off the panel, the expiry model — the
   * scoreboard bucket, the virtual settlement time, the horizon windows — is
   * wrong. Two known ways: the panel node is a clock or a countdown that
   * parsed as a duration ("14:35" -> 875s), or the platform is in fixed-time
   * mode where a contract ends at a clock boundary rather than click+N.
   * The node is distrusted; a persistent mismatch is logged every time.
   */
  function checkServerExpiry(trade, closeTimestamp) {
    if (!Number.isFinite(closeTimestamp) || closeTimestamp <= 0) return;
    const closeMs = closeTimestamp > 1e11 ? closeTimestamp : closeTimestamp * 1000;
    const remainingSec = Math.round((closeMs - trade.t) / 1000);
    if (remainingSec < 1 || remainingSec > 14_400) return;   // not a contract close time
    trade.serverExpirySec = remainingSec;
    const assumed = trade.expirySec;
    if (!Number.isFinite(assumed)) return;
    const tolerance = Math.max(5, Math.min(assumed, remainingSec) * 0.25);
    if (Math.abs(remainingSec - assumed) <= tolerance) return;
    log('Expiry mismatch: the bot assumed ' + assumed + 's but this contract closes in ' +
        remainingSec + 's. ' + (panel.expiryNode
          ? 'Distrusting the panel node it read that from.'
          : 'Check the expiry mode on the trade panel (fixed-time contracts end at a ' +
            'clock boundary, not N seconds after the click).'));
    if (panel.expiryNode) {
      distrustExpiryNode(panel.expiryNode, SERVER_DISTRUST_MS);
      panel.expiryNode = null;
      panel.expirySec = null;
    }
    // A distrusted node showing the server's figure was the setting after all.
    reinstateExpiryNode(remainingSec, tolerance, Date.now());
  }

  // Rolling |slippage| as a percentage of price, newest last. This is the
  // real execution cost, and on a 5s contract it is the same order of
  // magnitude as the whole predicted move — so it belongs in the entry
  // decision, not just the journal.
  const slippagePcts = [];
  const SLIPPAGE_KEEP = 40;

  function noteSlippage(costPct) {
    if (!Number.isFinite(costPct)) return;
    slippagePcts.push(costPct);
    if (slippagePcts.length > SLIPPAGE_KEEP) slippagePcts.shift();
  }

  /** Median measured cost, or null until enough real fills exist. */
  function medianSlippagePct() {
    if (slippagePcts.length < CONFIG.MIN_SLIPPAGE_SAMPLES) return null;
    const sorted = [...slippagePcts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * A server-side deal settled. Attribute it to the bot only if we opened
   * it, then keep a running win/loss tally.
   */
  function recordResult(deal) {
    const mine = bot.trades.find((t) => t.orderId === deal.id);
    if (!mine) return;                        // a trade the user placed by hand
    if (mine.settled) return;                 // close frames can repeat a deal
    settleTrade(mine, {
      profit: deal.profit, openPrice: deal.openPrice, closePrice: deal.closePrice,
    });
  }

  /**
   * Common settlement path for real (server-confirmed) and dry-run
   * (virtually settled) trades: journal, session counters, circuit breakers.
   *
   * Session counters are gated on the run that placed the trade. A 60s
   * contract from run N routinely settles during run N+1, and it used to
   * land in N+1's wins/losses/P&L — the "Session" line then contradicted its
   * own trade count, and a leftover loss could trip the new run's loss-streak
   * stop. The journal and today's realized P&L are run-independent and stay
   * unconditional; the daily cap is about the day, not the run.
   */
  function settleTrade(trade, result) {
    const { profit } = result;
    trade.profit = profit;
    trade.closePrice = result.closePrice;
    trade.settled = true;
    const thisRun = trade.runId === bot.runId;
    const label = (profit > 0 ? 'WIN' : profit < 0 ? 'LOSS' : 'DRAW') +
      (trade.dry ? ' (dry)' : '') + (thisRun ? '' : ' (previous run)');

    recordTradeRow({
      t: trade.t,
      sym: trade.symbol,
      dir: trade.direction,
      clickPrice: trade.price,
      openPrice: Number.isFinite(result.openPrice) ? result.openPrice : null,
      closePrice: result.closePrice,
      amount: Number.isFinite(trade.amount) ? trade.amount : null,
      profit,
      payout: trade.payoutPct === undefined ? null : trade.payoutPct,
      expiry: trade.expirySec === undefined ? null : trade.expirySec,
      slippage: trade.slippage === undefined ? null : trade.slippage,
      dry: trade.dry === true,
      variant: trade.variantId || null,
      reason: trade.reason || null,
      serverPayout: trade.serverPayoutPct === undefined ? null : trade.serverPayoutPct,
      serverExpiry: trade.serverExpirySec === undefined ? null : trade.serverExpirySec,
    });

    if (thisRun) {
      if (profit > 0) bot.wins += 1;
      else if (profit < 0) bot.losses += 1;   // profit === 0 is a draw
      bot.pnl = +(bot.pnl + profit).toFixed(2);
      if (profit < 0) {
        if (Date.now() >= bot.pausedUntil) bot.lossStreak += 1;
      } else if (profit > 0) {
        bot.lossStreak = 0;
      }
    }

    log(label, trade.direction, result.openPrice, '->', result.closePrice,
        '| P&L $' + bot.pnl, '| ' + bot.wins + 'W-' + bot.losses + 'L');

    // Real outcomes calibrate the shadow scoreboard; dry ones are already
    // virtual and would count the same market moment twice.
    if (!trade.dry) noteRealOutcome(trade.variantId, profit);

    // Circuit breakers. The daily limits track real money only — a dry run
    // must never lock the account out of a day it has not traded — and per
    // account, so a demo loss cannot stop a live day (or hide a live loss).
    const breach = trade.dry ? null : (addDailyPnl(profit, trade.account), dailyBreach(trade.account));
    if (bot.running && thisRun && CONFIG.MAX_LOSS_STREAK > 0 &&
        bot.lossStreak >= CONFIG.MAX_LOSS_STREAK) {
      log(bot.lossStreak + ' consecutive losses — the strategy is not working ' +
          'right now. Cooling off.');
      if (CONFIG.RUN_UNTIL_STOPPED) {
        const streak = bot.lossStreak;
        bot.lossStreak = 0;   // the run resumes with a fresh streak
        pauseTrading(CONFIG.LOSS_STREAK_PAUSE_MS, streak + ' losses in a row');
      } else {
        stopBot(bot.lossStreak + ' losses in a row');
      }
    } else if (bot.running && breach !== null && trade.account === bot.account) {
      const today = dailyPnl(trade.account);
      if (breach === 'daily cap') {
        log('Daily loss cap reached ($' + today + ' on ' + trade.account + '). Stopping for the day.');
        stopBot('Daily loss cap hit');
      } else {
        log('Daily profit target reached ($' + today + ' on ' + trade.account +
            '). Stopping for the day — a banked day is the one edge that needs no model.');
        stopBot('Daily profit target hit');
      }
    }
  }

  /* =======================================================================
     4b. Alerts + money management
     ======================================================================= */

  let audioCtx = null;
  let audioBlocked = false;   // the browser refused; stop asking

  /**
   * Create and resume the AudioContext, but ONLY at a moment the browser
   * counts as user activation.
   *
   * Chrome's autoplay policy refuses both the construction and the resume()
   * of an AudioContext outside a real gesture, and resume() reports that
   * refusal by REJECTING ITS PROMISE — which a try/catch around the call
   * cannot see. That unhandled rejection is what showed up as
   * "The AudioContext was not allowed to start" on chrome://extensions.
   *
   * This is reachable in ordinary use, not just under automation: the widget
   * unlocks audio from a pointerdown, and any click the page (or a script)
   * dispatches synthetically carries no activation at all.
   *
   * @param {Event} [event] the gesture that triggered this, when there is one
   */
  function unlockAudio(event) {
    if (audioBlocked) return;
    // A dispatched event grants no activation — only a genuine gesture does.
    if (event && event.isTrusted === false) return;
    const activation = navigator.userActivation;
    if (activation && !activation.isActive) return;
    try {
      if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (typeof Ctor !== 'function') { audioBlocked = true; return; }
        audioCtx = new Ctor();
      }
      if (audioCtx.state === 'suspended') {
        const resuming = audioCtx.resume();
        // resume() is asynchronous and rejects when the policy says no.
        // Catch it here or it escapes as an uncaught rejection.
        if (resuming && typeof resuming.catch === 'function') {
          resuming.catch(() => { /* stays suspended; beep() then no-ops */ });
        }
      }
    } catch (_) {
      audioBlocked = true;   // construction itself was refused
    }
  }

  /** Two-tone beep: high for UP, low for DOWN. Silent (never throwing, never
      scheduling on a dead context) whenever audio has not been unlocked. */
  function beep(direction) {
    if (!CONFIG.ALERT_SOUND) return;
    try {
      unlockAudio();
      // 'suspended' was previously treated as usable: the nodes were built and
      // scheduled against a context that would never play them.
      if (!audioCtx || audioCtx.state !== 'running') return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = direction === 'UP' ? 880 : 440;
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
    } catch (error) {
      console.debug('[AutoTrade] Beep failed:', error);
    }
  }

  let flashTimer = null;

  /** The BUY / SELL flash in the middle of the screen (UP = BUY, DOWN = SELL). */
  function showAlert(direction) {
    ui.flash.textContent = direction === 'UP' ? 'BUY' : 'SELL';
    ui.flash.dataset.dir = direction;
    ui.flash.hidden = false;
    // An animation declared on the element itself runs once and never
    // again; restart it by removing the class, forcing a reflow, re-adding.
    ui.flash.classList.remove('nexa-flash--pop');
    void ui.flash.offsetWidth;
    ui.flash.classList.add('nexa-flash--pop');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      ui.flash.hidden = true;
      ui.flash.classList.remove('nexa-flash--pop');
    }, 3_000);
    beep(direction);
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  /**
   * Today's record, persisted (extension storage) so neither a reload nor a
   * "clear site data" can reset the limits: realized bot P&L in total and
   * per account, plus the balance each account had when the bot first
   * traded on it today — the base the percentage limits are measured from.
   * Reads are from the store's in-memory cache (tradeVeto calls this every
   * tick); a record from another day reads as empty.
   */
  function dailyRecord() {
    const raw = store.get(DAILY_KEY);
    if (raw && raw.d === todayKey()) {
      return {
        d: raw.d,
        pnl: Number.isFinite(raw.pnl) ? raw.pnl : 0,
        acct: raw.acct && typeof raw.acct === 'object' ? { ...raw.acct } : {},
        start: raw.start && typeof raw.start === 'object' ? { ...raw.start } : {},
      };
    }
    return { d: todayKey(), pnl: 0, acct: {}, start: {} };
  }

  /** Realized bot P&L for today — one account's, or every account's. */
  function dailyPnl(account) {
    const record = dailyRecord();
    if (account === undefined) return record.pnl;
    return Number.isFinite(record.acct[account]) ? record.acct[account] : 0;
  }

  function addDailyPnl(delta, account) {
    const record = dailyRecord();
    record.pnl = +(record.pnl + delta).toFixed(2);
    record.acct[account] = +(dailyPnl(account) + delta).toFixed(2);
    store.set(DAILY_KEY, record);
    return record.acct[account];
  }

  /** The feed's balance for an account, or null while unknown. A zero or
      negative figure is "unknown" too: the platform reports 0 for an
      account that was never funded, and a 10% cap on nothing is a lockout. */
  function accountBalance(account) {
    if (!feed.balance || (account !== 'demo' && account !== 'live')) return null;
    const value = feed.balance[account];
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** The balance an account had when the bot first traded on it today —
      recorded on first use, so a day's limits do not drift with the P&L
      they measure. Null while the feed has not reported the balance. */
  function dailyStartBalance(account) {
    const record = dailyRecord();
    if (Number.isFinite(record.start[account]) && record.start[account] > 0) {
      return record.start[account];
    }
    const balance = accountBalance(account);
    if (balance === null) return null;
    record.start[account] = balance;
    store.set(DAILY_KEY, record);
    return balance;
  }

  /**
   * Today's limits for an account in dollars: the loss cap (percentage or
   * absolute — whichever is set and nearer) and the profit target, each
   * null when not in force. Read-only: an account whose starting balance
   * was never recorded only has the absolute cap.
   */
  function dailyLimits(account) {
    const record = dailyRecord();
    const today = Number.isFinite(record.acct[account]) ? record.acct[account] : 0;
    const start = Number.isFinite(record.start[account]) && record.start[account] > 0
      ? record.start[account] : null;
    let cap = CONFIG.DAILY_LOSS_CAP > 0 ? CONFIG.DAILY_LOSS_CAP : null;
    if (start !== null && CONFIG.DAILY_LOSS_CAP_PCT > 0) {
      const pctCap = start * CONFIG.DAILY_LOSS_CAP_PCT / 100;
      cap = cap === null ? pctCap : Math.min(cap, pctCap);
    }
    const target = start !== null && CONFIG.DAILY_PROFIT_TARGET_PCT > 0
      ? start * CONFIG.DAILY_PROFIT_TARGET_PCT / 100 : null;
    return { today, start, cap, target };
  }

  /** Which daily limit today's P&L on this account has crossed, if any:
      'daily cap' or 'daily target'. */
  function dailyBreach(account) {
    const { today, cap, target } = dailyLimits(account);
    if (cap !== null && today <= -cap) return 'daily cap';
    if (target !== null && today >= target) return 'daily target';
    return null;
  }

  /**
   * The hit-rate evidence behind a signal, for Kelly sizing: the qualified
   * variant's Wilson lower bound in auto mode, or this session's real record
   * once it has 30 decided trades. Null for the entries that carry none —
   * the instant entry after Start, the keep-trading fallback, an unproven
   * fixed model — which then ride the minimum stake.
   */
  function stakeEvidence(view) {
    if (!view || !view.signal) return null;
    if (Number.isFinite(view.lowerBound)) return view.lowerBound;
    if (view.reason === 'instant entry' || view.reason === 'keep trading') return null;
    const decided = bot.wins + bot.losses;
    if (decided < 30) return null;
    return AP.wilsonLowerBound(bot.wins, decided, CONFIG.AUTO_CONFIDENCE_Z);
  }

  /**
   * The stake CONFIG.STAKE_MODE wants for this entry, in dollars, or null to
   * leave the platform's amount alone (mode off, or the figure it needs —
   * the balance, the payout — is not known yet).
   */
  function plannedStake(view) {
    const mode = CONFIG.STAKE_MODE;
    const floor = Math.max(0.01, CONFIG.STAKE_MIN);
    if (mode === 'fixed') return Math.max(floor, Math.round(CONFIG.STAKE_VALUE * 100) / 100);
    if (mode !== 'percent' && mode !== 'kelly') return null;
    const account = bot.running ? bot.account : accountType();
    const balance = accountBalance(account);
    if (balance === null) return null;
    if (mode === 'percent') {
      return humanized(Math.max(floor, Math.round(balance * CONFIG.STAKE_VALUE) / 100), floor);
    }
    return humanized(AP.kellyStake({
      balance,
      payoutPct: panel.payoutPct === null ? ASSUMED_PAYOUT_PCT : panel.payoutPct,
      hitRate: stakeEvidence(view),
      fraction: CONFIG.KELLY_FRACTION,
      maxPct: CONFIG.STAKE_MAX_PCT,
      minStake: floor,
    }), floor);
  }

  /** STAKE_HUMAN: the sizer's figure as a person would type it (null passes through). */
  const humanized = (amount, floor) =>
    (amount === null || !CONFIG.STAKE_HUMAN) ? amount : AP.humanStake(amount, floor);

  /** The most any single stake may be: STAKE_MAX_PCT of the balance under
      kelly sizing; the other modes carry their own figure. */
  function stakeCeiling() {
    if (CONFIG.STAKE_MODE !== 'kelly') return Infinity;
    const balance = accountBalance(bot.running ? bot.account : accountType());
    return balance === null ? Infinity : balance * CONFIG.STAKE_MAX_PCT / 100;
  }

  /** "$ 1,250.50" -> 1250.5; a comma with one or two digits after it is a
      decimal comma. Null when the text is not an amount. */
  function parseAmount(text) {
    let s = String(text || '').replace(/[$\s]/g, '');
    if (!s) return null;
    s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    const value = Number(s);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  /** The platform's amount input: numeric-looking value (not a duration),
      inside the trade panel column, nearest the buttons. Cached like the
      other panel nodes. */
  function findStakeInput() {
    const up = findTradeButton('UP');
    if (!up) return null;
    const anchor = up.button.getBoundingClientRect();
    const valid = (node) => {
      if (!node || !node.isConnected || !(node instanceof HTMLInputElement)) return false;
      const value = (node.value || '').trim();
      if (value.length === 0 || value.length > 12) return false;
      if (DURATION_RE.test(value)) return false;
      if (!/^[$\s]*\d[\d.,]*$/.test(value)) return false;
      return inPanelColumn(node.getBoundingClientRect(), anchor);
    };
    if (valid(panel.stakeNode)) return panel.stakeNode;
    panel.stakeNode = null;
    let best = null;
    let bestDist = Infinity;
    for (const node of document.querySelectorAll('input')) {
      if (!valid(node)) continue;
      const dist = Math.abs(node.getBoundingClientRect().top - anchor.top);
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    panel.stakeNode = best;
    return best;
  }

  /** Write the planned stake into the platform's amount field. Uses the
      native value setter + an input event so React-style UIs register it.
      Best-effort by design: a failure logs and the trade proceeds with
      whatever amount is already set. */
  function setStake(amount) {
    if (CONFIG.STAKE_MODE === 'off') return;
    if (amount === null) {
      log('Stake (' + CONFIG.STAKE_MODE + '): balance unknown — leaving the amount as-is.');
      return;
    }
    const input = findStakeInput();
    if (!input) {
      log('Stake: amount input not found — leaving the amount as-is.');
      return;
    }
    // The field is only touched when the stake actually changes: the same
    // figure is never retyped, and under STAKE_HUMAN a figure close enough
    // to the sizer's (and under the cap) is kept as it is.
    const current = parseAmount(input.value);
    if (current !== null && current > 0) {
      if (current === amount) return;
      const band = CONFIG.STAKE_HUMAN && CONFIG.STAKE_MODE !== 'fixed'
        ? current * (CONFIG.STAKE_STICKY_PCT * profile.sticky / 100) : 0;
      if (band > 0 && Math.abs(current - amount) <= band && current <= stakeCeiling()) {
        log('Stake left at $' + current + ' (sizer: $' + amount + ', within ' + CONFIG.STAKE_STICKY_PCT + '%)');
        return;
      }
    }
    // Android: the figure is typed for real. The field is focused and its
    // text selected here (both plain API calls, no synthetic events), the
    // app then sends the digits as key events, and the click that follows
    // queues up behind them (shim.js -> Bridge.type / Input).
    if (nativeType(input, amount)) return;
    // Elsewhere: typed key by key on the gesture timeline (humanType), the
    // click queued behind it. The instant setter below is the fallback.
    if (CONFIG.HUMAN_CLICK) {
      const ms = humanType(input, String(amount));
      if (ms !== null) {
        log('Stake set to $' + amount + ' (' + CONFIG.STAKE_MODE + ') — typed, done in ' + (ms / 1000).toFixed(1) + ' s');
        return;
      }
    }
    try {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(amount));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      log('Stake set to $' + amount + ' (' + CONFIG.STAKE_MODE + ')');
    } catch (error) {
      console.debug('[AutoTrade] Stake set failed:', error);
    }
  }

  /** The Android app types the stake (see setStake). True when it will. */
  function nativeType(input, amount) {
    const type = globalThis.__nexaNativeType;
    if (typeof type !== 'function') return false;
    const text = String(amount);
    if (!/^[0-9.]{1,12}$/.test(text)) return false;
    try {
      input.focus();
      input.select();
    } catch (_) {
      return false;
    }
    let queued = false;
    try { queued = type(text) === true; } catch (_) { queued = false; }
    if (queued) log('Stake typed: $' + amount + ' (' + CONFIG.STAKE_MODE + ')');
    return queued;
  }

  /* =======================================================================
     5. Strategy
     ======================================================================= */

  const decide = NexaStrategy.decide;

  /** Short labels so the reason fits the widget's single status line. */
  const REASON_LABEL = {
    'aligned drift above z threshold': 'SIGNAL',
    'momentum crossover': 'SIGNAL',
    'trend state': 'TREND',
    'instant entry': 'INSTANT (trend state)',
    'keep trading': 'KEEP TRADING (trend state)',
    'flat trend': 'flat',
    'stale signal': 'stale signal (tab throttled?)',
    'insufficient trend evidence': 'weak trend',
    'noisy path': 'noisy',
    'no crossover': 'no cross',
    'weak momentum': 'weak momo',
    'volatility limit': 'too volatile',
    'zero variance': 'flat',
    'insufficient returns': 'few returns',
    'invalid price': 'bad price',
    'invalid config': 'BAD CONFIG',
    'invalid input': 'bad input',
  };

  /* =======================================================================
     5b. Auto mode — self-calibrating shadow scoreboard

     A pool of strategy variants runs virtually on every sample: signals are
     noted (never clicked), settled one expiry later against the real price,
     and tallied into a rolling per-variant record. Real clicks require a
     variant to PROVE itself first: at least AUTO_MIN_SAMPLES decided
     outcomes with a hit-rate clearing break-even by AUTO_MARGIN. The pool
     also carries the two upgrades that need no pre-recorded data: regime-
     gated variants (R*) that only fire when the efficiency ratio says the
     market is actually trending, and an adaptive-z variant (ZA) whose
     threshold tracks the p90 of the |z| values this feed really produces.
     Pure math lives in autopilot.js; this section owns state and storage.
     ======================================================================= */

  const AP = NexaAutopilot;

  const SHADOW_TOLERANCE_MS = 5_000;  // data hole at expiry → outcome unknowable
  const ASSUMED_PAYOUT_PCT = 85;      // qualification bar when payout is unreadable

  let variantCache = { label: null, pool: [] };

  /** The pool for the horizon in force right now (built in horizons.js so
      the backtester runs the identical pool for a given expiry). */
  function VARIANTS_POOL() {
    const row = horizonFor(effectiveExpirySec());
    if (variantCache.label !== row.label) {
      variantCache = {
        label: row.label,
        pool: NexaHorizons.buildVariants(row, CONFIG.MAX_REALIZED_VOLATILITY),
      };
    }
    return variantCache.pool;
  }

  const auto = {
    stats: null,        // {variantId: 'wwl...'} for the current symbol+expiry
    statsKey: null,     // store key the stats belong to
    pendings: [],       // open virtual trades awaiting expiry
    zBuffer: [],        // recent |z| samples feeding the adaptive threshold
    zaThreshold: 1.5,
    lastSaveAt: 0,
    lastSummaryAt: 0,
    qualifiedId: null,  // for change logging only
  };

  // Real (clicked) outcomes are tallied under this prefix in the same
  // scoreboard, keyed by the variant that fired — the gap between a variant's
  // virtual and real hit-rate is the one calibration number the shadow
  // record cannot produce on its own (slippage, server settlement, latency).
  const REAL_PREFIX = 'real:';

  function statsStorageKey() {
    const sym = symbolLock.key || normalizeSymbol(feed.symbol || '') || 'unknown';
    return SCORES_PREFIX + sym + '.' + effectiveExpirySec();
  }

  /** Load the right scoreboard for the current symbol+expiry, saving and
      resetting transient state when either changed. */
  function ensureStatsBucket() {
    const key = statsStorageKey();
    if (auto.statsKey === key && auto.stats !== null) return;
    if (auto.stats !== null && auto.statsKey !== null) saveStats(true);
    auto.statsKey = key;
    const stored = store.get(key);
    auto.stats = stored && typeof stored === 'object' ? { ...stored } : {};
    // Pendings and the z-distribution belong to the previous bucket.
    auto.pendings = [];
    auto.zBuffer.length = 0;
    auto.qualifiedId = null;
  }

  function saveStats(force) {
    if (auto.stats === null || auto.statsKey === null) return;
    const now = Date.now();
    if (!force && now - auto.lastSaveAt < 30_000) return;
    auto.lastSaveAt = now;
    store.set(auto.statsKey, auto.stats);
  }

  function variantStats(variantId) {
    return AP.statsOf(auto.stats === null ? '' : auto.stats[variantId]);
  }

  /** Real-click record of one variant (see REAL_PREFIX). */
  function realStats(variantId) {
    return variantStats(REAL_PREFIX + variantId);
  }

  function currentBreakEven() {
    return AP.breakEvenRate(panel.payoutPct === null ? ASSUMED_PAYOUT_PCT
                                                     : panel.payoutPct);
  }

  function qualifyOpts() {
    return {
      breakEven: currentBreakEven(),
      minSamples: CONFIG.AUTO_MIN_SAMPLES,
      margin: CONFIG.AUTO_MARGIN,
      confidenceZ: CONFIG.AUTO_CONFIDENCE_Z,
    };
  }

  function currentBestQualified() {
    return AP.bestQualified(VARIANTS_POOL().map((v) => v.id), variantStats, qualifyOpts());
  }

  /** "62%/140 (LB 55%)" — observed hit-rate, decided outcomes, Wilson lower bound. */
  function describeRecord(stats, lowerBound) {
    const lb = lowerBound === undefined
      ? AP.wilsonLowerBound(stats.wins, stats.n, CONFIG.AUTO_CONFIDENCE_Z)
      : lowerBound;
    return Math.round(stats.hitRate * 100) + '%/' + stats.n +
      (lb === null ? '' : ' (LB ' + Math.round(lb * 100) + '%)');
  }

  function noteOutcome(variantId, outcome) {
    auto.stats[variantId] = AP.recordOutcome(
      auto.stats[variantId], outcome, CONFIG.AUTO_ROLLING);
    saveStats(false);

    const best = currentBestQualified();
    const bestId = best === null ? null : best.id;
    if (bestId !== auto.qualifiedId) {
      auto.qualifiedId = bestId;
      if (bestId === null) {
        log('Auto: no variant above the bar any more — real trades on hold.');
      } else {
        log('Auto: ' + bestId + ' qualified at ' + describeRecord(best.stats, best.lowerBound) +
            ' — real trades enabled.');
      }
    }
  }

  /** A clicked trade settled: tally it against the variant that fired it. */
  function noteRealOutcome(variantId, profit) {
    if (!variantId || auto.stats === null) return;
    const outcome = profit > 0 ? 'w' : profit < 0 ? 'l' : 'd';
    const key = REAL_PREFIX + variantId;
    auto.stats[key] = AP.recordOutcome(auto.stats[key], outcome, CONFIG.AUTO_ROLLING);
    saveStats(false);
    const real = realStats(variantId);
    const virt = variantStats(variantId);
    if (real.n >= 10 && virt.hitRate !== null && real.hitRate !== null &&
        virt.hitRate - real.hitRate >= 0.08) {
      log('Auto: ' + variantId + ' real ' + Math.round(real.hitRate * 100) + '%/' + real.n +
          ' vs virtual ' + Math.round(virt.hitRate * 100) + '%/' + virt.n +
          ' — the shadow record is flattering this variant (slippage / settlement).');
    }
  }

  function pushZ(absZ) {
    auto.zBuffer.push(absZ);
    if (auto.zBuffer.length > 240) auto.zBuffer.shift();
    if (auto.zBuffer.length >= 40) {
      const p90 = AP.percentile(auto.zBuffer, 0.9);
      if (p90 !== null) auto.zaThreshold = Math.min(3, Math.max(1, p90));
    }
  }

  /**
   * One live sample through the auto system: settle due virtual trades,
   * open new ones, and — only if a variant that fired RIGHT NOW is
   * currently qualified — return a real-trade view for tick().
   * @returns {{signal: string, pct: null, zScore: null, reason: string}|null}
   */
  function autoOnSample(sample) {
    ensureStatsBucket();

    const settled = AP.settlePendings(auto.pendings, sample, SHADOW_TOLERANCE_MS);
    auto.pendings = settled.keep;
    for (const { variantId, outcome } of settled.outcomes) {
      noteOutcome(variantId, outcome);
    }

    const er = AP.efficiencyRatio(bot.history, 30);
    const expiryMs = effectiveExpirySec() * 1000;
    // A real fill lands at the server's price, not the tick on screen, and
    // the measured cost of that on this account is the median slippage. The
    // virtual entry is handicapped by it in the trade's direction, so the
    // shadow record has to beat the same cost a click would — an unadjusted
    // record was flattering every variant by exactly the execution cost,
    // which at a 5s expiry is the size of the whole predicted move.
    const cost = medianSlippagePct();
    const handicap = cost === null ? 0 : cost / 100;
    const fired = [];
    for (const variant of VARIANTS_POOL()) {
      // One open virtual position per variant — overlapping entries would
      // stuff the record with correlated copies of the same market moment.
      if (auto.pendings.some((pending) => pending.variantId === variant.id)) continue;
      if (variant.minER !== undefined && (er === null || er < variant.minER)) continue;
      const config = variant.adaptive
        ? { ...variant.config, Z_SCORE_THRESHOLD: auto.zaThreshold }
        : variant.config;
      const result = decide(bot.history, config);
      if (variant.adaptive && result.zScore !== null &&
          Number.isFinite(result.zScore) && result.zScore !== 0) {
        pushZ(Math.abs(result.zScore));
      }
      if (result.signal) {
        auto.pendings.push({
          variantId: variant.id,
          dir: result.signal,
          price: result.signal === 'UP'
            ? sample.price * (1 + handicap)
            : sample.price * (1 - handicap),
          expiresAt: sample.t + expiryMs,
        });
        // pct rides along so the edge-vs-cost gate can judge an auto signal
        // too; it used to be dropped and auto trades skipped that check.
        fired.push({ id: variant.id, dir: result.signal, pct: result.pct });
      }
    }

    const best = AP.bestQualified(fired.map((f) => f.id), variantStats, qualifyOpts());
    if (best === null) return null;
    const chosen = fired.find((f) => f.id === best.id);
    return {
      signal: chosen.dir,
      pct: Number.isFinite(chosen.pct) ? chosen.pct : null,
      zScore: null,
      variantId: best.id,
      // The evidence Kelly sizing runs on — the bound, never the raw ratio.
      lowerBound: best.lowerBound,
      reason: 'auto ' + best.id + ' ' + describeRecord(best.stats, best.lowerBound),
    };
  }

  /** Status view for auto-mode ticks with no real signal. */
  function autoIdleView() {
    if (bot.history.length < CONFIG.SLOW_WINDOW + 1) {
      return { signal: null, pct: null, zScore: null, reason: 'warming up' };
    }
    const best = currentBestQualified();
    if (best !== null) {
      return {
        signal: null, pct: null, zScore: null,
        reason: 'auto ' + best.id + ' ' + describeRecord(best.stats, best.lowerBound) + ' armed',
      };
    }
    let topN = 0;
    for (const variant of VARIANTS_POOL()) {
      topN = Math.max(topN, variantStats(variant.id).n);
    }
    return {
      signal: null, pct: null, zScore: null,
      reason: 'learning ' + topN + '/' + CONFIG.AUTO_MIN_SAMPLES,
    };
  }

  /** "M10/30 62%/140 (LB 55%) real 58%/12" per variant, for the log and the
      stats panel. */
  function scoreboardLines() {
    return VARIANTS_POOL().map((variant) => {
      const stats = variantStats(variant.id);
      const real = realStats(variant.id);
      return variant.id + ' ' + (stats.n === 0 ? '--' : describeRecord(stats)) +
        (real.n === 0 ? '' : ' real ' + Math.round(real.hitRate * 100) + '%/' + real.n);
    });
  }

  function logScoreboard() {
    const bar = Math.round((currentBreakEven() + CONFIG.AUTO_MARGIN) * 100);
    log('Scoreboard (lower bound ' + bar + '%+ over ' + CONFIG.AUTO_MIN_SAMPLES + '): ' +
        scoreboardLines().join(' | ') +
        (auto.zBuffer.length >= 40
          ? ' | zA thr ' + auto.zaThreshold.toFixed(2) : ''));
  }

  /* =======================================================================
     6. Bot loop
     ======================================================================= */

  const bot = {
    timerId: null,
    running: false,
    runId: 0,            // increments per start; stale confirm timers check it
    history: [],
    trades: [],
    lastTradeAt: 0,
    tradeCount: 0,
    confirmed: 0,
    unconfirmed: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    lossStreak: 0,       // consecutive losses; reset per run and on any win
    reasonCounts: {},    // status-reason histogram for the stats panel
    buttonMisses: 0,     // consecutive ticks the trade button could not be resolved
    staleSignals: 0,     // signals skipped because their sample was too old
    instantUntil: 0,     // TRADE_ON_START: try the instant entry until this time
    runStartedAt: 0,     // reference for the keep-trading idle clock
    pausedUntil: 0,      // RUN_UNTIL_STOPPED: no clicks until then (analysis continues)
    pauseReason: null,
    unconfirmedPauses: 0, // how often "clicks not registering" paused this run (backoff)
    account: null,       // 'demo' | 'live' — the route the run started on
    lastWhy: null,       // the caption's one-line reason from the last tick
    hourlyTrades: [],     // timestamps of trades executed in the last 60 minutes
    nextCooldownJitter: 0,// random jitter added to the cooldown after each trade
    sessionStartedAt: 0,  // work interval reference for rest cycles
    sessionDurationMs: 0, // randomized duration of the current work interval
    pendingReaction: false,// true while a human reaction delay is running
    missUntil: 0,         // a signal was let go on purpose (SKIP_SIGNAL_PCT): no clicks until then
  };

  // Live-account confirmation (CONFIG.LIVE_ACCOUNT === 'confirm'): a second
  // tap on the pill inside the window says yes, for the rest of the page
  // session. A reload asks again.
  const LIVE_CONFIRM_WINDOW_MS = 6_000;
  let liveConfirmed = false;
  let liveConfirmUntil = 0;

  function liveAllowed() {
    if (CONFIG.LIVE_ACCOUNT === 'allow') return true;
    if (CONFIG.LIVE_ACCOUNT === 'confirm') return liveConfirmed;
    return false;
  }

  /* ---- Per-install timing profile ---------------------------------------
     Two installs of this bot with the same numbers trade with the same
     rhythm, and accounts that share a rhythm can be grouped. Each install
     therefore draws its own multipliers once, keeps them in storage, and
     applies them wherever a human-timing number is used: reaction delay,
     cooldown jitter, work and rest intervals, the miss rate, the stake
     stickiness, the pace of the mouse (move) and where on a button the
     press tends to land (aimX/aimY: a fraction of its width/height off
     centre, the habit of one hand). The popup shows the nominal numbers;
     the effective ones are those times the profile, which is logged at
     boot. */
  const PROFILE_KEY = 'nexa.autotrade.profile';
  const PROFILE_RANGES = Object.freeze({
    reaction: [0.8, 1.4], jitter: [0.7, 1.6], session: [0.75, 1.35],
    rest: [0.7, 1.6], skip: [0.7, 1.4], sticky: [0.8, 1.3],
    move: [0.8, 1.3], aimX: [-0.08, 0.08], aimY: [-0.08, 0.08],
  });
  const profile = { reaction: 1, jitter: 1, session: 1, rest: 1, skip: 1, sticky: 1, move: 1, aimX: 0, aimY: 0 };

  const profileValue = (key, value) => Number.isFinite(value) &&
    value >= PROFILE_RANGES[key][0] && value <= PROFILE_RANGES[key][1];
  /** A stored profile whose every value present is in range (a corrupt one is replaced whole). */
  const profileUsable = (saved) => !!saved && typeof saved === 'object' &&
    Object.keys(PROFILE_RANGES).every((key) => saved[key] === undefined || profileValue(key, saved[key]));

  /**
   * Loads the saved profile, or draws and saves a new one. Values a newer
   * build added are drawn and stored beside the ones the install already
   * had, so its rhythm stays what it was. Returns 'saved', 'extended' or
   * 'new'.
   */
  function loadProfile() {
    const keys = Object.keys(PROFILE_RANGES);
    const saved = store.get(PROFILE_KEY);
    const usable = profileUsable(saved);
    const values = usable ? { ...saved } : { v: 1, created: Date.now() };
    const missing = keys.filter((key) => values[key] === undefined);
    let source = usable ? 'saved' : 'new';
    if (missing.length > 0) {
      const words = new Uint32Array(missing.length);
      crypto.getRandomValues(words);
      missing.forEach((key, index) => {
        const [lo, hi] = PROFILE_RANGES[key];
        values[key] = Math.round((lo + (words[index] / 0x100000000) * (hi - lo)) * 100) / 100;
      });
      store.set(PROFILE_KEY, values);
      if (usable) source = 'extended';
    }
    for (const key of keys) profile[key] = values[key];
    log('Timing profile (' + source + ', fixed for this install): ' +
        keys.map((key) => (key.startsWith('aim')
          ? key + ' ' + (profile[key] >= 0 ? '+' : '') + profile[key].toFixed(2)
          : key + ' ×' + profile[key].toFixed(2))).join(', '));
    return source;
  }

  const rollCooldownJitter = () => Math.floor((CONFIG.COOLDOWN_JITTER_MIN_MS +
    Math.random() * (CONFIG.COOLDOWN_JITTER_MAX_MS - CONFIG.COOLDOWN_JITTER_MIN_MS)) * profile.jitter);
  const rollSessionMs = () => Math.round((CONFIG.SESSION_WORK_MINUTES +
    (Math.random() * 2 - 1) * CONFIG.SESSION_WORK_JITTER_MIN) * profile.session * 60_000);
  const rollBreakMs = () => Math.max(60_000, Math.round((CONFIG.REST_BREAK_MINUTES +
    (Math.random() * 2 - 1) * CONFIG.REST_BREAK_JITTER_MIN) * profile.rest * 60_000));

  /** The gap the bot keeps between trades right now (see COOLDOWN_FROM_EXPIRY). */
  function effectiveCooldownMs() {
    if (!CONFIG.COOLDOWN_FROM_EXPIRY) return CONFIG.TRADE_COOLDOWN_MS;
    const base = Math.max(CONFIG.MIN_COOLDOWN_MS, effectiveExpirySec() * 1000 + CONFIG.SETTLE_MARGIN_MS);
    return base + (bot.nextCooldownJitter || 0);
  }

  /** Caption: account badge · W-L · the running reason (or nothing when idle). */
  // A short-lived caption line for events the tick loop would otherwise only
  // log — the outcome of a click above all. On a phone there is no console
  // and no hover tooltip, so this caption is the only place the user can see
  // whether a trade actually registered, or why one did not fire.
  let captionNotice = { text: '', until: 0 };
  function notice(text, ms) {
    captionNotice = { text, until: Date.now() + (ms || 6000) };
    if (bot.running) setCaption(text);
  }

  function refreshCaption() {
    const account = bot.running ? bot.account : accountType();
    const badge = account === 'live' ? 'LIVE' : account === 'demo' ? 'DEMO' : '—';
    const record = bot.wins + 'W-' + bot.losses + 'L';
    if (bot.running && captionNotice.until > Date.now()) {
      setCaption(captionNotice.text);
      return;
    }
    if (!bot.running) {
      // A recent platform alarm stays on the caption for a while: the pill
      // reverts to TAP TO RUN in seconds, and the reason must outlive that.
      if (lastAlarm && Date.now() - lastAlarm.at < 10 * 60_000) {
        setCaption('ALARM · ' + lastAlarm.reason);
        return;
      }
      setCaption(badge + ' · ' + record + (store.ready ? '' : ' · loading'));
      return;
    }
    const why = bot.lastWhy && bot.lastWhy !== 'RUNNING' ? ' · ' + bot.lastWhy : '';
    setCaption(badge + (CONFIG.DRY_RUN ? ' dry' : '') + ' · ' + record + why);
  }

  /** Pause clicking without stopping the run (RUN_UNTIL_STOPPED). */
  function pauseTrading(ms, reason) {
    bot.pausedUntil = Date.now() + ms;
    bot.pauseReason = reason;
    log('Paused for ' + Math.round(ms / 60_000) + ' min — ' + reason +
        '. Analysis continues; trading resumes automatically. Press Stop to end the run.');
  }

  const mmss = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };

  // Dry-run trades awaiting virtual settlement (see executeTrade / settleDryTrades).
  let dryPendings = [];

  // A transient miss (the button between re-renders, a modal over it) used to
  // stop the whole run on the spot; this many consecutive misses are skipped
  // first. Anything persistent still stops the bot.
  const MAX_BUTTON_MISSES = 3;

  // Executed trades are kept for late order/close matching and for the
  // sparkline. Unbounded growth made both the find() in recordResult and the
  // sparkline loop scale with the whole browsing session.
  const MAX_KEPT_TRADES = 500;

  /**
   * Append one drained quote to the history. A gap wider than
   * MAX_SAMPLE_GAP_MS means the feed dropped out: the returns on either side
   * of it belong to different price contexts, and the catch-up jump would
   * read as a statistically significant move — so the history restarts
   * instead of ever holding a window that spans the gap.
   */
  function pushSample(sample) {
    const last = bot.history[bot.history.length - 1];
    if (last && sample.t - last.t > CONFIG.MAX_SAMPLE_GAP_MS) {
      log('Feed gap of ' + ((sample.t - last.t) / 1000).toFixed(1) +
          's — restarting history');
      bot.history.length = 0;
      feed.lastResetAt = sample.t;
      health.gaps += 1;
    }
    bot.history.push(sample);
    if (bot.history.length > CONFIG.MAX_HISTORY) bot.history.shift();
  }

  /**
   * Post-signal quality gates: reasons a genuine signal still must not
   * become a click right now. Returns a short status label, or null when
   * the path is clear.
   */
  function tradeVeto(now, view, instant) {
    let recent = 0;
    for (let index = bot.history.length - 1; index >= 0; index -= 1) {
      if (now - bot.history[index].t > 10_000) break;
      recent += 1;
    }
    if (recent < CONFIG.MIN_TICKS_10S) return 'thin feed';
    if (now - feed.lastResetAt < CONFIG.POST_RESET_QUIET_MS) return 'stabilizing';
    // Daily limits are about real money: a dry run keeps going (nothing is
    // at stake and its virtual P&L is not what the limits measure).
    if (!CONFIG.DRY_RUN) {
      const breach = dailyBreach(bot.account);
      if (breach !== null) return breach;
    }
    // Hourly trade volume cap (anti-detection / pacing)
    if (CONFIG.MAX_TRADES_PER_HOUR > 0 && !CONFIG.DRY_RUN && !CONFIG.SIGNAL_ONLY) {
      const oneHourAgo = now - 3600_000;
      bot.hourlyTrades = bot.hourlyTrades.filter((t) => t > oneHourAgo);
      if (bot.hourlyTrades.length >= CONFIG.MAX_TRADES_PER_HOUR) {
        return 'hour cap ' + bot.hourlyTrades.length + '/hr';
      }
    }
    // The instant entry after Start is not a model signal, so the quality
    // gates below (candle alignment, edge over cost) do not apply to it —
    // only the safety gates above and the payout gates do.
    if (!instant && CONFIG.ENTRY_WINDOW_SEC > 0 &&
        Math.floor(now / 1000) % 60 >= CONFIG.ENTRY_WINDOW_SEC) {
      return 'wait candle';
    }
    if (CONFIG.MIN_PAYOUT_PCT > 0 && panel.payoutPct !== null &&
        panel.payoutPct < CONFIG.MIN_PAYOUT_PCT) {
      return 'payout ' + panel.payoutPct + '%';
    }
    // The candle trend outranks a 2-minute signal — including the instant
    // and keep-trading entries, which are short-trend tilts. Nothing is
    // held while the candles are warming up (see CONFIG.HTF_FILTER).
    if (CONFIG.HTF_FILTER && view && view.signal) {
      const htf = htfView();
      if (htf.warm && htf.dir !== null && htf.dir !== view.signal) return 'against candle trend';
      if ((view.signal === 'UP' && htf.blockUp) || (view.signal === 'DOWN' && htf.blockDown)) {
        return 'rsi stretched';
      }
    }
    // An unreadable payout used to stand the filter aside — and the auto
    // bar then ASSUMED 85%. At a real payout of 70% that let the bot qualify
    // at 58% and click below the 58.8% break-even: a money gate failing open.
    // Real clicks now wait until the payout is known (from the panel, or from
    // the server's own percentProfit on a confirmed order — see
    // attachOrder); dry-run and signal-only carry on, they risk nothing.
    if (CONFIG.MIN_PAYOUT_PCT > 0 && panel.payoutPct === null &&
        !CONFIG.DRY_RUN && !CONFIG.SIGNAL_ONLY) {
      // ...with one exception: the server's own payout arrives on a confirmed
      // order, and an order needs a click. Hold for PAYOUT_PROBE_AFTER_MS,
      // then let ONE probe through (and at most one per
      // PAYOUT_PROBE_EVERY_MS) — only when the cooldown would let it trade,
      // so the probe is not spent on a tick that could not click anyway.
      if (panel.payoutUnknownSince === 0) panel.payoutUnknownSince = now;
      const cooldownClear = now - bot.lastTradeAt >= effectiveCooldownMs();
      if (!cooldownClear ||
          now - panel.payoutUnknownSince < CONFIG.PAYOUT_PROBE_AFTER_MS ||
          now - panel.payoutProbeAt < CONFIG.PAYOUT_PROBE_EVERY_MS) {
        return 'payout unknown';
      }
      panel.payoutProbeAt = now;
      log('Payout still unreadable after ' +
          Math.round((now - panel.payoutUnknownSince) / 1000) +
          's — allowing one probe trade to learn it from the server.');
    }
    // Predicted move vs measured execution cost. A signal whose whole
    // expected move is smaller than the slippage already observed on this
    // account is a losing bet however good the model is — at a 5s expiry the
    // two are routinely the same size. Stands aside until enough real fills
    // have been measured to know the cost.
    if (!instant && CONFIG.EDGE_OVER_COST > 0 && view && Number.isFinite(view.pct)) {
      const cost = medianSlippagePct();
      if (cost !== null && Math.abs(view.pct) < cost * CONFIG.EDGE_OVER_COST) {
        return 'edge<cost ' + Math.abs(view.pct).toFixed(3) + '%';
      }
    }
    return null;
  }

  /** Histogram bucket for the stats panel: strip volatile numbers so
      "payout 70%" and "payout 72%" count as one gate. */
  function reasonBucket(view, veto) {
    if (veto && veto.startsWith('paused')) return 'held: paused';
    if (veto && veto.startsWith('missed')) return 'held: missed on purpose';
    if (veto) return 'held: ' + veto.replace(/\s*[\d.]+%?/g, '');
    const reason = view.reason;
    if (reason.startsWith('auto ')) return view.signal ? 'auto signal' : 'auto armed';
    if (reason.startsWith('learning')) return 'learning';
    return reason;
  }

  function bumpReason(bucket) {
    if (bot.reasonCounts[bucket] === undefined &&
        Object.keys(bot.reasonCounts).length >= 24) {
      return;   // cap the histogram; 24 buckets is already every known state
    }
    bot.reasonCounts[bucket] = (bot.reasonCounts[bucket] || 0) + 1;
  }

  function tick() {
    if (!bot.running) return;

    const price = readCurrentPrice();

    if (price === null) {
      setStatus(feed.socketOpen ? 'Feed stale — no quotes'
                                : 'Socket closed — waiting for reconnect', 'running');
      return;
    }

    updateTradePanel();
    applyHorizon();   // expiry may have changed on the page between ticks

    // Drain every quote that arrived since the last tick and evaluate the
    // strategy at EACH sample, not just the newest. The momentum model fires
    // only on the exact sample where the EMAs cross — evaluating once per
    // tick over a ~2Hz feed could land a crossover between two evaluations
    // and lose it. A signal found on an intermediate sample wins (the trade
    // executes at the current price either way); otherwise the latest view
    // drives the status line. In auto mode each sample instead runs the
    // whole shadow pool, and a real signal exists only when a QUALIFIED
    // variant fired on that exact sample.
    //
    // A signal is only actionable on a FRESH sample. tick() can be late — a
    // hidden tab's timers run once a minute after five minutes — and then the
    // drain holds signals from long-gone prices. Those still feed the shadow
    // scoreboard (their virtual settlement is timestamped correctly) but they
    // must never become a click at the current price.
    const autoMode = CONFIG.STRATEGY === 'auto';
    const freshAfter = Date.now() - CONFIG.SIGNAL_MAX_AGE_MS;
    let signalView = null;
    let lastView = null;
    let staleSkipped = 0;
    if (feed.pending.length > 0) {
      for (const sample of feed.pending.splice(0)) {
        pushSample(sample);
        settleDryTrades(sample);
        let found = null;
        if (autoMode) {
          found = autoOnSample(sample);
        } else {
          lastView = decide(bot.history, CONFIG);
          if (lastView.signal) found = lastView;
        }
        if (!found || signalView) continue;
        if (sample.t < freshAfter) {
          staleSkipped += 1;
          continue;
        }
        signalView = found;
      }
    }
    if (staleSkipped > 0) {
      bot.staleSignals += staleSkipped;
      log('Skipped ' + staleSkipped + ' stale signal(s) — the loop ran late ' +
          '(background tab?). Keep this tab in the foreground while the bot runs.');
    }
    let view = signalView
      || (staleSkipped > 0
        ? { signal: null, pct: null, zScore: null, reason: 'stale signal' }
        : null)
      || (autoMode ? autoIdleView() : (lastView || decide(bot.history, CONFIG)));

    // Instant first trade (CONFIG.TRADE_ON_START): while the run has placed
    // nothing and its instant window is open, and no model signal fired on
    // this tick, the trend state supplies the direction. The first tick runs
    // synchronously from startBot, so this is the click within a second of
    // Start the user asked for; the window keeps it alive across a few ticks
    // if a safety gate (payout unknown, thin feed) holds the first attempt.
    let instant = false;
    const nowMs = Date.now();
    if (!view.signal && bot.tradeCount === 0 && nowMs < bot.instantUntil) {
      const entry = NexaStrategy.decideTrendState(bot.history, CONFIG);
      if (entry.signal) {
        view = { ...entry, reason: 'instant entry' };
        instant = true;
      }
    }

    // Keep trading (CONFIG.KEEP_TRADING_AFTER_SEC): the model has said
    // nothing since the last trade for longer than the idle limit — take the
    // trend state so the run keeps trading instead of sitting on "no cross"
    // or "learning" for an hour. Same non-model entry as Trade-on-Start, same
    // gate treatment. A model signal on this tick always takes precedence
    // (it would have populated view.signal above).
    if (!view.signal && CONFIG.KEEP_TRADING_AFTER_SEC > 0 && nowMs >= bot.pausedUntil) {
      const idleMs = Math.max(effectiveCooldownMs(), CONFIG.KEEP_TRADING_AFTER_SEC * 1000);
      const since = Math.max(bot.lastTradeAt, bot.runStartedAt);
      if (nowMs - since >= idleMs) {
        const entry = NexaStrategy.decideTrendState(bot.history, CONFIG);
        if (entry.signal) {
          view = { ...entry, reason: 'keep trading' };
          instant = true;
        }
      }
    }

    if (autoMode && nowMs - auto.lastSummaryAt > 300_000) {
      auto.lastSummaryAt = nowMs;
      logScoreboard();
    }

    // Natural human rest cycle breaks
    if (CONFIG.REST_CYCLE_ENABLED && nowMs >= bot.pausedUntil) {
      if (bot.sessionStartedAt && nowMs - bot.sessionStartedAt >= bot.sessionDurationMs) {
        const breakMs = rollBreakMs();
        bot.sessionStartedAt = nowMs + breakMs;
        bot.sessionDurationMs = rollSessionMs();
        pauseTrading(breakMs, 'natural rest break');
        return;
      }
    }

    // A signal is necessary but not sufficient: the quality gates can still
    // hold it back, and the status line must say so — a held signal that
    // reads as plain "SIGNAL" looks like a bot that clicks nothing for no
    // reason. A pause (RUN_UNTIL_STOPPED's replacement for stopping) is the
    // first gate of all.
    const paused = nowMs < bot.pausedUntil
      ? 'paused ' + mmss(bot.pausedUntil - nowMs) + ' (' + bot.pauseReason + ')'
      : null;
    if (!paused && bot.pauseReason !== null) {
      log('Pause over (' + bot.pauseReason + ') — trading resumes.');
      bot.pauseReason = null;
    }
    const missed = nowMs < bot.missUntil
      ? 'missed on purpose ' + mmss(bot.missUntil - nowMs)
      : null;
    const veto = paused || missed || (view.signal ? tradeVeto(nowMs, view, instant) : null);

    // Surface the running analysis AND the blocking reason. Without the
    // reason, a bot that is working correctly but gated by a filter is
    // indistinguishable from a broken one. The pill shows RUNNING/PAUSED,
    // the caption the one-line why; the full readout goes on the tooltip.
    const drift = view.pct === null ? '--' : (view.pct >= 0 ? '+' : '') + view.pct.toFixed(3) + '%';
    const evidence = view.zScore === null ? '--' : 'z=' + view.zScore.toFixed(2);
    const context = CONFIG.HTF_FILTER ? ' · ' + htfLabel(htfView()) : '';
    const warmupTarget = CONFIG.STRATEGY === 'momentum'
      ? CONFIG.EMA_SLOW + 2
      : CONFIG.STRATEGY === 'trend' ? 5
      : CONFIG.SLOW_WINDOW + 1;
    const why = veto ? 'held: ' + veto
      : view.reason === 'warming up'
        ? 'warming up ' + bot.history.length + '/' + warmupTarget
        : (REASON_LABEL[view.reason] || view.reason);
    bumpReason(reasonBucket(view, veto));
    bot.lastWhy = why;
    setStatus(
      (CONFIG.DRY_RUN ? 'Dry ' : '') +
      (feed.symbol || '?') + ' ' + price + ' ' + drift + ' ' + evidence + context +
      ' · ' + why + ' · ' + bot.wins + 'W-' + bot.losses + 'L $' + bot.pnl,
      'running'
    );
    refreshCaption();

    // The session limit only ends the run when the user has opted out of
    // running until Stop; otherwise it is ignored (and greyed out in settings).
    if (!CONFIG.RUN_UNTIL_STOPPED && CONFIG.MAX_TRADES_PER_SESSION &&
        bot.tradeCount >= CONFIG.MAX_TRADES_PER_SESSION) {
      log('Session trade limit reached');
      stopBot('Trade limit reached');
      return;
    }

    if (nowMs - bot.lastTradeAt < effectiveCooldownMs()) return;

    if (view.signal && !veto) {
      if (!instant && !CONFIG.SIGNAL_ONLY && !bot.pendingReaction && skipThisSignal()) {
        const rest = effectiveCooldownMs();
        bot.missUntil = nowMs + rest;
        log('Signal ' + view.signal + ' let go on purpose (SKIP_SIGNAL_PCT ' +
            CONFIG.SKIP_SIGNAL_PCT + '%) — no click for ' + mmss(rest) + '.');
        return;
      }
      if (CONFIG.REACTION_DELAY && !instant && !bot.pendingReaction) {
        bot.pendingReaction = true;
        const delayMs = Math.floor((CONFIG.REACTION_DELAY_MIN_MS + Math.random() * (CONFIG.REACTION_DELAY_MAX_MS - CONFIG.REACTION_DELAY_MIN_MS)) * profile.reaction);
        const capturedSignal = view.signal;
        const capturedVariantId = view.variantId;
        const capturedReason = view.reason;
        const capturedView = view;
        const capturedRunId = bot.runId;
        setTimeout(() => {
          bot.pendingReaction = false;
          if (!bot.running || bot.runId !== capturedRunId || Date.now() < bot.pausedUntil) return;
          if (accountType() !== bot.account) return;
          if (Date.now() - bot.lastTradeAt < effectiveCooldownMs()) return;
          executeTrade(capturedSignal, capturedVariantId, capturedReason, capturedView);
        }, delayMs);
      } else if (!bot.pendingReaction) {
        executeTrade(view.signal, view.variantId, view.reason, view);
      }
    }
  }

  /** SKIP_SIGNAL_PCT: the roll that lets a model signal go by. */
  function skipThisSignal() {
    const pct = CONFIG.SKIP_SIGNAL_PCT;
    return Number.isFinite(pct) && pct > 0 && Math.random() * 100 < Math.min(100, pct * profile.skip);
  }

  /* ---- Platform alarm (CONFIG.PLATFORM_ALARM) --------------------------
     The platform showing a challenge or a warning is the one moment a bot
     must not keep clicking. Three tells, cheapest first: the route (thrown
     back to the login page), a captcha / human-check widget, and the text
     of anything modal-like or notification-like that is actually visible.
     The widget itself lives in a closed shadow root and is never matched. */
  const ALARM_KEY = 'nexa.autotrade.alarm';
  const ALARM_LOGIN_PATH = /\/(?:sign-?in|log-?in|auth)(?:\/|$)/i;
  const ALARM_WIDGETS =
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], ' +
    'iframe[src*="turnstile"], iframe[src*="arkoselabs"], iframe[src*="geetest"], ' +
    '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #challenge-running, #cf-challenge-running';
  const ALARM_SURFACES =
    '[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="popup"], [class*="notif"], ' +
    '[class*="alert"], [class*="toast"], [class*="banner"], [class*="warning"]';
  const ALARM_TEXT = new RegExp([
    'unusual activity', 'suspicious activity',
    'automated (?:activity|trading|software|access)',
    '(?:bots?|robots?|scripts?|automation) (?:is|are) (?:not allowed|prohibited|forbidden)',
    'account (?:has been |is |was )?(?:blocked|suspended|restricted|frozen|locked|disabled)',
    'verify (?:that )?you(?:\'| a)?re (?:a )?human', 'are you a (?:robot|human)', 'i am not a robot',
    'security check', 'too many requests', 'access denied',
  ].join('|'), 'i');

  /** What on the page says the platform is alarmed, or null. */
  function platformAlarm() {
    try {
      if (ALARM_LOGIN_PATH.test(location.pathname)) return 'signed out — the platform wants a new login';
      if (document.querySelector(ALARM_WIDGETS)) return 'captcha / human check on the page';
      for (const node of document.querySelectorAll(ALARM_SURFACES)) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;   // not shown
        const hit = ALARM_TEXT.exec((node.textContent || '').slice(0, 2000));
        if (hit) return 'platform notice: "' + hit[0] + '"';
      }
    } catch (_) { /* a page mid-render — the next sweep will look again */ }
    return null;
  }

  let lastAlarm = null;      // { at, reason, path } of the latest alarm this session
  let alarmOnPage = null;    // the reason currently showing, so it is raised once

  function raiseAlarm(reason) {
    lastAlarm = { at: Date.now(), reason, path: location.pathname };
    store.set(ALARM_KEY, lastAlarm);
    const wasRunning = bot.running;
    if (wasRunning) stopBot('Platform alarm — ' + reason);
    else setStatus('Platform alarm — ' + reason, 'stopped');
    refreshCaption();
    log('PLATFORM ALARM: ' + reason + (wasRunning ? ' — the run was stopped.' : '.') +
        ' Use the platform by hand for a while; start the bot again only once the page is normal.');
    beep('DOWN');
    setTimeout(() => beep('DOWN'), 450);
    setTimeout(() => beep('DOWN'), 900);
    if (typeof globalThis.__nexaNotify === 'function') {
      try { globalThis.__nexaNotify('Nexa AI Bot — platform alarm: ' + reason); } catch (_) { /* toast is best-effort */ }
    }
  }

  function alarmSweep() {
    if (!CONFIG.PLATFORM_ALARM) return;
    const reason = platformAlarm();
    if (reason === null) {
      alarmOnPage = null;
      return;
    }
    if (reason === alarmOnPage && !bot.running) return;   // said once; a run in progress still stops
    alarmOnPage = reason;
    raiseAlarm(reason);
  }
  setInterval(alarmSweep, CONFIG.PLATFORM_ALARM_EVERY_MS);

  function startBot() {
    if (bot.running) return;

    // The daily cap and the scoreboards come from chrome.storage, which loads
    // asynchronously at boot (milliseconds, in practice).
    if (!store.ready) {
      setStatus('Loading — tap again in a second', 'stopped');
      return;
    }

    // Refuse to start on a broken setup — a clear error now beats a silent
    // no-op loop later.
    const up = findTradeButton('UP');
    const down = findTradeButton('DOWN');
    if (!up || !down) {
      const missing = [!up && 'UP', !down && 'DOWN'].filter(Boolean).join(' + ');
      log('Cannot start: ' + missing + ' button not found.');
      setStatus(missing + ' button not found', 'stopped');
      return;
    }
    if (readCurrentPrice() === null) {
      log('Cannot start: no live quotes. Is inject.js loaded? Try reloading the page.');
      setStatus('No price feed', 'stopped');
      return;
    }
    const account = accountType();
    if (account === 'unknown') {
      log('Cannot start: this is not the trading page (/trade or /demo-trade).');
      setStatus('Not a trading page', 'stopped');
      return;
    }
    const alarm = CONFIG.PLATFORM_ALARM ? platformAlarm() : null;
    if (alarm) {
      log('Cannot start: platform alarm — ' + alarm + '. Deal with it by hand first.');
      setStatus('Platform alarm — ' + alarm, 'stopped');
      return;
    }
    if (account === 'live' && !liveAllowed()) {
      if (CONFIG.LIVE_ACCOUNT === 'never') {
        log('Cannot start: LIVE account and LIVE_ACCOUNT is "never". Switch to demo.');
        setStatus('Live account blocked', 'stopped');
        return;
      }
      // 'confirm': a second tap on the pill inside the window says yes.
      if (Date.now() < liveConfirmUntil) {
        liveConfirmed = true;
        log('LIVE account confirmed by the user — trading real money.');
      } else {
        liveConfirmUntil = Date.now() + LIVE_CONFIRM_WINDOW_MS;
        setPill('LIVE? TAP AGAIN', 'confirm',
          'This is the LIVE account (real money). Tap again within 6 seconds to start.');
        setCaption('LIVE · real money · tap again to confirm');
        log('LIVE account: real money. Tap the pill again within 6s to confirm.');
        clearTimeout(pillRevertTimer);
        pillRevertTimer = setTimeout(() => {
          pillRevertTimer = null;
          if (!bot.running) { setPill(IDLE_LABEL, 'idle', IDLE_TITLE); refreshCaption(); }
        }, LIVE_CONFIRM_WINDOW_MS);
        return;
      }
    }
    const lock = lockedSymbol();
    if (!lock) {
      // The lock deliberately needs the same reading twice, SYMBOL_RECHECK_MS
      // apart, so the very first Start within ~2s of the quotes arriving
      // always lands here. Say so, instead of reporting it like a failure.
      const soon = symbolLock.pendingKey !== null;
      log(soon
        ? 'Identifying the open chart (' + symbolLock.pendingKey +
          ') — press Start again in a moment.'
        : 'Cannot start: could not tell which chart is open. Wait for quotes.');
      setStatus(soon ? 'Identifying chart — try again in a second'
                     : 'Chart not identified', 'stopped');
      return;
    }
    // Real money: pin today's base balance for this account (first real
    // start of the day records it) and refuse a day that already ended.
    if (!CONFIG.DRY_RUN) {
      const start = dailyStartBalance(account);
      const breach = dailyBreach(account);
      if (breach === 'daily cap') {
        log('Cannot start: daily loss cap already reached ($' + dailyPnl(account) +
            ' on ' + account + ').');
        setStatus('Daily loss cap reached', 'stopped');
        return;
      }
      if (breach === 'daily target') {
        log('Cannot start: daily profit target already reached ($' + dailyPnl(account) +
            ' on ' + account + '). Tomorrow is another day.');
        setStatus('Daily profit target reached', 'stopped');
        return;
      }
      if (start === null && CONFIG.DAILY_LOSS_CAP_PCT > 0 && CONFIG.DAILY_LOSS_CAP <= 0) {
        log('Daily limits: the ' + account + ' balance is not known yet, so the ' +
            CONFIG.DAILY_LOSS_CAP_PCT + '% cap cannot be measured — set DAILY_LOSS_CAP ' +
            '(dollars) for a hard rail until the feed reports it.');
      }
    }
    updateTradePanel();
    applyHorizon();   // tune the windows to this contract before announcing them
    log('Account:', account, '| chart', lock, '| balance', feed.balance);
    log('UP via', up.via, '| DOWN via', down.via, '| feed', feed.symbol, feed.price);
    if (CONFIG.STRATEGY === 'auto') {
      log('Auto mode: ' + VARIANTS_POOL().length + ' variants learning virtually. ' +
          'Real clicks unlock when a variant\'s LOWER confidence bound (z=' +
          CONFIG.AUTO_CONFIDENCE_Z + ') clears ' +
          Math.round((currentBreakEven() + CONFIG.AUTO_MARGIN) * 100) +
          '% over ' + CONFIG.AUTO_MIN_SAMPLES + '+ outcomes ' +
          '(per symbol, per expiry — progress persists across reloads).');
    }

    bot.running = true;
    bot.runId += 1;
    bot.account = account;
    bot.lastWhy = null;
    bot.buttonMisses = 0;
    bot.staleSignals = 0;
    dryPendings = [];
    // Instant first trade: open the window and drop the cooldown the previous
    // run left behind — pressing Start is the user asking for a trade now,
    // and the first tick below is where it happens.
    bot.instantUntil = CONFIG.TRADE_ON_START ? Date.now() + CONFIG.INSTANT_START_WINDOW_MS : 0;
    bot.runStartedAt = Date.now();
    bot.sessionStartedAt = Date.now();
    bot.sessionDurationMs = rollSessionMs();
    bot.nextCooldownJitter = 0;
    bot.pendingReaction = false;
    bot.missUntil = 0;
    bot.pausedUntil = 0;
    bot.pauseReason = null;
    bot.unconfirmedPauses = 0;
    if (CONFIG.RUN_UNTIL_STOPPED) {
      log('Run until Stop: the session limit is off; a loss streak or unconfirmed ' +
          'clicks PAUSE trading instead of ending the run. Only Stop, the daily loss ' +
          'cap or leaving the demo route end it.');
    }
    if (CONFIG.TRADE_ON_START) {
      bot.lastTradeAt = 0;
      log('Trade on Start: placing the first trade on the current trend state ' +
          '(no proven edge — a trend tilt only). Safety gates still apply.');
    }
    // Warm start. The scanner has been buffering this symbol since the page
    // loaded, and a chart switch already seeds from it — but pressing Start
    // discarded all of it and made the user watch "warming up 0/49" for ~25s
    // of ticks that had already arrived. Same gap-free source, same cap.
    bot.history = scannerSeed(lock);
    if (bot.history.length > 0) {
      log('Warm start: seeded', bot.history.length, 'samples from the scanner');
    }
    // Quotes are only buffered while running, but a stop/start leaves the
    // previous run's undrained tail behind — never feed it to the new run.
    feed.pending.length = 0;
    // Per-run counters. Without this reset, a 'Trade limit reached' stop
    // leaves tradeCount at the limit and every restart dies on its first
    // tick; a stale unconfirmed count lets a single miss stop the next run.
    bot.tradeCount = 0;
    bot.confirmed = 0;
    bot.unconfirmed = 0;
    bot.lossStreak = 0;   // a fresh run gets a fresh chance
    // The stats panel calls these "Session", and tradeCount already reset —
    // leaving wins/losses/P&L/reasons behind produced lines like
    // "Session: 0 trades · 3W - 2L". They are per-run counters; reset them
    // with the rest. (Today's realized P&L survives in chrome.storage, which
    // is what the daily cap actually reads.)
    bot.wins = 0;
    bot.losses = 0;
    bot.pnl = 0;
    bot.reasonCounts = {};
    // bot.trades is NOT cleared: an order or a close frame for the previous
    // run can still arrive inside its 15s window. Trim it instead so a long
    // session cannot grow the array (and the sparkline loop) without bound.
    if (bot.trades.length > MAX_KEPT_TRADES) {
      bot.trades.splice(0, bot.trades.length - MAX_KEPT_TRADES);
    }

    setStatus(CONFIG.DRY_RUN ? 'Running (dry run)' : 'Running', 'running');
    refreshCaption();
    log('Started on the ' + account.toUpperCase() + ' account. DRY_RUN =', CONFIG.DRY_RUN);

    // Interval before the immediate tick: if that tick stops the bot,
    // stopBot must find timerId set, or the interval would leak forever.
    bot.timerId = setInterval(tick, CONFIG.TICK_MS);
    tick();                                          // don't wait a full second
  }

  /** @param {string} [reason] shown on the widget instead of the generic 'Stopped' */
  function stopBot(reason) {
    if (!bot.running) return;
    bot.running = false;
    bot.pendingReaction = false;

    if (bot.timerId) {
      clearInterval(bot.timerId);
      bot.timerId = null;
    }

    setStatus(reason || 'Stopped', 'stopped');
    refreshCaption();
    log('Stopped after', bot.tradeCount, 'trades —', bot.confirmed, 'confirmed');
  }

  /* =======================================================================
     7. Wiring + debug helpers
     ======================================================================= */

  ui.root.addEventListener('pointerdown', unlockAudio, { passive: true });

  // One pill: Start when idle, Stop when running. A live-account start needs
  // a second tap (see startBot), which is the same click.
  ui.pill.addEventListener('click', () => {
    unlockAudio();
    if (bot.running) stopBot();
    else startBot();
  });

  openRecorder();

  // Everything persisted arrives together once chrome.storage has answered
  // (a few ms; the pill says LOADING if tapped before that).
  loadStore((lifted) => {
    // The old settings panel, dry-run toggle and recorder button are gone;
    // their stored values would otherwise silently override CONFIG with no
    // way to see or change them. The popup's prefs are the one override
    // that IS visible — applied here, and again on every change.
    for (const key of [SETTINGS_KEY, DRY_RUN_KEY, REC_KEY]) store.remove(key);
    applyPrefs(store.get(PREFS_KEY), 'saved');
    loadProfile();
    requestAnimationFrame(() => restorePosition(ui.root));
    refreshCaption();
    if (lifted.length > 0) {
      log('Moved ' + lifted.length + ' item(s) from the page\'s localStorage into ' +
          'extension storage; old v1 scoreboards were dropped (see SCORES_PREFIX).');
    }
  });

  // Idle refresh: the account badge follows the route if the user switches
  // accounts while the bot is stopped; a pause countdown ticks while paused.
  const captionTimer = setInterval(() => {
    if (!bot.running) refreshCaption();
    else if (bot.pausedUntil > Date.now()) setStatus(ui.pill.title, 'running');
  }, 1_000);

  // pagehide fires for real unloads AND for entry into the back/forward
  // cache. Trading must stop either way, but the mount observer may only be
  // torn down on a real unload — a bfcache restore re-shows the page without
  // re-running any script, so the observer has to survive it.
  cleanupExtras = () => {
    clearInterval(captionTimer);
    if (recorder.flushTimer) {
      clearInterval(recorder.flushTimer);
      recorder.flushTimer = null;
    }
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    if (pillRevertTimer) {
      clearTimeout(pillRevertTimer);
      pillRevertTimer = null;
    }
  };

  window.addEventListener('pagehide', (event) => {
    stopBot();
    flushRecorder();   // best effort — an interrupted flush only loses seconds
    saveStats(true);   // learning must survive the reload
    if (!event.persisted) cleanupMount();
  });

  // Read-only view of the live state for selftest.js and the DOM harness,
  // plus the tools the old panels exposed. Isolated-world global: invisible
  // to the page. From the DevTools console (context "Nexa AI Bot"):
  //   __nexaDebug.config.DRY_RUN = true          // virtual trades only
  //   __nexaDebug.config.STRATEGY = 'trend'      // see CONFIG for the rest
  //   __nexaDebug.recorder.enabled = true        // journal ticks for tools/backtest.js
  //   __nexaDebug.exportTicks(); __nexaDebug.exportTradesCsv();
  //   __nexaDebug.scoreboard()                   // auto-mode records
  hiddenGlobal('__nexaDebug', Object.freeze({
    get panel() { return panel; },
    get bot() { return bot; },
    get feed() { return feed; },
    get auto() { return auto; },
    get config() { return CONFIG; },
    get recorder() { return recorder; },
    get storeReady() { return store.ready; },
    get liveConfirmed() { return liveConfirmed; },
    exportTicks: exportRecording,
    exportTradesCsv,
    scoreboard: () => (auto.stats === null ? [] : scoreboardLines()),
    scanner: () => scannerTop(8),
    htf: htfView,
    simulateClick,
    humanClick,
    humanType,
    landingPoint,
    get gesture() { return gesture; },
    get realPointer() { return realPointer; },
    get pointerState() { return pointerState; },
    setStake,
    get alarm() { return lastAlarm; },
    platformAlarm,
    get profile() { return { ...profile }; },
    loadProfile,
    // The storage cache, for the smoke harness (chrome.storage is loaded once).
    store: { get: (key) => store.get(key), set: (key, value) => store.set(key, value), remove: (key) => store.remove(key) },
  }));

  /* =======================================================================
     7b. Settings + popup channel

     The popup (popup.js) edits the user-facing subset of CONFIG described
     in settings.js and stores only the values that differ from the
     defaults under PREFS_KEY. This side sanitizes and applies them at boot
     and on every change, so a knob turned in the popup takes effect on the
     next tick — mid-run included; every knob is read where it is used.
     The popup also asks for a status snapshot once a second while open and
     sends Start / Stop / export commands, all over chrome.runtime messages
     (only the extension's own pages can send those).
     ======================================================================= */

  /**
   * Lay the saved overrides over CONFIG; every schema key the overrides do
   * not mention goes back to its default. Invalid values are ignored, not
   * clamped — a money knob outside its rails must fall back to the default
   * rather than to something the user never typed.
   * @returns {string[]} the "KEY=value" changes applied
   */
  function applyPrefs(raw, source) {
    const { overrides, rejected } = NexaSettings.sanitize(raw);
    const changed = [];
    for (const row of NexaSettings.SCHEMA) {
      const next = Object.prototype.hasOwnProperty.call(overrides, row.key)
        ? overrides[row.key] : USER_DEFAULTS[row.key];
      if (CONFIG[row.key] === next) continue;
      CONFIG[row.key] = next;
      changed.push(row.key + '=' + next);
    }
    recorder.enabled = CONFIG.RECORD_TICKS;
    if (rejected.length > 0) {
      log('Settings: ignored invalid value(s) for ' + rejected.join(', ') + ' — defaults kept.');
    }
    if (changed.length > 0) log('Settings (' + source + '): ' + changed.join(', '));
    return changed;
  }

  if (store.area && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[PREFS_KEY]) return;
      const next = changes[PREFS_KEY].newValue;
      if (next === undefined) store.cache.delete(PREFS_KEY);
      else store.cache.set(PREFS_KEY, next);
      applyPrefs(next, 'popup');
    });
  }

  /** What the popup shows: the pill, the counters, today's limits, the
      candle context, the recorder — nothing the widget does not already know. */
  function statusSnapshot() {
    const account = bot.running ? bot.account : accountType();
    const limits = dailyLimits(account);
    const best = CONFIG.STRATEGY === 'auto' && auto.stats !== null ? currentBestQualified() : null;
    return {
      running: bot.running,
      state: ui.root.dataset.state,
      pill: ui.pillText.textContent,
      account,
      balance: accountBalance(account),
      dry: CONFIG.DRY_RUN,
      symbol: feed.symbol,
      price: readCurrentPrice(),
      wins: bot.wins,
      losses: bot.losses,
      pnl: bot.pnl,
      trades: bot.tradeCount,
      why: bot.running ? bot.lastWhy : null,
      htf: CONFIG.HTF_FILTER && symbolLock.key ? htfLabel(htfView()) : null,
      qualified: best === null ? null
        : 'auto ' + best.id + ' ' + describeRecord(best.stats, best.lowerBound) + ' armed',
      daily: { pnl: limits.today, start: limits.start, cap: limits.cap, target: limits.target },
      recorder: { enabled: recorder.enabled, rows: recorder.count, open: recorder.db !== null },
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;
      switch (message.type) {
        case 'nexa:status': sendResponse(statusSnapshot()); break;
        case 'nexa:start': startBot(); sendResponse(statusSnapshot()); break;
        case 'nexa:stop': stopBot(); sendResponse(statusSnapshot()); break;
        case 'nexa:export-ticks': exportRecording(); sendResponse({ ok: true }); break;
        case 'nexa:export-trades': exportTradesCsv(); sendResponse({ ok: true }); break;
        case 'nexa:log': sendResponse({ lines: logLines.slice(), environment: environment }); break;
        case 'nexa:export-log': exportLog(); sendResponse({ ok: true }); break;
        default: return false;
      }
      return false;
    });
  }

  /** The log tail as a text file — Downloads/NexaAIBot on the phone. */
  function exportLog() {
    try {
      const lines = [environment].concat(logLines.map((line) => new Date(line.t).toISOString() + '  ' + line.text));
      downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }), 'nexa-log-' + fileStamp() + '.txt');
      log('Exported', logLines.length, 'log lines.');
    } catch (error) {
      log('Log export failed:', error);
    }
  }

  const environment = environmentLine();
  log(environment);
  log('Loaded. Tap the pill to start.');
})();
