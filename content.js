/* ==========================================================================
   Nexa AutoTrade Bot — content script (ISOLATED world)

   Sections:
     0. CONFIG             <- the only block you normally need to edit
     1. UI injection       (floating draggable widget)
     2. Price feed         (quotes relayed from inject.js)
     3. Element resolution (finding the Up / Down buttons robustly)
     4. Trade execution    (clicking Call / Put)
     5. Strategy           (decide what to do with the price history)
     6. Bot loop           (start / stop / tick)
     7. Wiring + debug helpers

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

  if (document.getElementById(WIDGET_ID)) return;

  // Guard against multiple instances
  if (window.__nexaBotLoaded) return;
  window.__nexaBotLoaded = true;

  /* =======================================================================
     0. CONFIG
     ======================================================================= */

  const CONFIG = {
    // Automatically place only qualifying trades on the demo route.
    DRY_RUN: false,

    // Hard safety rail: refuse to trade unless the DEMO route is selected.
    // This is checked on start AND again immediately before every click.
    DEMO_ONLY: true,

    TICK_MS: 1000,               // how often the loop runs
    TRADE_COOLDOWN_MS: 60_000,   // minimum gap between two trades
    MAX_TRADES_PER_SESSION: 20,  // hard stop; 0 = unlimited
    MAX_HISTORY: 300,            // price samples kept in memory

    // Statistical filters measure trend quality, not a guaranteed trading edge.
    FAST_WINDOW: 12,
    SLOW_WINDOW: 48,
    Z_SCORE_THRESHOLD: 2.5,
    MIN_EFFICIENCY_RATIO: 0.55,
    MAX_REALIZED_VOLATILITY: 0.015,

    // After clicking, wait this long for a matching server-side open order.
    // Two unconfirmed trades in a row stops the bot.
    CONFIRM_MS: 4000,

    // Quotes arrive roughly twice a second. If nothing has arrived for this
    // long the feed is considered dead and trading halts.
    QUOTE_STALE_MS: 10_000,

    // Manual instrument override, e.g. 'AUDNZD_otc'. Leave null and the bot
    // locks onto whichever chart is actually open, reading the asset title from
    // the page header. quotes/stream carries EVERY subscribed asset (the
    // watchlist and asset picker add more), so without this lock the bot would
    // mix several pairs into one price history.
    SYMBOL: null,

    // How often to re-read the chart title from the DOM (ms).
    SYMBOL_RECHECK_MS: 2000,
  };

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
      labelText:   /^(up|call|higher|buy)$/i,        // 4. visible label
    },
    DOWN: {
      iconClass:   'icon-arrow-down-circle',
      spriteId:    '#icon-arrow-down-circle',
      hashClasses: '.KtjVk.twQq3',
      labelText:   /^(down|put|lower|sell)$/i,
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

  function buildWidget() {
    const root = el('div');
    root.id = WIDGET_ID;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'AutoTrade Bot controls');
    root.dataset.state = 'idle';

    const header = el('div', 'nexa-header');
    header.setAttribute('aria-label', 'Drag to move');

    const brand = el('div', 'nexa-brand');
    brand.appendChild(el('span', 'nexa-mark'));
    brand.appendChild(el('span', 'nexa-title', 'AutoTrade Bot'));

    const grip = el('div', 'nexa-grip');
    grip.setAttribute('aria-hidden', 'true');

    header.appendChild(brand);
    header.appendChild(grip);

    const body = el('div', 'nexa-body');

    const actions = el('div', 'nexa-actions');
    const startBtn = el('button', 'nexa-btn nexa-btn--start', 'Start');
    const stopBtn = el('button', 'nexa-btn nexa-btn--stop', 'Stop');
    startBtn.type = 'button';
    stopBtn.type = 'button';
    stopBtn.disabled = true;
    actions.appendChild(startBtn);
    actions.appendChild(stopBtn);

    const status = el('div', 'nexa-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const led = el('span', 'nexa-status-led');
    led.setAttribute('aria-hidden', 'true');
    const statusText = el('span', 'nexa-status-text', 'Status: Waiting...');
    status.appendChild(led);
    status.appendChild(statusText);

    body.appendChild(actions);
    body.appendChild(status);

    root.appendChild(header);
    root.appendChild(body);

    return { root, header, startBtn, stopBtn, statusText };
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function savePosition(root) {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify({
        left: root.offsetLeft,
        top: root.offsetTop,
      }));
    } catch (error) {
      // Silently fail in private mode or when quota is exceeded
      if (error.name !== 'QuotaExceededError' && error.name !== 'NS_ERROR_FILE_CORRUPTED') {
        console.debug('[AutoTrade] Failed to save position:', error);
      }
    }
  }

  function restorePosition(root) {
    let saved = null;
    try {
      const stored = localStorage.getItem(POSITION_KEY);
      if (stored) saved = JSON.parse(stored);
    } catch (error) {
      console.debug('[AutoTrade] Failed to restore position:', error);
    }
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

  const ui = buildWidget();
  makeDraggable(ui.root, ui.header);

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
    if (ui.root.isConnected) return true;
    const host = document.documentElement || document.body;
    if (!host) return false;
    try {
      host.appendChild(ui.root);
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

  function cleanupMount() {
    if (mountObserver) {
      mountObserver.disconnect();
      mountObserver = null;
    }
    if (hostWaitTimer) {
      clearInterval(hostWaitTimer);
      hostWaitTimer = null;
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

  // state: 'idle' | 'running' | 'stopped'
  function setStatus(message, state) {
    ui.statusText.textContent = 'Status: ' + message;
    ui.root.dataset.state = state || 'idle';
  }

  const log = (...args) =>
    console.log('%c[AutoTrade]', 'color:#22c55e;font-weight:bold', ...args);

  /* =======================================================================
     2. Price feed
     ======================================================================= */

  /** "AUD/NZD (OTC)" and "AUDNZD_otc" both reduce to "AUDNZDOTC". */
  function normalizeSymbol(value) {
    return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  const symbolLock = { key: null, raw: null, checkedAt: 0 };

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

    let best = null;
    let bestTop = Infinity;

    for (const node of document.querySelectorAll('span, button, div, h1, h2')) {
      if (node.children.length !== 0) continue;
      const text = node.textContent.trim();
      if (!text || text.length > 24) continue;

      const key = normalizeSymbol(text);
      if (!streaming.has(key)) continue;
      if (node.closest('#' + WIDGET_ID)) continue;      // never match our own UI

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < bestTop) { bestTop = rect.top; best = key; }
    }
    return best;
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
      if (key && key !== symbolLock.key) {
        if (symbolLock.key) {
          log('Chart switched:', symbolLock.key, '->', key, '— history reset');
          bot.history.length = 0;
          bot.lastTradeAt = 0;
        } else {
          log('Locked to chart:', key);
        }
        symbolLock.key = key;
      }
    }

    // Until the header can be read, lock onto the first symbol seen rather
    // than letting several pairs bleed into one history.
    if (!symbolLock.key && !symbolLock.raw && feed.symbol) symbolLock.raw = feed.symbol;
    return symbolLock.key || (symbolLock.raw ? normalizeSymbol(symbolLock.raw) : null);
  }

  const feed = {
    price: null,
    symbol: null,
    serverTs: 0,
    receivedAt: 0,
    quoteCount: 0,
    balance: null,
    socketOpen: false,
    seenSymbols: new Set(),
    lastOpen: null,      // last accepted order
    lastClose: null,     // last settled deal
  };

  function createBridgeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const bridgeNonce = createBridgeNonce();

  function validBridgeMessage(data) {
    if (!data || data.__nexa !== true || data.nonce !== bridgeNonce) return false;
    switch (data.kind) {
      case 'quote':
        return typeof data.symbol === 'string' && data.symbol.length <= 64 &&
          Number.isFinite(data.ts) && Number.isFinite(data.price) && data.price > 0;
      case 'balance':
        return (data.live === null || Number.isFinite(data.live)) &&
          (data.demo === null || Number.isFinite(data.demo));
      case 'trade-open':
        return typeof data.id === 'string' && typeof data.asset === 'string' &&
          Number.isFinite(data.amount) && data.amount > 0 && Number.isFinite(data.openPrice) &&
          data.openPrice > 0 && (data.command === 0 || data.command === 1) &&
          typeof data.isDemo === 'boolean';
      case 'trade-close':
        return typeof data.id === 'string' && typeof data.asset === 'string' &&
          Number.isFinite(data.profit) && Number.isFinite(data.openPrice) &&
          Number.isFinite(data.closePrice) && typeof data.isDemo === 'boolean';
      case 'socket':
        return data.state === 'open' || data.state === 'closed';
      default:
        return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!validBridgeMessage(data)) return;

    switch (data.kind) {
      case 'quote': {
        feed.seenSymbols.add(data.symbol);

        // Ignore every asset except the one whose chart is open. Previously a
        // foreign tick wiped the history, so it never reached the lookback
        // length and no signal could ever fire.
        const want = lockedSymbol();
        if (want && normalizeSymbol(data.symbol) !== want) return;

        feed.price = data.price;
        feed.symbol = data.symbol;
        feed.serverTs = data.ts;
        feed.receivedAt = Date.now();
        feed.quoteCount += 1;
        feed.socketOpen = true;   // quotes arriving means the socket is alive
        break;
      }

      case 'balance':
        feed.balance = { live: data.live, demo: data.demo };
        break;

      case 'trade-open':
        feed.lastOpen = data;
        attachOrder(data);
        break;

      case 'trade-close':
        feed.lastClose = data;
        recordResult(data);
        break;

      case 'socket':
        feed.socketOpen = data.state === 'open';
        if (data.state === 'closed') log('Quotex socket closed — feed will go stale');
        break;
    }
  });

  // Ask inject.js to replay the socket/balance state it saw before we loaded.
  // Both scripts run at document_start and their relative order is not
  // guaranteed, so retry briefly rather than firing once and hoping.
  (function sayHello(attempt) {
    if (attempt > 6 || feed.balance) return;
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
   * Dispatch a full pointer+mouse sequence. A bare element.click() fires only
   * a 'click' event, which many trading UIs ignore because they listen on
   * pointerdown/mousedown instead.
   */
  function simulateClick(element) {
    const rect = element.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    element.dispatchEvent(new PointerEvent('pointerover', pointer));
    element.dispatchEvent(new PointerEvent('pointerenter', pointer));
    element.dispatchEvent(new MouseEvent('mouseover', base));
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', base));
    element.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }

  /**
   * Place a trade.
   * @param {'UP'|'DOWN'} direction
   * @returns {boolean} true if a click was actually dispatched.
   */
  function executeTrade(direction) {
    const found = findTradeButton(direction);

    if (!found) {
      log('Could not resolve the', direction, 'button — every strategy failed.');
      setStatus(direction + ' button not found', 'stopped');
      stopBot();
      return false;
    }

    const { button, via } = found;

    const disabled = button.disabled ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.classList.contains('disabled');

    if (disabled) {
      log('The', direction, 'button is disabled right now — skipping this tick.');
      return false;
    }

    if (CONFIG.DRY_RUN) {
      log('DRY RUN — would click', direction, 'at', feed.price, 'via', via);
      bot.lastTradeAt = Date.now();
      return false;
    }

    // Re-check the account on every click, not just at start — the user can
    // switch from demo to live while the bot is running.
    const account = accountType();
    if (CONFIG.DEMO_ONLY && account !== 'demo') {
      log('BLOCKED: DEMO_ONLY is on and the account is "' + account + '". Not clicking.');
      setStatus('Blocked — not a demo account', 'stopped');
      stopBot();
      return false;
    }

    simulateClick(button);
    bot.lastTradeAt = Date.now();
    bot.tradeCount += 1;
    const trade = {
      t: Date.now(), direction, price: feed.price, symbol: feed.symbol,
      account, expectedCommand: direction === 'UP' ? 0 : 1,
    };
    bot.trades.push(trade);
    log('Clicked', direction, '#' + bot.tradeCount, 'at', feed.price, '— awaiting confirmation');

    confirmTrade(trade);
    return true;
  }

  /**
   * A synthetic click carries isTrusted: false. If Quotex rejects those, the
   * button click is a silent no-op — so verify against the server rather than
   * assuming success. Only a matching server-side open order is confirmation.
   */
  function confirmTrade(trade) {
    setTimeout(() => {
      if (trade.orderId) {
        bot.confirmed += 1;
        bot.unconfirmed = 0;
        log('CONFIRMED:', trade.direction, 'accepted —',
            '$' + trade.amount + ' @ ' + trade.openPrice,
            '| balance $' + (feed.balance ? feed.balance.demo : '?'));
        return;
      }

      bot.unconfirmed += 1;
      log('UNCONFIRMED:', trade.direction, '— no matching server order arrived.');

      if (bot.unconfirmed >= 2) {
        log('Two unconfirmed trades in a row. Quotex is most likely rejecting ' +
            'synthetic clicks (event.isTrusted === false). Stopping.');
        setStatus('Clicks not registering', 'stopped');
        stopBot();
      }
    }, CONFIG.CONFIRM_MS);
  }

  /**
   * Match on immutable server properties rather than treating an arbitrary
   * balance update or a manually opened order as confirmation.
   */
  function attachOrder(order) {
    for (let i = bot.trades.length - 1; i >= 0; i--) {
      const t = bot.trades[i];
      if (t.orderId) continue;
      if (Date.now() - t.t > 15_000) break;   // too old to be ours
      if (normalizeSymbol(t.symbol) !== normalizeSymbol(order.asset) ||
          t.expectedCommand !== order.command ||
          (t.account === 'demo') !== order.isDemo) continue;
      t.orderId = order.id;
      t.amount = order.amount;
      t.openPrice = order.openPrice;
      return;
    }
  }

  /**
   * A trade settled. Attribute it to the bot only if we opened it, then keep
   * a running win/loss tally.
   */
  function recordResult(deal) {
    const mine = bot.trades.find((t) => t.orderId === deal.id);
    if (!mine) return;                        // a trade the user placed by hand

    mine.profit = deal.profit;
    mine.closePrice = deal.closePrice;
    mine.settled = true;

    if (deal.profit > 0) bot.wins += 1;
    else bot.losses += 1;
    bot.pnl = +(bot.pnl + deal.profit).toFixed(2);

    log(deal.profit > 0 ? 'WIN' : 'LOSS', mine.direction,
        deal.openPrice, '->', deal.closePrice,
        '| P&L $' + bot.pnl, '| ' + bot.wins + 'W-' + bot.losses + 'L');
  }

  /* =======================================================================
     5. Strategy
     ======================================================================= */

  const decide = NexaStrategy.decide;

  /* =======================================================================
     6. Bot loop
     ======================================================================= */

  const bot = {
    timerId: null,
    running: false,
    history: [],
    trades: [],
    lastTradeAt: 0,
    tradeCount: 0,
    confirmed: 0,
    unconfirmed: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
  };

  function tick() {
    const price = readCurrentPrice();

    if (price === null) {
      setStatus('Feed stale — no quotes', 'running');
      return;
    }

    bot.history.push({ t: Date.now(), price });
    if (bot.history.length > CONFIG.MAX_HISTORY) bot.history.shift();

    const view = decide(bot.history, CONFIG);

    // Surface the running analysis so it is obvious the bot is working even
    // when no signal fires.
    const drift = view.pct === null ? '--' : (view.pct >= 0 ? '+' : '') + view.pct.toFixed(3) + '%';
    const evidence = view.zScore === null ? '--' : 'z=' + view.zScore.toFixed(2);
    setStatus(
      (CONFIG.DRY_RUN ? 'Dry ' : '') +
      (feed.symbol || '?') + ' ' + price + ' ' + drift + ' ' + evidence +
      ' · ' + bot.wins + 'W-' + bot.losses + 'L $' + bot.pnl,
      'running'
    );

    if (CONFIG.MAX_TRADES_PER_SESSION && bot.tradeCount >= CONFIG.MAX_TRADES_PER_SESSION) {
      log('Session trade limit reached');
      setStatus('Trade limit reached', 'stopped');
      stopBot();
      return;
    }

    if (Date.now() - bot.lastTradeAt < CONFIG.TRADE_COOLDOWN_MS) return;

    if (view.signal) executeTrade(view.signal);
  }

  function startBot() {
    if (bot.running) return;

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
    if (CONFIG.DEMO_ONLY && account !== 'demo') {
      log('Cannot start: DEMO_ONLY is on but the account is "' + account + '". ' +
          'Switch to the demo account.');
      setStatus('Switch to DEMO account', 'stopped');
      return;
    }
    const lock = lockedSymbol();
    if (!lock) {
      log('Cannot start: could not tell which chart is open. Wait for quotes.');
      setStatus('Chart not identified', 'stopped');
      return;
    }
    log('Account:', account, '| chart', lock, '| balance', feed.balance);
    log('UP via', up.via, '| DOWN via', down.via, '| feed', feed.symbol, feed.price);

    bot.running = true;
    bot.history = [];

    if (ui.startBtn && ui.stopBtn) {
      ui.startBtn.disabled = true;
      ui.stopBtn.disabled = false;
    }
    setStatus(CONFIG.DRY_RUN ? 'Running (dry run)' : 'Running', 'running');
    log('Started. DRY_RUN =', CONFIG.DRY_RUN);

    tick();                                          // don't wait a full second
    bot.timerId = setInterval(tick, CONFIG.TICK_MS);
  }

  function stopBot() {
    if (!bot.running) return;
    bot.running = false;

    if (bot.timerId) {
      clearInterval(bot.timerId);
      bot.timerId = null;
    }

    if (ui.startBtn && ui.stopBtn) {
      ui.startBtn.disabled = false;
      ui.stopBtn.disabled = true;
    }
    setStatus('Stopped', 'stopped');
    log('Stopped after', bot.tradeCount, 'trades');
  }

  /**
   * Clean up resources on page unload.
   */
  function cleanup() {
    stopBot();
    cleanupMount();
  }

  /* =======================================================================
     7. Wiring
     ======================================================================= */

  if (ui.startBtn && ui.stopBtn) {
    ui.startBtn.addEventListener('click', startBot);
    ui.stopBtn.addEventListener('click', stopBot);
  } else {
    console.error('[AutoTrade] UI buttons not found, bot will not be functional');
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  log('Loaded in demo-only trading mode.');
})();
