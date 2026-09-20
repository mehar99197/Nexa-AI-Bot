/* Nexa AI Bot — live-page self test.
   Paste into the DevTools console ON the open Quotex trading page (F12 →
   Console) after reloading the extension.

   The card lives in a CLOSED shadow root, so page-level querySelector cannot
   see it. Switch the console's context dropdown (top-left of the Console
   panel, normally "top") to "Nexa AI Bot" — the extension's isolated world —
   and the test finds the card through the root the content script exposes
   there. Trades nothing, taps no pill, touches no account setting. */
(async () => {
  const out = [];
  const ok = (cond, msg) => out.push((cond ? '  PASS  ' : '  FAIL  ') + msg) && cond;
  const root = globalThis.__nexaWidgetRoot;
  const dbg = globalThis.__nexaDebug;
  const host = document.querySelector('[data-nexa-host]');
  if (!root || !dbg) {
    console.log('%cNEXA SELFTEST: cannot reach the card from this console context.',
      'color:#ef4444;font-weight:bold');
    console.log(host
      ? 'The card IS mounted (its host is in the DOM), but it sits in a closed shadow root.\n' +
        'Switch the console context dropdown from "top" to "Nexa AI Bot" and run this again.'
      : 'The content script did not mount. Check chrome://extensions for an error,\n' +
        'confirm this page matches a manifest pattern, and hard-reload (Ctrl+Shift+R).');
    return;
  }
  const w = root.getElementById('nexa-autotrade-widget');
  if (!w) {
    console.log('%cNEXA SELFTEST: shadow root found but the card node is missing.', 'color:#ef4444');
    return;
  }
  const box = (n) => n.getBoundingClientRect();

  // ---- 1. the card: styled, on screen, one pill ---------------------------
  ok(getComputedStyle(w).position === 'fixed', 'style.css applied inside the shadow root (card is position:fixed)');
  const b = box(w);
  ok(b.top >= -1 && b.bottom <= innerHeight + 1 && b.left >= -1 && b.right <= innerWidth + 1,
     `card inside the viewport (${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.left)},${Math.round(b.top)})`);
  const pill = w.querySelector('.nexa-pill');
  const pillText = w.querySelector('.nexa-pill-text');
  ok(!!pill && !!pillText, 'the Start/Stop pill exists');
  ok(w.querySelectorAll('button').length === 1, 'exactly one button (no panels, no toggles)');
  ok(!!w.querySelector('.nexa-logo svg') && w.querySelector('.nexa-name').textContent === 'Nexa AI Bot', 'logo + name');
  ok(pill.getAttribute('aria-label'), 'pill has an accessible name: "' + pill.getAttribute('aria-label') + '"');
  const flash = root.querySelector('.nexa-flash');
  ok(!!flash && (flash.hidden || dbg.bot.running), 'BUY/SELL flash element present');
  out.push('  INFO  pill reads "' + pillText.textContent + '" (' + w.dataset.state + '), caption "' +
    w.querySelector('.nexa-caption').textContent + '"');

  // ---- 2. storage + bridge --------------------------------------------------
  ok(dbg.storeReady, 'chrome.storage loaded');
  let leaked = 0;
  try { for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i).startsWith('nexa.')) leaked++; } catch (_) {}
  ok(leaked === 0, `no nexa.* keys left in the page's localStorage (${leaked})`);
  ok(!document.getElementById('nexa-autotrade-widget'), 'card id not reachable from the document (closed shadow root)');
  const fresh = dbg.feed.receivedAt > 0 && Date.now() - dbg.feed.receivedAt < 10_000;
  ok(fresh, 'price feed reached the content script' + (fresh
    ? ` — ${dbg.feed.symbol} ${dbg.feed.price}, ${dbg.feed.seenSymbols.size} symbols streaming`
    : ' (no quote in the last 10s: is inject.js loaded? is a chart open?)'));

  // ---- 3. can the Up/Down buttons and the panel be resolved on this build? -
  const up = document.querySelector('svg.icon-arrow-up-circle')?.closest('button') ||
             [...document.querySelectorAll('button')].find((n) => /^(up|call|higher)$/i.test(n.textContent.trim()));
  const down = document.querySelector('svg.icon-arrow-down-circle')?.closest('button') ||
               [...document.querySelectorAll('button')].find((n) => /^(down|put|lower)$/i.test(n.textContent.trim()));
  ok(!!up && !!down, 'UP and DOWN trade buttons resolve on this page');
  out.push('  INFO  panel readout: payout ' + (dbg.panel.payoutPct === null ? 'unknown' : dbg.panel.payoutPct + '%') +
    ', expiry ' + (dbg.panel.expirySec === null ? 'unknown (60s assumed)' : dbg.panel.expirySec + 's'));

  // ---- 4. account + policy --------------------------------------------------
  const demoRoute = /^\/(?:[a-z]{2}\/)?demo-trade(?:\/|$)/i.test(location.pathname);
  const liveRoute = /^\/(?:[a-z]{2}\/)?trade(?:\/|$)/i.test(location.pathname);
  out.push('  INFO  route: ' + (demoRoute ? 'DEMO account' : liveRoute ? 'LIVE account (real money)' : 'not a trading page') +
    ' (' + location.pathname + ') · LIVE_ACCOUNT policy "' + dbg.config.LIVE_ACCOUNT + '"' +
    (liveRoute && dbg.config.LIVE_ACCOUNT === 'confirm' ? ' — the first Start will ask for a second tap' : ''));
  out.push('  INFO  DRY_RUN ' + (dbg.config.DRY_RUN ? 'ON (virtual trades)' : 'OFF (real clicks)') +
    ' · strategy ' + dbg.config.STRATEGY + ' · trade on start ' + (dbg.config.TRADE_ON_START ? 'on' : 'off') +
    ' · run until Stop ' + (dbg.config.RUN_UNTIL_STOPPED ? 'on' : 'off'));

  const failed = out.filter((l) => l.startsWith('  FAIL')).length;
  console.log('%cNEXA SELFTEST — ' + (failed ? failed + ' FAILED' : 'all checks passed'),
    'color:' + (failed ? '#ef4444' : '#22c55e') + ';font-weight:bold;font-size:13px');
  console.log(out.join('\n'));
})();
