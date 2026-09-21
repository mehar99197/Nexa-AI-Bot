/* Nexa AI Bot — Android popup shim.

   Loaded by assets/bot/popup.html (the build inserts the tag) before
   settings.js and popup.js, so the unchanged popup script finds the three
   chrome.* APIs it uses, promise style:

     chrome.storage.local   -> the same SharedPreferences the trading page's
                               shim uses (one store, so a knob turned here
                               reaches content.js through onChanged)
     chrome.tabs            -> query() names the one "tab" there is, and
                               sendMessage() is relayed by the app into the
                               trading page's WebView (window.__nexaAndroid
                               .message). The relay is ASYNCHRONOUS: the
                               request goes out with an id, the app answers
                               through window.__nexaPopup.reply(id, json).
                               It used to block this page's JavaScript for up
                               to three seconds per status poll — once a
                               second — which is what made the screen crawl.
     chrome.runtime         -> getManifest() for the version line
     window.__nexaApp       -> closeSettings(), which the popup's Trade tab
                               calls to get back to the chart (Bridge finishes
                               SettingsActivity) */
(() => {
  'use strict';

  // The same name the trading page uses (shim.js BRIDGE_NAME); this screen is
  // the app's own page, so nothing here needs hiding.
  const bridge = window.nxHost;
  if (!bridge) {
    console.error('[Nexa] app bridge (nxHost) missing — the settings screen cannot save.');
    return;
  }

  const parse = (text) => {
    if (text === null || text === undefined || text === '' || text === 'null') return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  };

  /* ---- the async relay ------------------------------------------------ */

  const REPLY_TIMEOUT_MS = 4000;
  const pending = new Map();   // id -> { resolve, reject, timer }
  let seq = 0;

  window.__nexaPopup = {
    /** The app delivers the trading page's answer here. */
    reply(id, text) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      const reply = parse(text);
      // popup.js treats a rejection as "no content script on this tab".
      if (reply === null) entry.reject(new Error('no page'));
      else entry.resolve(reply);
    },
  };

  function sendMessage(_tabId, message) {
    const json = JSON.stringify(message);
    if (typeof bridge.sendToPageAsync !== 'function') {
      // An older app build: the blocking relay.
      const reply = parse(bridge.sendToPage(json));
      return reply === null ? Promise.reject(new Error('no page')) : Promise.resolve(reply);
    }
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = 'r' + seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('no page'));
      }, REPLY_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        bridge.sendToPageAsync(id, json);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: String(bridge.version()) }),
    },
    storage: {
      local: {
        get(keys) {
          const all = parse(bridge.storageGetAll()) || {};
          if (keys === null || keys === undefined) return Promise.resolve(all);
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(all, key)) out[key] = all[key];
          }
          return Promise.resolve(out);
        },
        set(items) {
          bridge.storageSet(JSON.stringify(items));
          return Promise.resolve();
        },
        remove(keys) {
          bridge.storageRemove(JSON.stringify(typeof keys === 'string' ? [keys] : keys));
          return Promise.resolve();
        },
      },
      onChanged: { addListener() { /* the settings screen only writes */ } },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage,
    },
  };

  // The popup shows its Trade tab only when this exists.
  if (typeof bridge.closeSettings === 'function') {
    window.__nexaApp = { closeSettings: () => { bridge.closeSettings(); } };
  }
})();
