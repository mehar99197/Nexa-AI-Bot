/* Nexa AutoTrade Bot -- MAIN-world WebSocket interceptor. */
(() => {
  'use strict';

  if (window.__nexaWsHooked) return;
  window.__nexaWsHooked = true;

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  const decoder = new TextDecoder();
  const ROUTED = new Set([
    'quotes/stream', 's_balance/list', 's_balance', 's_orders/open', 's_orders/close',
  ]);
  const cache = { socket: null, balance: null };
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
      const targetOrigin = targetOrigin();
      window.postMessage({ __nexa: true, nonce: bridgeNonce, ...payload }, targetOrigin);
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

  function handleQuotes(data) {
    if (!Array.isArray(data)) return;
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [symbol, timestamp, price] = row;
      if (typeof symbol !== 'string' || !Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
      post({ kind: 'quote', symbol, ts: timestamp, price });
    }
  }

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
      isDemo: data.isDemo === true,
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
        isDemo: deal.isDemo === true,
      });
    }
  }

  function handleBalanceList(data) {
    if (!data || !Number.isFinite(data.liveBalance) || !Number.isFinite(data.demoBalance)) {
      return;
    }
    cache.balance = {
      kind: 'balance',
      live: data.liveBalance,
      demo: data.demoBalance,
    };
    post(cache.balance);
  }

  function handleBalanceUpdate(data) {
    if (!data || typeof data.isDemo !== 'boolean' || !Number.isFinite(data.balance)) {
      return;
    }
    const next = cache.balance ? { ...cache.balance } : { kind: 'balance', live: null, demo: null };
    if (data.isDemo) {
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
    const binary = text.match(/^45\d+-\[("(?:[^"\\]|\\.)*"),/);
    if (binary) {
      try { return { name: JSON.parse(binary[1]), binary: true }; } catch (_) { return null; }
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

  function attach(socket) {
    let pendingBinaryEvent = null;

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        const parsed = parseTextFrame(data);
        if (!parsed) return;
        if (parsed.binary) pendingBinaryEvent = parsed.name;
        else dispatch(parsed.name, parsed.payload);
        return;
      }

      const name = pendingBinaryEvent;
      pendingBinaryEvent = null;
      if (!ROUTED.has(name)) return;
      const route = (buffer) => {
        const payload = decodePayload(new Uint8Array(buffer));
        if (payload !== null) dispatch(name, payload);
      };
      if (data instanceof ArrayBuffer) route(data);
      else if (data instanceof Blob) data.arrayBuffer().then(route).catch(() => {});
    });

    socket.addEventListener('close', () => {
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
        attach(socket);
        cache.socket = { kind: 'socket', state: 'open', url: String(args[0]) };
        post(cache.socket);
      }
      return socket;
    },
  });

  window.WebSocket = PatchedWebSocket;
})();
