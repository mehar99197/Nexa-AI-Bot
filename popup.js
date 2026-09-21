/* ==========================================================================
   Nexa AI Bot — popup script (also the Android app's settings screen).

   Three views behind a bottom nav, all thin:
     Log.      The content script's last lines (its own tail — the console
               is out of reach on a phone), newest first, refreshed every
               second while the view is open; Export writes them to a file.
     Bot.      The active tab's content script is asked for a snapshot once a
               second (chrome.tabs.sendMessage) — the same numbers the widget
               shows, plus today's limits and the recorder — and painted into
               the hero card, the four tiles and the two rails. Start/Stop,
               the Signal-only quick toggle and the export buttons send it
               commands. A tab without the content script (not a Quotex page)
               just says so.
     Settings. The form is generated from settings.js's SCHEMA. Every change
               is validated and saved at once to ONE chrome.storage.local key
               holding only the values that differ from the defaults; the
               content script listens to storage changes and applies them
               live.
   No inline scripts, no eval: MV3's popup CSP forbids both.
   ========================================================================== */
(() => {
  'use strict';

  const S = NexaSettings;
  const $ = (id) => document.getElementById(id);
  const form = $('settings');
  const DEFAULTS = S.defaults();
  // The Android app's shim sets this; the extension popup has nothing there.
  const app = (typeof window.__nexaApp === 'object' && window.__nexaApp !== null &&
    typeof window.__nexaApp.closeSettings === 'function') ? window.__nexaApp : null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /* ---------------------------- settings form --------------------------- */

  // One stroke icon per group, on the fieldset's legend.
  const GROUP_ICONS = {
    'Trading': ['M13 2L4 14h7l-1 8 9-12h-7z'],
    'Money': ['M3 6h18v13H3z', 'M3 10h18', 'M16 14.5h.01'],
    'Filters': ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
    'Data & alerts': ['M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  };

  function groupIcon(group) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of GROUP_ICONS[group] || ['M4 12h16']) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function control(row) {
    const field = el('label', 'field field-' + row.type);
    field.dataset.key = row.key;
    field.appendChild(el('span', 'name', row.label));
    let input;
    if (row.type === 'bool') {
      input = el('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
    } else if (row.type === 'enum') {
      input = el('select');
      for (const option of row.options) {
        const node = el('option', null, String(option));
        node.value = String(option);
        input.appendChild(node);
      }
    } else {
      input = el('input');
      input.type = 'number';
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = row.type === 'int' ? '1' : 'any';
    }
    input.name = row.key;
    field.appendChild(input);
    field.appendChild(el('span', 'help', row.help));
    return field;
  }

  function build() {
    for (const group of S.GROUPS) {
      const fieldset = el('fieldset');
      const legend = el('legend');
      legend.appendChild(groupIcon(group));
      legend.appendChild(el('span', null, group));
      fieldset.appendChild(legend);
      for (const row of S.SCHEMA) {
        if (row.group === group) fieldset.appendChild(control(row));
      }
      form.appendChild(fieldset);
    }
  }

  function inputFor(key) {
    return form.elements.namedItem(key);
  }

  /** Put stored overrides (over the defaults) into the form. */
  function fill(overrides) {
    for (const row of S.SCHEMA) {
      const value = Object.prototype.hasOwnProperty.call(overrides, row.key)
        ? overrides[row.key] : row.default;
      const input = inputFor(row.key);
      if (row.type === 'bool') input.checked = value === true;
      else input.value = String(value);
      const field = input.closest('.field');
      field.classList.toggle('changed', value !== row.default);
      field.classList.remove('invalid');
    }
    syncQuick();
  }

  /**
   * Read the form back: only the values that differ from the defaults are
   * stored, so untouched knobs follow a future default change. An invalid
   * entry is flagged and left out (the previous stored value stays).
   */
  function read(previous) {
    const overrides = {};
    for (const row of S.SCHEMA) {
      const input = inputFor(row.key);
      const field = input.closest('.field');
      const value = row.type === 'bool' ? input.checked : S.parse(row, input.value);
      if (value === null || !S.valid(row, value)) {
        field.classList.add('invalid');
        if (Object.prototype.hasOwnProperty.call(previous, row.key)) {
          overrides[row.key] = previous[row.key];
        }
        continue;
      }
      field.classList.remove('invalid');
      field.classList.toggle('changed', value !== row.default);
      if (value !== row.default) overrides[row.key] = value;
    }
    return overrides;
  }

  let stored = {};
  let savedTimer = null;

  function flashSaved() {
    const saved = $('saved');
    saved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { saved.hidden = true; }, 1200);
  }

  function save() {
    stored = read(stored);
    syncQuick();
    const write = Object.keys(stored).length === 0
      ? chrome.storage.local.remove(S.SETTINGS_KEY)
      : chrome.storage.local.set({ [S.SETTINGS_KEY]: stored });
    write.then(flashSaved).catch(() => { /* storage unavailable — nothing to do */ });
  }

  async function load() {
    try {
      const items = await chrome.storage.local.get(S.SETTINGS_KEY);
      stored = S.sanitize(items[S.SETTINGS_KEY]).overrides;
    } catch (_) {
      stored = {};
    }
    fill(stored);
  }

  /** The current value of one knob: the override, else the default. */
  const setting = (key) => (Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : DEFAULTS[key]);

  /** The Bot view's Signal-only button mirrors the form's checkbox. */
  function syncQuick() {
    $('signal-only').setAttribute('aria-pressed', setting('SIGNAL_ONLY') === true ? 'true' : 'false');
  }

  /* ------------------------------ status -------------------------------- */

  const money = (value) => (value < 0 ? '−$' : '+$') + Math.abs(value).toFixed(2);
  const dollars = (value) => '$' + Math.round(value).toLocaleString();
  const balance = (value) => '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let tabId = null;

  async function activeTabId() {
    if (tabId !== null) return tabId;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab ? tab.id : null;
    } catch (_) {
      tabId = null;
    }
    return tabId;
  }

  /** Ask the content script on the active tab; null when there is none. */
  async function ask(type) {
    const id = await activeTabId();
    if (id === null) return null;
    try {
      const reply = await chrome.tabs.sendMessage(id, { type });
      return reply && typeof reply === 'object' ? reply : null;
    } catch (_) {
      return null;   // no content script on this tab
    }
  }

  function setBadge(account) {
    const badge = $('account');
    badge.textContent = account === 'live' ? 'LIVE' : account === 'demo' ? 'DEMO' : '—';
    badge.dataset.account = account === 'live' || account === 'demo' ? account : '';
  }

  /** One rail: how much of the limit today's P&L has used, or "off". */
  function rail(fillId, textId, used, limit) {
    const fill = $(fillId);
    const text = $(textId);
    if (!Number.isFinite(limit) || limit <= 0) {
      fill.style.width = '0%';
      text.textContent = 'off';
      return;
    }
    const amount = Math.max(0, used);
    fill.style.width = Math.min(100, amount / limit * 100).toFixed(1) + '%';
    text.textContent = dollars(amount) + ' / ' + dollars(limit);
  }

  function render(status) {
    const hero = $('status');
    const toggle = $('toggle');
    const note = $('note');
    if (status === null) {
      hero.dataset.state = 'idle';
      $('pill').textContent = 'NO PAGE';
      $('balance-label').textContent = 'Balance';
      $('balance').textContent = '$—';
      $('symbol').textContent = '—';
      setBadge(null);
      toggle.disabled = true;
      toggle.textContent = 'Start bot';
      for (const id of ['session', 'today', 'why', 'auto']) $(id).textContent = '—';
      for (const id of ['session-sub', 'today-sub', 'htf', 'auto-sub']) $(id).textContent = '';
      rail('cap-fill', 'cap-text', 0, null);
      rail('target-fill', 'target-text', 0, null);
      note.hidden = false;
      note.textContent = app
        ? 'The chart screen did not answer — the bot may not be loaded there yet. ' +
          'Tap Trade and wait for the card to appear, or long-press the gear to reload the page. Settings still save.'
        : 'Open the Quotex trading page in this tab to control the bot. Settings still save.';
      $('export-ticks').disabled = true;
      $('export-trades').disabled = true;
      $('recorder').textContent = 'Recorder: —';
      return;
    }
    note.hidden = true;
    hero.dataset.state = status.state || 'idle';
    $('pill').textContent = status.pill || '…';
    toggle.disabled = false;
    toggle.textContent = status.running ? 'Stop bot'
      : status.state === 'confirm' ? 'Confirm live' : 'Start bot';

    setBadge(status.account);
    $('balance-label').textContent =
      (status.account === 'live' ? 'Live balance' : status.account === 'demo' ? 'Demo balance' : 'Balance') +
      (status.dry ? ' · dry run' : '');
    $('balance').textContent = Number.isFinite(status.balance) ? balance(status.balance) : '$—';
    $('symbol').textContent = status.symbol
      ? status.symbol + (Number.isFinite(status.price) ? ' · ' + status.price : '')
      : '—';

    $('session').textContent = status.wins + 'W-' + status.losses + 'L';
    $('session-sub').textContent = money(status.pnl || 0) +
      (status.trades ? ' · ' + status.trades + ' trades' : ' · no trades yet');

    const daily = status.daily || {};
    $('today').textContent = money(daily.pnl || 0);
    const limits = [];
    if (Number.isFinite(daily.cap)) limits.push('cap −' + dollars(daily.cap));
    if (Number.isFinite(daily.target)) limits.push('target +' + dollars(daily.target));
    $('today-sub').textContent = limits.length ? limits.join(' · ') : 'no limits set';
    rail('cap-fill', 'cap-text', -(daily.pnl || 0), daily.cap);
    rail('target-fill', 'target-text', daily.pnl || 0, daily.target);

    $('why').textContent = status.why || (status.running ? '…' : 'stopped');
    $('htf').textContent = status.htf || '';

    // Auto mode: the qualified variant when one is armed, else how far the
    // learner is ("learning 41/100" rides in on the why line); a pinned
    // model just names itself.
    const strategy = setting('STRATEGY');
    const learning = /^learning (\S+)/.exec(status.why || '');
    if (status.qualified) {
      $('auto').textContent = status.qualified.replace(/^auto /, '').replace(/ armed$/, '');
      $('auto-sub').textContent = 'armed · real trades on';
    } else if (strategy === 'auto') {
      $('auto').textContent = learning ? learning[1] : 'learning';
      $('auto-sub').textContent = 'virtual · real trades on hold';
    } else {
      $('auto').textContent = strategy;
      $('auto-sub').textContent = 'fixed model';
    }

    const rec = status.recorder || {};
    $('recorder').textContent = 'Recorder ' + (rec.enabled ? 'on' : 'off') +
      (rec.rows > 0 ? ' · ' + rec.rows.toLocaleString() + ' ticks' : '');
    $('export-ticks').disabled = !(rec.rows > 0);
    $('export-trades').disabled = !rec.open;
  }

  /* -------------------------------- log --------------------------------- */

  let lastLogSeq = -1;
  const clock = (t) => {
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
  };

  /** The content script's log tail, newest first; repainted only on a new line. */
  function renderLog(reply) {
    const list = $('log');
    const note = $('log-note');
    const env = $('environment');
    const lines = reply && Array.isArray(reply.lines) ? reply.lines : null;
    if (lines === null) {
      list.replaceChildren();
      env.hidden = true;
      note.hidden = false;
      note.textContent = app
        ? 'The chart screen did not answer — open Trade and wait for the bot card, then come back.'
        : 'Open the Quotex trading page in this tab to see its log.';
      $('export-log').disabled = true;
      lastLogSeq = -1;
      return;
    }
    note.hidden = true;
    $('export-log').disabled = lines.length === 0;
    if (typeof reply.environment === 'string' && reply.environment) {
      env.hidden = false;
      env.textContent = reply.environment.replace(/^Environment: /, '');
    }
    const newest = lines.length ? lines[lines.length - 1].n : 0;
    if (newest === lastLogSeq) return;
    lastLogSeq = newest;
    const items = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const item = el('li');
      if (/^(PLATFORM ALARM|BLOCKED|Cannot start)/.test(line.text)) item.classList.add('alarm');
      else if (/^(Clicked|CONFIRMED|Stake typed|Stake set|WIN|LOSS|DRY RUN)/.test(line.text)) item.classList.add('trade');
      const time = el('time', null, clock(line.t));
      time.dateTime = new Date(line.t).toISOString();
      item.appendChild(time);
      item.appendChild(document.createTextNode(line.text));
      items.push(item);
    }
    list.replaceChildren(...items);
  }

  async function refresh() {
    render(await ask('nexa:status'));
    if (!$('view-log').hidden) renderLog(await ask('nexa:log'));
  }

  /* ------------------------------- views -------------------------------- */

  function showView(name) {
    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== 'view-' + name;
    for (const item of document.querySelectorAll('.nav-item[data-view]')) {
      const active = item.dataset.view === name;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  /* ------------------------------ wiring -------------------------------- */

  build();
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  load();

  form.addEventListener('change', save);
  form.addEventListener('input', (event) => {
    // Numbers save on every keystroke too, so a typo shows red at once.
    if (event.target && event.target.type === 'number') save();
  });

  $('reset').addEventListener('click', () => {
    stored = {};
    fill(stored);
    chrome.storage.local.remove(S.SETTINGS_KEY).then(flashSaved).catch(() => {});
  });

  $('toggle').addEventListener('click', async () => {
    const status = await ask('nexa:status');
    if (status === null) return;
    render(await ask(status.running ? 'nexa:stop' : 'nexa:start'));
  });

  // The quick toggle flips the form's own checkbox and goes through save(),
  // so validation, the "changed" marker and storage stay one code path.
  $('signal-only').addEventListener('click', () => {
    const input = inputFor('SIGNAL_ONLY');
    input.checked = !input.checked;
    save();
  });

  $('export-ticks').addEventListener('click', () => { ask('nexa:export-ticks'); });
  $('export-trades').addEventListener('click', () => { ask('nexa:export-trades'); });
  $('export-log').addEventListener('click', () => { ask('nexa:export-log'); });

  for (const item of document.querySelectorAll('.nav-item[data-view]')) {
    item.addEventListener('click', async () => {
      showView(item.dataset.view);
      // The log is only fetched while its view is open; fill it at once.
      if (item.dataset.view === 'log') renderLog(await ask('nexa:log'));
    });
  }
  // The Android app adds a way back to the chart; the extension popup has
  // none (the chart is the tab underneath).
  if (app) {
    const trade = $('nav-trade');
    trade.hidden = false;
    trade.addEventListener('click', () => app.closeSettings());
  }

  refresh();
  const timer = setInterval(refresh, 1_000);
  window.addEventListener('unload', () => clearInterval(timer));
})();
