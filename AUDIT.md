# Nexa AI Bot — deep audit

Chrome MV3 extension, audited 19 Sep 2026. Method: full static read of
`manifest.json`, `content.js` (2750 lines), `inject.js`, `strategy.js`,
`autopilot.js`, `style.css`, plus a headless-Chromium harness that mounts the
real content script on a mock Quotex page and drives a fake Socket.IO feed
(quotes, balance, `s_orders/open`, `s_orders/close`, socket drop).

`node --test` was green before and after (37/37). The browser suite
(`harness/verify.js`) is 25 assertions, all green after the fixes.

---

## P0 — the widget was unusable on a fresh load

### 1. `[hidden]` did nothing, so both panels and the alert were permanently open

`content.js` hides the settings panel, the stats panel and the alert banner by
setting the `hidden` property. That works through the UA rule
`[hidden] { display: none }` — but `style.css` declares `display: flex` on
`.nexa-panel` and `.nexa-alert`, and **an author stylesheet outranks the UA
stylesheet regardless of specificity**. The attribute was set; nothing hid.

Measured on first paint: the shell rendered **1048 px tall**, anchored by
`bottom: 24px`, so on a 800 px viewport its top sat at **y = −272** — the
header, Start, Stop, Rec, Export and the dry-run toggle were all above the top
of the screen and unreachable.

It compounded: `renderStats()` bails on `if (ui.statsPanel.hidden) return;`,
and the *property* was still `true`. So the stats panel was visible and never
rendered — four empty grey blocks. `syncPanelsUi()` was also never called at
boot, so `.nexa-expanded` never applied and the panels rendered at the narrow
width.

**Fix** — `#nexa-autotrade-widget [hidden] { display: none !important; }`,
plus a `syncPanelsUi()` call at boot.

### 2. Nothing capped the widget height

Even with the panels fixed, an open panel could exceed a short viewport.

**Fix** — `max-height: calc(100vh - 32px)` on the shell, the shell became a
flex column, `.nexa-body` scrolls (`min-height: 0; overflow-y: auto`), and the
panel cap became `min(420px, 55vh)`. `syncPanelsUi()` now re-clamps the
position after a toggle. Verified at 1920×1080 → 420×380: always inside.

---

## P1 — logic bugs

### 3. One unreadable expiry scan wiped the auto learner

`statsStorageKey()` is keyed on `effectiveExpirySec()`. `updateTradePanel()`
assigned `panel.expirySec = expiry` unconditionally, so a single scan where
the duration node was mid-render, behind a popup, or the UP button momentarily
invisible dropped it to `null` → key flips `...60` → `...60` via the
`CONFIG.EXPIRY_SEC` fallback, or to a different bucket entirely →
`ensureStatsBucket()` swapped buckets and cleared `auto.pendings` and
`auto.zBuffer`. The scoreboard could never reach `AUTO_MIN_SAMPLES`, so real
trades never unlocked. Same flapping hit `panel.payoutPct`, which silently
turned the min-payout veto on and off.

**Fix** — readings are sticky: only a successful scan writes, and a value ages
out after `PANEL_STICKY_MS` (60 s). The "payout not readable" warning now
checks the sticky value rather than the current scan.

### 4. A superseded WebSocket kept injecting frames (`inject.js`)

`attach()` guards `open` and `close` with `socket !== currentSocket`, but the
`message` listener had no such guard. After a reconnect the old socket's
buffered frames still went through `dispatch()` — stale quotes into the live
history, stale orders into `attachOrder`.

**Fix** — the same guard on `message`, and its `pendingBinary` state is
cleared.

### 5. The MAIN↔ISOLATED handshake had a 2.8 s deadline

`inject.js` drops **every** quote until it receives the nonce (`post()` returns
early when `bridgeNonce` is null). `sayHello` gave up after 7 attempts / 2.8 s,
and also stopped early on `feed.balance` rather than on any evidence the
bridge worked. Both scripts run at `document_start` with no guaranteed order —
on a cold start where `inject.js` registered its listener late, the extension
was silently dead for the whole page life with no error.

**Fix** — 40 attempts (~16 s), terminated by a `bridgeAlive` flag set by the
first valid message of any kind.

### 6. Session counters were never reset, so restarts mixed runs

`startBot()` reset `tradeCount`, `confirmed`, `unconfirmed`, `lossStreak` — but
not `wins`, `losses`, `pnl` or `reasonCounts`. The stats panel calls that block
"Session", so after a restart it read like `Session: 0 trades · 3W - 2L`. The
sparkline and the "Recent Executed Trades" list charted every run ever.

**Fix** — the aggregates reset with the rest; `bot.trades` is deliberately
*not* cleared (a close frame for the previous run can still arrive inside its
15 s window) but is now trimmed to `MAX_KEPT_TRADES = 500`; the sparkline and
the journal filter on `runId`.

### 7. Start threw away the minute of ticks already buffered

The chart-switch path in `lockedSymbol()` seeds a fresh history from the
scanner buffer, but `startBot()` did `bot.history = []`. The scanner has been
buffering the locked symbol since page load, so pressing Start meant watching
`warming up 0/49` for ~25 s of ticks that had already arrived.

**Fix** — `bot.history = scannerSeed(lock)`. Verified: 120 samples seeded,
status goes straight to a live reading.

### 8. With no symbol lock, every asset overwrote the live price

`if (want && normalizeSymbol(data.symbol) !== want) return;` — when `want` is
`null` (header unreadable, several assets streaming) the guard falls through
and whichever pair ticked last became `feed.price` / `feed.symbol`. The
pre-start readout described a chart nobody had open.

**Fix** — with no lock and more than one symbol on the wire, the tick is
buffered by the scanner but not promoted.

### 9. Scanner eviction could drop the symbol being traded

`scanner.delete(scanner.keys().next().value)` evicts oldest-first, and the
traded pair is usually the *first* key inserted — so a busy watchlist evicted
exactly the buffer the warm start and the ER ranking need.

**Fix** — skip `symbolLock.key` when choosing a victim.

---

## P2 — UI / UX

| # | Issue | Fix |
|---|---|---|
| 10 | **Apply button label stuck.** `origText` was read from the live button, so a second click inside the 1.5 s window captured `Settings Saved ✓` as the "original" and the label kept it forever. Reproduced in the harness. | Label captured once at build time; the pending timer is cleared. |
| 11 | **Sparkline squashed and blurry.** Fixed 290×38 backing store against a CSS width of 214 px (collapsed) / 269 px (expanded), and no `devicePixelRatio` handling. | Buffer sized to the real box × DPR, drawn in CSS pixels. A `ResizeObserver` redraws across the 220 ms expand transition. |
| 12 | **Alert flashed only once.** The `nexa-alert-pop` animation was declared on the element, which never re-enters the document — so the 2nd and later signals appeared with no flash. | Moved to a `.nexa-alert--pop` class toggled with a reflow. |
| 13 | **Alert had no base style.** Without `data-dir` it was a transparent unstyled block. | Neutral background/border added. |
| 14 | **Inputs were not selectable.** The root sets `user-select: none` for dragging; it inherits into the number inputs, so a value could not be drag-selected to copy or overwrite. | `user-select: text` for inputs, selects, stat lines, status. |
| 15 | **Status line ellipsised away the numbers.** Symbol + price + drift + z + gating reason + W/L/P&L on one `nowrap` line — everything past the reason was cut. | Wraps to a max of 2 lines (`line-clamp`). |
| 16 | **No keyboard focus ring.** Every control sets `outline: none`. | `:focus-visible` outline. |
| 17 | **Icon-only buttons had no accessible name.** All four announced as "button"; the two close buttons had no `title` either. | `aria-label` + `title` on all four; `aria-hidden` / `aria-expanded` kept in sync; the alert is a `role="status"` live region. |
| 18 | **"Chart not identified" looked like a failure.** The lock needs the same header reading twice, `SYMBOL_RECHECK_MS` apart, so the first Start within ~2 s of quotes arriving always lands there. | Distinct message when a `pendingKey` exists. |
| 19 | `--nexa-amber-glow` was a different hue (`245,158,11`) from `--nexa-amber` (`#f5b544`). | Matched. |

---

## P3 — performance & hygiene

- **20.** `dailyPnl()` did a synchronous `localStorage` read + `JSON.parse` from
  `tradeVeto` on every tick and from `renderStats` twice a second. Now cached;
  the cache is the write-through target of `addDailyPnl`.
- **21.** `readAllRows()` did `rows = rows.concat(vals)` per 50 000-row chunk —
  quadratic copying over a 500 000-row journal. Now pushes in place.
- **22.** `drawSparkline` used `Math.min(0, ...points)`; a spread over an
  unbounded array is a stack overflow waiting to happen. Now a loop.
- **23.** The recorder flush interval and the 2 s `renderStats` interval were
  never cleared and kept firing after a real unload. Both are cleared in
  `cleanupMount()` now (bfcache entry still keeps them, which is correct).

---

## Known, not changed — deliberate calls

- **`MAX_TRADES_PER_SESSION` does not count dry-run or signal-only trades.**
  `executeTrade` sets `lastTradeAt` but returns before `tradeCount += 1` on
  both paths, so a dry run or a signal-only session never hits the cap. That is
  arguably correct for signal-only (you want alerts all day) and arguably wrong
  for dry run (you want the same cadence as live). It changes trading
  behaviour, so it is flagged rather than changed — say the word.
- **`activeChartKey()` and `updateTradePanel()` walk `querySelectorAll('span,
  div, input')` and call `getBoundingClientRect()` per candidate**, forcing a
  layout pass across the whole SPA every 2–3 s. The cached-node fast paths
  mitigate it and both are already written defensively, but on a heavy Quotex
  page this is the most likely source of jank. A proper fix means anchoring on
  a stable container once and scanning only within it.
- **`decideMomentum` re-seeds both EMAs from `prices[0]` on every call**, so
  the EMA values shift as the 300-sample window slides, which perturbs
  crossover detection near the boundary. Changing it alters signal semantics
  and would invalidate the existing scoreboards in `localStorage`.
- **Scoreboard keys (`nexa.autotrade.scores.<sym>.<expiry>`) accumulate
  forever**, one per symbol × expiry. Small, but unbounded.
- **`attachOrder` cannot distinguish a manual order** on the same asset, same
  direction, inside the 15 s window. The platform exposes nothing tying an
  order to a click — already documented in the code.

---

## Files changed

- `content.js` — fixes 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 20, 21, 22, 23
- `style.css` — fixes 1, 2, 13, 14, 15, 16, 19
- `inject.js` — fix 4

---

# Second pass — 19 Sep 2026 (trading logic, safety rails, storage)

The first pass above fixed the widget and the plumbing. This pass audited the
decision layer and fixed everything it found, in severity order. Verified by
`npm test` (67 unit tests, dependency-free) and `npm run smoke`
(`tools/dom-smoke.js`: boots the real content-script stack in jsdom against a
mock Quotex page with a fake bridge and a fake clock, and drives lock → dry
trade → virtual settlement → throttled-tab stale signal → live click → server
confirm → settlement → expiry cross-check; ~55 assertions). The
`harness/verify.js` the first pass mentioned was never committed; the smoke
harness replaces it.

## Critical

- **C1 — the auto-mode bar was noise.** Fed the real `bestQualified` a coin
  flip (8 variants, rolling 80, "30 samples, +4 points on the raw ratio"): a
  variant qualified in **100%** of runs, median after 31 outcomes, and real
  trades were armed **49.7%** of the time with zero edge. Now the bar is the
  **Wilson lower bound** (z = 2.0) clearing break-even + 1 point over ≥ 100
  decided outcomes on a rolling 300 (`autopilot.js` `wilsonLowerBound`,
  `bestQualified`; `content.js` `AUTO_*`). Same simulation: 3.8% of runs, 0.2%
  armed time; a genuine 60% model still arms ~94% of the time. Qualifiers rank
  by the bound, not the ratio. Old scoreboards were scored against the broken
  bar and are dropped (`nexa.autotrade.scores.` → `scores2.`).
- **C2 — stale signals executed.** Chrome runs a hidden tab's timers once a
  minute; `tick()` then drained a minute of samples and traded the first
  crossover at today's price. Signals older than `SIGNAL_MAX_AGE_MS` (2.5 s)
  still feed the scoreboard but never click; the status line says
  "stale signal (tab throttled?)".
- **C3 — money gates failed open.** Unreadable payout → filter "stood aside"
  and the auto bar assumed 85%. Real clicks now wait (`tradeVeto` →
  `payout unknown`); dry-run and signal-only continue. The server's
  `percentProfit` on a confirmed order becomes the live payout and calls out
  a panel reading that disagreed (`adoptServerPayout`).

## High

- **H1** "Min Proven Samples" is bounded 30..`AUTO_ROLLING` (UI and
  validation); values above the rolling window could never be met.
- **H2** Session counters (`wins/losses/pnl/lossStreak`) are gated on the run
  that placed the trade (`settleTrade`); journal and daily P&L stay
  run-independent.
- **H3** Virtual entries carry the median measured slippage as an adverse
  handicap; real outcomes are tallied per variant under `real:<id>` and shown
  next to the virtual record (scoreboard log + stats panel); a ≥ 8-point gap
  is called out. `closeTimestamp` validates the expiry model
  (`checkServerExpiry`).
- **H4** `parseDuration("14:35")` = 875 s. A node whose value changes twice
  within 130 s is a clock/countdown and is distrusted for 10 min
  (`movesLikeAClock`); a node the server contradicts is distrusted for an
  hour. The smoke harness places a ticking HH:MM clock nearer the buttons
  than the real duration and checks the bot recovers.

## Medium

- **M1** Dry-run trades are journaled, settled against the live feed one
  expiry later at the platform's stake, count toward the session cap, and
  show as `(dry)`; they never touch the daily (real) P&L.
- **M2** Three consecutive button misses are skipped before the bot stops.
- **M3** Apply applies the form's object first, then persists.
- **M4** State moved to `chrome.storage.local` (extension-scoped, survives
  "clear site data", follows the user across mirror domains; one-time
  migration lifts and removes the page's `nexa.*` keys). The widget lives in a
  **closed shadow root** (`style.css` is a web-accessible resource fetched
  into it); `window.__nexaWsHooked` became a non-enumerable Symbol. The
  WebSocket proxy itself remains detectable by design.
- **M5** Tick recorder defaults **off**; the button shows rows / ≈ MB / cap.
- **M6** `inject.js` sockets must *earn* the current slot: adopted when no
  live socket exists, or when newer and carrying quotes (`adopt`). A later
  chat/notification socket.io connection can no longer silence the feed.
- **M7** `horizons.js` is shared; the backtester replays the expiry's real
  windows, the live pool (`--auto`), the offline-replayable vetoes, the
  slippage handicap from real fills, and ranks sweeps by Wilson lower bound
  with a 30-decided-trade floor.
- **M8** New tests: `inject.test.js` (7), `panel.test.js` (7), Wilson /
  null-pool / auto-replay tests; `horizon.test.js` requires the real module.
- **M9** EMAs use the bias-corrected (`adjust=True`) form: no seed bias at
  `EMA_SLOW + 2`.

## Low

Fail-closed `bestQualified` options; `bot.trades` trimmed during a run;
oldest-first order attribution; missing-module check shows on the widget;
partial balance frames forwarded; `'aligned drift above z threshold'`
replaces the "statistically significant" label; quotes batched per frame.

**Not changed:** the manifest still injects on every page of the 12 hosts.
Restricting it to `*/trade*` URLs would break SPA navigation into the trading
route (the content script only injects on a page load).

**Consequence to know about:** proving a small edge needs hundreds of
outcomes. At a 60 s expiry a variant that fires often needs ~2 hours of
learning per symbol before it can qualify, and a true 54% model (break-even)
will now mostly *never* qualify. That is the fix working.

## Addendum — "Trade on Start" and Trend Follow (same day, user request)

The user wanted a trade within 1–3 s of pressing Start. Both are opt-outs in
the settings panel:

- **Trade on Start** (default ON): the first tick of a run — which runs
  synchronously inside `startBot()` — places one trade on the current
  **trend state** (`strategy.js` `decideTrendState`: fast EMA above the slow
  one → UP, below → DOWN, bias-corrected so five samples are enough). It is
  not a model signal, so it passes the safety gates (demo route, payout
  known, feed health, daily cap) and skips the quality gates (edge-vs-cost,
  candle window); it clears the previous run's cooldown; it retries for
  `INSTANT_START_WINDOW_MS` (30 s) if a safety gate holds it; it happens once
  per run. Journaled with reason `instant entry`.
- **Trend Follow** (`STRATEGY: 'trend'`): the trend state as the running
  strategy — a signal on every sample, so the bot trades at every cooldown.
  `tools/backtest.js --strategy trend` replays it.

Verified in `tools/dom-smoke.js`: the click lands at t+0 ms after Start,
exactly once, is held while the payout is unknown and fires when it becomes
readable, is virtual in dry run, and trend mode placed 6 trades in 25 s at a
5 s cooldown.

## Addendum — "Run until I press Stop" + keep-trading fallback (same day, user request)

The user wanted the bot to trade continuously from Start until they press
Stop. Defaults changed accordingly; every knob is in the settings panel:

- **Run until I press Stop** (`RUN_UNTIL_STOPPED`, default ON): the session
  trade limit is ignored (greyed out in settings); a loss streak **pauses**
  trading for 5 min (`LOSS_STREAK_PAUSE_MS`) and resumes with a fresh streak;
  two unconfirmed clicks **pause** for 2 min, doubling on recurrence up to
  10 min (a clicker that does not register must not hammer the button, and a
  broken order match must not run blind); a missing Up/Down button is retried
  every tick with the status line saying so. Analysis (history, scoreboard)
  never pauses. What still ends a run: the user, the daily loss cap they set,
  leaving the demo route (hard rail), and the page unloading.
- **Keep trading after N s** (`KEEP_TRADING_AFTER_SEC`, default 120): if the
  model has been silent since the last trade for max(cooldown, N), the trend
  state (same entry as Trade-on-Start) supplies the direction. A model signal
  always wins when it fires. 0 restores signal-only trading.
- Expiry-node distrust now lasts the session (6 h); a 10-minute box let a
  clock back in and re-detecting it cost two minutes of wrong expiries.
  False positives are undone by the server: a distrusted node showing the
  contract's real remaining time is reinstated (`reinstateExpiryNode`).

Verified in `tools/dom-smoke.js`: 5 trades past a 2-trade limit with the run
alive; 2 losses → 5-minute pause with countdown in the status, no trades
during it, automatic resume; unconfirmed clicks → 2-minute pause, run alive;
button removed → retried, recovery logged; daily loss cap → still stops.

## Addendum — Romio-style UI, live-account policy (same day, user request)

The user wanted the widget to look and behave like the "Romio Bot" card in
their screenshot: one floating card (logo, name, a RUNNING pill), a big
BUY/SELL flash when a trade goes in, no settings — and to run on the live
market. Changes:

- **UI**: `buildWidget` is now one card in the closed shadow root — logo
  tile, gradient name, ONE pill that is Start/Stop and the status readout
  (START · RUNNING · PAUSED m:ss · a short red reason for 4 s · LIVE? TAP
  AGAIN), and a 10px caption (`DEMO/LIVE · W-L · why`). `showAlert` is a
  fixed, centred BUY (UP) / SELL (DOWN) flash for 3 s. The settings panel,
  stats panel, dry-run toggle, Rec/Export buttons and their storage keys are
  gone (`SETTINGS_KEY`, `DRY_RUN_KEY`, `REC_KEY` are removed at boot so old
  values cannot override CONFIG unseen). `style.css` is rewritten,
  mobile-first (132px card, `touch-action: none` for finger drags). Every
  knob lives in CONFIG; `__nexaDebug.config` mutates it live from the
  extension's console context; `__nexaDebug.exportTicks/exportTradesCsv/
  scoreboard/scanner` replace the removed buttons.
- **Live account**: `DEMO_ONLY` is replaced by `LIVE_ACCOUNT: 'confirm'`
  ('never' | 'confirm' | 'allow'). On the live route the first Start turns
  the pill into "LIVE? TAP AGAIN" for 6 s; a second tap confirms for the
  page session. The route is re-read before every click; a run that started
  on one account stops with ACCOUNT? if it changes. The user was told plainly
  that nothing here has a proven edge and a live run loses money in
  expectation.
- **Cadence**: `COOLDOWN_FROM_EXPIRY` — one open contract at a time
  (expiry + 5 s settle margin, floor 10 s); `KEEP_TRADING_AFTER_SEC` 15;
  `MIN_PAYOUT_PCT` 70 (the screenshot's asset paid 82%).
- **Payout probe**: with the panel unreadable, real clicks were held forever
  — the only other payout source (the server's `percentProfit`) needs a
  click. After 20 s of "unknown" one probe trade is allowed (then at most one
  per 2 min); the server figure is adopted from its order.
- **DRY_RUN** defaults to false (there is no toggle); flip it from the console.

Verified: `npm test` 70/70; `tools/dom-smoke.js` rewritten for the one-pill
UI — 79 checks incl. NO FEED refusal, instant BUY flash, payout hold → probe
→ server payout adopted, run-until-Stop pauses, DAILY CAP stop, LIVE
confirmation window, account-switch stop, LIVE_ACCOUNT=never refusal.
