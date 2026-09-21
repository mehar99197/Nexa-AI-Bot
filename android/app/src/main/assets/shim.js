/* Nexa AI Bot — Android page shim.

   Runs at document start in the trading page's WebView, BEFORE the bot's
   own files (inject.js … content.js, copied unchanged from the repository
   root). It gives them the two extension APIs they rely on, backed by the
   app instead of Chrome:

     chrome.storage.local   -> Android SharedPreferences, through the
                               app's JavaScript interface (BRIDGE_NAME;
                               synchronous, so the callback style content.js
                               uses works)
     chrome.runtime         -> getURL / getManifest / onMessage, so the
                               settings screen can ask for status and send
                               Start / Stop exactly as the popup does

   The Java bridge object is injected into the page's JavaScript context by
   the WebView, and that can land a moment AFTER document-start scripts have
   run. So nothing here requires the bridge at load time: every call looks
   it up when it happens, the first storage read waits for it (the pill says
   LOADING meanwhile), and writes made before it appears are queued and
   flushed the moment it does. The message entry point the settings screen
   uses is defined unconditionally — when it was gated on the bridge, a late
   injection left the settings screen saying NO PAGE forever.

   In the extension, inject.js runs in the page's MAIN world and the rest in
   the ISOLATED world; here everything shares the page world. The nonce
   handshake between them still works (same window), the widget still lives
   in a closed shadow root — the difference is that the page shares the
   window with the bot. So everything left on it is defined non-enumerable
   (a walk of Object.keys(window) is the usual way to look for injected
   tooling), the bridge object is hidden the same way once it has appeared,
   and its name says nothing. Frames other than the top one get no bot: the
   guards the scripts already check are pre-set there. */
(() => {
  'use strict';

  /** The name the app injects its Java bridge under (BotWebView, SettingsActivity). */
  const BRIDGE_NAME = 'nxHost';

  /** A global the page cannot come across by enumeration. */
  const hidden = (name, value) => {
    try {
      Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
    } catch (_) {
      window[name] = value;
    }
  };

  if (window !== window.top) {
    try {
      hidden('__nexaBotLoaded', true);                              // content.js bails
      Object.defineProperty(window, Symbol.for('nexa.ws.hooked'), // inject.js bails
        { value: true, enumerable: false });
    } catch (_) { /* nothing to do */ }
    return;
  }

  // Align navigator platform and userAgentData with the Linux desktop site identity
  try {
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Linux x86_64',
      configurable: true,
      enumerable: true,
    });
  } catch (_) {}

  // Client hints. The app sets the WebView's user-agent metadata
  // (BotWebView.desktopMetadata), which makes navigator.userAgentData — and
  // the Sec-CH-UA-* headers — describe desktop Chrome on Linux like the
  // User-Agent does. A provider too old for that API still answers
  // "Android WebView, mobile" here, so the object is patched by hand in
  // that case only. navigator.userAgentData is a fresh object on every
  // read (an instance override is lost at once), so the prototype is what
  // is patched: mobile, platform, brands, toJSON and the high-entropy call.
  try {
    const uaData = navigator.userAgentData;
    const proto = typeof NavigatorUAData === 'function' ? NavigatorUAData.prototype : null;
    if (uaData && proto && uaData.mobile === true) {
      const major = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || '128';
      const brands = () => [
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ];
      const define = (name, get) => Object.defineProperty(proto, name, { get, configurable: true, enumerable: true });
      define('mobile', () => false);
      define('platform', () => 'Linux');
      define('brands', brands);
      proto.toJSON = function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; };
      const highEntropy = proto.getHighEntropyValues;
      proto.getHighEntropyValues = function (hints) {
        return highEntropy.call(this, hints).then((values) => {
          const out = { ...values, brands: brands(), mobile: false, platform: 'Linux' };
          if ('model' in out) out.model = '';
          if ('platformVersion' in out) out.platformVersion = '6.8.0';
          if ('architecture' in out) out.architecture = 'x86';
          if ('bitness' in out) out.bitness = '64';
          if ('wow64' in out) out.wow64 = false;
          if (Array.isArray(out.fullVersionList)) {
            out.fullVersionList = out.fullVersionList.map((entry) =>
              entry.brand === 'Android WebView' ? { brand: 'Google Chrome', version: entry.version } : entry);
          }
          return out;
        });
      };
    }
  } catch (_) { /* no client hints API here — nothing to align */ }

  /**
   * The Java object, whenever it is there. Kept in this closure from the
   * first sighting; the global the WebView injected is then redefined
   * non-enumerable (the object itself stays where it is — the WebView
   * re-injects it on every navigation, and nothing depends on its
   * enumerability).
   */
  let captured = null;
  const bridge = () => {
    if (captured) return captured;
    const found = window[BRIDGE_NAME];
    if (!found || typeof found.storageGetAll !== 'function') return null;
    captured = found;
    hidden(BRIDGE_NAME, found);
    return captured;
  };

  const storageListeners = [];
  const messageListeners = [];
  const parse = (text) => {
    try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
  };

  // Writes made before the bridge appears, oldest first; flushed on its arrival.
  const queuedWrites = [];
  function flushWrites() {
    const b = bridge();
    if (!b) return false;
    while (queuedWrites.length > 0) {
      const write = queuedWrites.shift();
      try {
        if (write.op === 'set') b.storageSet(write.json);
        else b.storageRemove(write.json);
      } catch (_) { /* a bad write is dropped, the rest still go */ }
    }
    return true;
  }

  /** Run `fn` once the bridge exists: now, or on a short poll (≤ 10 s). */
  function whenBridge(fn, onGiveUp) {
    if (bridge()) { fn(bridge()); return; }
    let tries = 0;
    const poll = () => {
      const b = bridge();
      if (b) { flushWrites(); fn(b); return; }
      if (tries++ < 200) setTimeout(poll, 50);
      else if (onGiveUp) onGiveUp();
    };
    setTimeout(poll, 0);
  }

  const pick = (all, keys) => {
    if (keys === null || keys === undefined) return all;
    const list = typeof keys === 'string' ? [keys]
      : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const key of list) {
      if (Object.prototype.hasOwnProperty.call(all, key)) out[key] = all[key];
    }
    return out;
  };

  /** chrome.storage.local, callback style (what content.js's store uses). */
  const local = {
    get(keys, callback) {
      const done = typeof callback === 'function' ? callback : () => {};
      whenBridge((b) => {
        let all = {};
        try { all = parse(b.storageGetAll()); } catch (_) { all = {}; }
        done(pick(all, keys));
      }, () => done({}));
    },
    set(items, callback) {
      queuedWrites.push({ op: 'set', json: JSON.stringify(items) });
      flushWrites();
      if (typeof callback === 'function') callback();
    },
    remove(keys, callback) {
      queuedWrites.push({ op: 'remove', json: JSON.stringify(typeof keys === 'string' ? [keys] : keys) });
      flushWrites();
      if (typeof callback === 'function') callback();
    },
  };

  // window.chrome exists on every page in Chrome itself, so one is left in
  // place (or reused); what the bot adds to it — storage, and the extension
  // members of runtime — is extension-only API no web page has, and is
  // kept off enumeration.
  const chrome = (typeof window.chrome === 'object' && window.chrome !== null) ? window.chrome : {};
  const member = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
    } catch (_) {
      target[name] = value;
    }
  };
  member(chrome, 'storage', {
    local,
    onChanged: { addListener: (fn) => { storageListeners.push(fn); } },
  });
  const runtime = (typeof chrome.runtime === 'object' && chrome.runtime !== null) ? chrome.runtime : {};
  member(runtime, 'lastError', undefined);
  member(runtime, 'getURL', (path) => 'https://appassets.androidplatform.net/assets/bot/' + path);
  member(runtime, 'getManifest', () => {
    const b = bridge();
    let version = '?';
    try { if (b) version = String(b.version()); } catch (_) { /* keep '?' */ }
    return { version };
  });
  member(runtime, 'onMessage', { addListener: (fn) => { messageListeners.push(fn); } });
  if (chrome.runtime !== runtime) member(chrome, 'runtime', runtime);
  if (window.chrome !== chrome) window.chrome = chrome;

  // content.js's exports: the file text goes to the app, which writes it to
  // the phone's Downloads folder (a WebView cannot download a blob: URL).
  hidden('__nexaSaveFile', (name, text) => {
    const b = bridge();
    return b ? b.saveFile(String(name), String(text)) : '';
  });

  // content.js clicks the trade buttons through here when it can: the app
  // taps the screen for real at the given view pixel (Bridge.tap sends the
  // finger-down / finger-up MotionEvents through the WebView), so the page
  // receives the trusted touch a finger makes instead of a synthetic event.
  // Answers the ms until the finger lifts (the tap queues behind typing
  // still going out); false without the bridge or when the app declines —
  // content.js then falls back to its own events.
  hidden('__nexaNativeTap', (x, y) => {
    const b = bridge();
    if (!b || typeof b.tap !== 'function') return false;
    try {
      const ms = b.tap(Number(x), Number(y));
      if (ms === true) return 0;
      return typeof ms === 'number' && ms >= 0 ? ms : false;
    } catch (_) { return false; }
  });
  // ...and types the stake: content.js focuses and selects the amount field,
  // the app sends the digits as hardware key events (Bridge.type), and a tap
  // asked for meanwhile waits its turn behind them.
  hidden('__nexaNativeType', (text) => {
    const b = bridge();
    if (!b || typeof b.type !== 'function') return false;
    try { return b.type(String(text)) === true; } catch (_) { return false; }
  });

  // A platform alarm (content.js): shown by the app as a toast, so it is
  // seen even when the widget is small or the page is busy.
  hidden('__nexaNotify', (text) => {
    const b = bridge();
    if (!b || typeof b.notify !== 'function') return false;
    try { b.notify(String(text)); return true; } catch (_) { return false; }
  });

  /** Entry points the app calls with evaluateJavascript. */
  hidden('__nexaAndroid', {
    /** A key changed in SharedPreferences (the settings screen wrote it). */
    storageChanged(changes) {
      for (const fn of storageListeners) {
        try { fn(changes, 'local'); } catch (_) {}
      }
    },
    /** The settings screen's chrome.tabs.sendMessage; returns the reply as JSON. */
    message(message) {
      let reply = null;
      for (const fn of messageListeners) {
        try {
          fn(message, {}, (response) => { reply = response; });
        } catch (_) {}
      }
      return JSON.stringify(reply === undefined ? null : reply);
    },
  });
})();
