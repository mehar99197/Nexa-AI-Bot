/* Nexa AutoTrade Bot -- MAIN-world WebSocket interceptor. */
(() => {
  'use strict';

  // Double-injection guard. A plain `window.__nexaWsHooked` global was the
  // single most obvious fingerprint the page could scan for; a non-enumerable
  // Symbol-keyed property does the same job without showing up in a walk of
  // window's string keys. (The WebSocket proxy itself is inherently visible to
  // a page that goes looking — this is about not advertising it.)
  const HOOK_MARK = Symbol.for('nexa.ws.hooked');
  if (window[HOOK_MARK]) return;
  Object.defineProperty(window, HOOK_MARK, { value: true, enumerable: false });

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  const decoder = new TextDecoder();
  const ROUTED = new Set([
    'quotes/stream', 's_balance/list', 's_balance', 's_orders/open', 's_orders/close',
  ]);
  const cache = { socket: null, balance: null };
  // The live socket.io connection. Frames from any other socket are dropped —
  // see adopt() for how a socket earns (and loses) this slot.
  let currentSocket = null;
  let socketSeq = 0;                 // construction order, for adopt()
  const seqOf = new WeakMap();       // socket -> construction sequence number
  let bridgeNonce = null;

  const targetOrigin = () => {
    const origin = window.location.origin;
    return origin && origin !== 'null' ? origin : '*';
  };

  // The nonce rejects accidental or blind page messages. A compromised host page
  // remains untrusted: browser worlds have no private authenticated channel.
  const post = (payload) => {
    if (!bridgeNonce) return;
    try {
      window.postMessage({ __nexa: true, nonce: bridgeNonce, ...payload }, targetOrigin());
    } catch (error) {
      // Never let the hook interfere with the trading site
      if (error.name !== 'SecurityError') {
        console.debug('[Nexa] Post message error:', error);
      }
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.__nexa !== true || data.kind !== 'hello') return;
    if (typeof data.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(data.nonce)) return;

    bridgeNonce = data.nonce;
    if (cache.socket) post(cache.socket);
    if (cache.balance) post(cache.balance);
  });

  function decodePayload(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      return null;
    }
    let text;
    try {
      text = decoder.decode(buffer);
    } catch (error) {
      console.debug('[Nexa] Failed to decode buffer:', error);
      return null;
    }
    const start = text.search(/[\[{]/);
    if (start === -1) return null;
    const candidate = text.slice(start).replace(/\0+$/, '');
    try {
      return JSON.parse(candidate);
    } catch (error) {
      console.debug('[Nexa] Failed to parse JSON:', error);
      return null;
    }
  }

  // One frame can carry dozens of symbols (the whole watchlist). Posting a
  // message per row meant a structured clone + event dispatch per symbol at
  // ~2Hz; the frame is forwarded as one batch instead and content.js loops.
  function handleQuotes(data) {
    if (!Array.isArray(data)) return;
    const rows = [];
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [symbol, timestamp, price] = row;
      if (typeof symbol !== 'string' || !Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
      rows.push([symbol, timestamp, price]);
    }
    if (rows.length > 0) post({ kind: 'quotes', rows });
  }

  // Quotex encodes the demo flag as the NUMBER 1/0, not a boolean. `x === true`
  // would turn 1 into false, and content.js's attachOrder demo-match would then
  // reject the order, leaving every real trade UNCONFIRMED. Verified against a
  // live s_orders/open frame: {"isDemo":1,...}.
  const isDemoFlag = (value) => value === true || value === 1;

  function handleOrderOpen(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.id !== 'string' || typeof data.asset !== 'string' ||
        !Number.isFinite(data.amount) || !Number.isFinite(data.openPrice) ||
        !Number.isInteger(data.command)) {
      return;
    }
    post({
      kind: 'trade-open',
      id: data.id,
      asset: data.asset,
      amount: data.amount,
      openPrice: data.openPrice,
      command: data.command,
      isDemo: isDemoFlag(data.isDemo),
      percentProfit: Number.isFinite(data.percentProfit) ? data.percentProfit : null,
      closeTimestamp: Number.isFinite(data.closeTimestamp) ? data.closeTimestamp : null,
    });
  }

  function handleOrderClose(data) {
    if (!Array.isArray(data?.deals)) {
      return;
    }
    for (const deal of data.deals) {
      if (!deal || typeof deal.id !== 'string' || typeof deal.asset !== 'string' ||
          !Number.isFinite(deal.profit) || !Number.isFinite(deal.openPrice) ||
          !Number.isFinite(deal.closePrice)) {
        continue;
      }
      post({
        kind: 'trade-close',
        id: deal.id,
        asset: deal.asset,
        amount: Number.isFinite(deal.amount) ? deal.amount : null,
        profit: deal.profit,
        openPrice: deal.openPrice,
        closePrice: deal.closePrice,
        command: Number.isInteger(deal.command) ? deal.command : null,
        isDemo: isDemoFlag(deal.isDemo),
      });
    }
  }

  function handleBalanceList(data) {
    if (!data || typeof data !== 'object') return;
    // Either figure alone is still worth forwarding — requiring both dropped
    // the whole frame (and the demo balance the stake sizer needs) whenever
    // the platform omitted one of them.
    const live = Number.isFinite(data.liveBalance) ? data.liveBalance : null;
    const demo = Number.isFinite(data.demoBalance) ? data.demoBalance : null;
    if (live === null && demo === null) return;
    const prev = cache.balance;
    cache.balance = {
      kind: 'balance',
      live: live !== null ? live : (prev ? prev.live : null),
      demo: demo !== null ? demo : (prev ? prev.demo : null),
    };
    post(cache.balance);
  }

  function handleBalanceUpdate(data) {
    // isDemo is 1/0 (number) here too, so accept the numeric form rather than
    // requiring a boolean — otherwise per-trade balance updates are dropped.
    if (!data || !Number.isFinite(data.balance) ||
        !(data.isDemo === true || data.isDemo === false ||
          data.isDemo === 0 || data.isDemo === 1)) {
      return;
    }
    const next = cache.balance ? { ...cache.balance } : { kind: 'balance', live: null, demo: null };
    if (isDemoFlag(data.isDemo)) {
      next.demo = data.balance;
    } else {
      next.live = data.balance;
    }
    cache.balance = next;
    post(next);
  }

  function dispatch(name, payload) {
    if (!ROUTED.has(name)) return;
    switch (name) {
      case 'quotes/stream': handleQuotes(payload); break;
      case 's_balance/list': handleBalanceList(payload); break;
      case 's_balance': handleBalanceUpdate(payload); break;
      case 's_orders/open': handleOrderOpen(payload); break;
      case 's_orders/close': handleOrderClose(payload); break;
    }
  }

  function parseTextFrame(text) {
    // Socket.IO event frames are either direct (42) or binary placeholders (45N-).
    const binary = text.match(/^45(\d+)-\[("(?:[^"\\]|\\.)*"),/);
    if (binary) {
      const count = parseInt(binary[1], 10);
      if (!(count >= 1)) return null;
      try { return { name: JSON.parse(binary[2]), count, binary: true }; } catch (_) { return null; }
    }
    if (!text.startsWith('42')) return null;
    const start = text.indexOf('[');
    if (start === -1) return null;
    try {
      const event = JSON.parse(text.slice(start));
      return Array.isArray(event) && typeof event[0] === 'string'
        ? { name: event[0], payload: event[1], binary: false }
        : null;
    } catch (_) {
      return null;
    }
  }

  function setCurrent(socket) {
    currentSocket = socket;
    cache.socket = { kind: 'socket', state: 'open' };
    post(cache.socket);
  }

  /**
   * Should a routed frame from `socket` be believed?
   *
   * "Last constructed socket wins" was the old rule, and it had a hole: any
   * socket.io connection the page opened AFTER the quote feed (a support
   * chat, a notifications channel) silently took the slot, and every quote
   * from the real feed was dropped from then on. A socket now has to EARN
   * the slot: it is adopted when there is no live current socket, or when it
   * delivers quotes and is newer than the current one — the reconnect case,
   * where the old connection is dead or dying and the new one is provably the
   * feed. A later socket that never carries quotes never gets in.
   */
  function adopt(socket, name) {
    if (socket === currentSocket) return true;
    const current = currentSocket;
    const currentLive = current && current.readyState === NativeWebSocket.OPEN;
    const newerFeed = name === 'quotes/stream' &&
      (seqOf.get(socket) || 0) > (current ? seqOf.get(current) || 0 : -1);
    if (currentLive && !newerFeed) return false;
    setCurrent(socket);
    return true;
  }

  function deliver(socket, name, payload) {
    if (!ROUTED.has(name)) return;
    if (!adopt(socket, name)) return;
    dispatch(name, payload);
  }

  function attach(socket) {
    // { name, total, remaining } while a "45N-" placeholder frame's binary
    // attachments are still being consumed. Tracked for EVERY socket, current
    // or not, so the placeholder/attachment pairing stays intact.
    let pendingBinary = null;

    socket.addEventListener('open', () => {
      // First live connection takes the slot; a second socket opening while
      // the feed is healthy has to prove itself with quotes (see adopt).
      const current = currentSocket;
      if (!current || current.readyState !== NativeWebSocket.OPEN) setCurrent(socket);
    });

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        const parsed = parseTextFrame(data);
        if (!parsed) return;
        if (parsed.binary) pendingBinary = { name: parsed.name, total: parsed.count, remaining: parsed.count };
        else deliver(socket, parsed.name, parsed.payload);
        return;
      }

      if (!pendingBinary) return;
      pendingBinary.remaining -= 1;
      if (pendingBinary.remaining > 0) return;   // consume every attachment first
      const { name, total } = pendingBinary;
      pendingBinary = null;
      // Only a single-attachment event IS its payload. A multi-attachment
      // event can't be reassembled here, so its frames are consumed (to keep
      // the placeholder/attachment pairing intact) but the event is skipped.
      if (total !== 1 || !ROUTED.has(name)) return;
      const route = (buffer) => {
        const payload = decodePayload(new Uint8Array(buffer));
        if (payload !== null) deliver(socket, name, payload);
      };
      if (data instanceof ArrayBuffer) route(data);
      else if (data instanceof Blob) data.arrayBuffer().then(route).catch(() => {});
    });

    socket.addEventListener('close', () => {
      // On a reconnect the OLD socket's close can fire after the new socket
      // is already live — never let it overwrite the current state.
      if (socket !== currentSocket) return;
      currentSocket = null;   // the slot is open for the next connection
      cache.socket = { kind: 'socket', state: 'closed' };
      post(cache.socket);
    });
  }

  function isSocketIoConnection(url) {
    try {
      const parsed = new URL(String(url), window.location.href);
      return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
        /\/socket\.io(?:\/|$)/i.test(parsed.pathname);
    } catch (error) {
      console.debug('[Nexa] Invalid WebSocket URL:', url, error);
      return false;
    }
  }

  // A Proxy preserves native static members and instanceof semantics better than
  // a hand-written replacement constructor.
  const PatchedWebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args, newTarget) {
      let socket;
      try {
        socket = Reflect.construct(Target, args, newTarget === PatchedWebSocket ? Target : newTarget);
      } catch (error) {
        console.error('[Nexa] WebSocket construction failed:', error);
        throw error;
      }
      if (args[0] && isSocketIoConnection(args[0])) {
        socketSeq += 1;
        seqOf.set(socket, socketSeq);
        attach(socket);
        // Nothing is posted here: the socket earns the current slot from its
        // own open event / first quotes (see adopt) — at construction time
        // the connection doesn't exist yet.
      }
      return socket;
    },
  });

  window.WebSocket = PatchedWebSocket;
})();
