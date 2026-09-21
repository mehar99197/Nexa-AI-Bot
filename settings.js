/* The user-settable subset of CONFIG, shared by the popup (which edits it),
   the isolated content script (which applies it over CONFIG) and the tests
   (which check the defaults here never drift from content.js).

   The popup writes ONE chrome.storage.local key (SETTINGS_KEY) holding only
   the keys the user changed; everything else stays at CONFIG's default. The
   content script sanitizes what it reads — the schema is the whitelist, the
   ranges are the rails — so a stale or hand-edited value can never put a
   nonsense number into a money knob. Pure data and pure functions. */
(() => {
  'use strict';

  const SETTINGS_KEY = 'nexa.autotrade.prefs';

  /**
   * One row per knob the popup shows. `type` decides the input and the
   * validation: 'bool', 'int' / 'number' (with min/max), 'enum' (options).
   * `default` must equal the CONFIG default in content.js (a unit test
   * enforces it). `help` is the one line under the control.
   */
  const SCHEMA = Object.freeze([
    // ---- Trading ----
    { key: 'STRATEGY', group: 'Trading', label: 'Strategy', type: 'enum',
      options: ['auto', 'momentum', 'zscore', 'trend'], default: 'auto',
      help: 'auto = learn a pool of models virtually and click only for a proven one.' },
    { key: 'DRY_RUN', group: 'Trading', label: 'Dry run', type: 'bool', default: false,
      help: 'Journal and settle trades virtually. Nothing is clicked.' },
    { key: 'SIGNAL_ONLY', group: 'Trading', label: 'Signal only', type: 'bool', default: false,
      help: 'Flash BUY / SELL and beep, never click — you place the trade.' },
    { key: 'LIVE_ACCOUNT', group: 'Trading', label: 'Live account', type: 'enum',
      options: ['never', 'confirm', 'allow'], default: 'confirm',
      help: 'never = refuse real money; confirm = second tap within 6 s; allow = no question.' },
    { key: 'TRADE_ON_START', group: 'Trading', label: 'Trade on Start', type: 'bool', default: true,
      help: 'First trade within a second of Start, on the current trend (no proven edge).' },
    { key: 'RUN_UNTIL_STOPPED', group: 'Trading', label: 'Run until Stop', type: 'bool', default: true,
      help: 'Loss streaks and unconfirmed clicks pause instead of ending the run.' },
    { key: 'KEEP_TRADING_AFTER_SEC', group: 'Trading', label: 'Keep trading after (s)', type: 'int',
      min: 0, max: 3600, default: 15,
      help: 'Idle this long since the last trade → take the trend state. 0 = signals only.' },
    { key: 'MIN_PAYOUT_PCT', group: 'Trading', label: 'Min payout (%)', type: 'int',
      min: 0, max: 100, default: 70,
      help: 'Skip trades below this payout. 0 = no check.' },
    { key: 'MAX_LOSS_STREAK', group: 'Trading', label: 'Max loss streak', type: 'int',
      min: 0, max: 50, default: 4,
      help: 'Losses in a row that pause (or stop) the run. 0 = off.' },
    { key: 'MAX_TRADES_PER_HOUR', group: 'Trading', label: 'Max trades/hour', type: 'int',
      min: 0, max: 200, default: 20,
      help: 'Cap trades per rolling hour to prevent machine-like high frequency (0 = off).' },
    { key: 'REST_CYCLE_ENABLED', group: 'Trading', label: 'Rest breaks', type: 'bool', default: true,
      help: 'Take natural 5-minute rest breaks after ~25 min of trading.' },
    { key: 'REACTION_DELAY', group: 'Trading', label: 'Reaction delay', type: 'bool', default: true,
      help: 'Natural human reaction delay (0.8-2 s) before clicking.' },
    { key: 'HUMAN_CLICK', group: 'Trading', label: 'Humanized click', type: 'bool', default: true,
      help: 'Place the trade the way a hand does: the mouse travels to the button and rests on it, the press is held, the stake is typed key by key (in the app: a real finger tap). Off = instant synthetic click.' },
    { key: 'SKIP_SIGNAL_PCT', group: 'Trading', label: 'Skip signals (%)', type: 'int',
      min: 0, max: 60, default: 15,
      help: 'Share of model signals deliberately let go, as a person would miss them. Breaks the take-every-signal rhythm. 0 = off.' },
    { key: 'PLATFORM_ALARM', group: 'Trading', label: 'Platform alarm stop', type: 'bool', default: true,
      help: 'Stop at once when the platform shows a captcha, a human check, an unusual-activity notice or a block, and refuse to start while it lasts. Use the site by hand for a while first.' },

    // ---- Money ----
    { key: 'STAKE_MODE', group: 'Money', label: 'Stake sizing', type: 'enum',
      options: ['kelly', 'fixed', 'percent', 'off'], default: 'kelly',
      help: 'kelly = fractional Kelly on measured evidence (minimum stake when nothing is proven); off = leave the amount alone.' },
    { key: 'STAKE_VALUE', group: 'Money', label: 'Stake value', type: 'number',
      min: 0.01, max: 1_000_000, default: 1,
      help: 'Dollars (fixed) or percent of balance (percent).' },
    { key: 'STAKE_MIN', group: 'Money', label: 'Minimum stake ($)', type: 'number',
      min: 0.01, max: 1_000_000, default: 1,
      help: 'The floor every sizing mode respects — the platform minimum.' },
    { key: 'KELLY_FRACTION', group: 'Money', label: 'Kelly fraction', type: 'number',
      min: 0.05, max: 1, default: 0.25,
      help: '0.25 = quarter Kelly. Full Kelly (1) assumes the hit-rate is exactly known — it never is.' },
    { key: 'STAKE_MAX_PCT', group: 'Money', label: 'Max stake (% of balance)', type: 'number',
      min: 0.1, max: 100, default: 5,
      help: 'Hard cap on any single stake.' },
    { key: 'STAKE_HUMAN', group: 'Money', label: 'Human stake values', type: 'bool', default: true,
      help: 'Round the sizer to figures a person types ($1 2 3 5 10 15 20 …) and leave the amount field alone while it is close enough. Off = exact cents, retyped every trade.' },
    { key: 'DAILY_LOSS_CAP_PCT', group: 'Money', label: 'Daily loss cap (%)', type: 'number',
      min: 0, max: 100, default: 10,
      help: 'Stop for the day at −N% of the balance the account had when the bot first traded today. 0 = off.' },
    { key: 'DAILY_PROFIT_TARGET_PCT', group: 'Money', label: 'Daily profit target (%)', type: 'number',
      min: 0, max: 1000, default: 20,
      help: 'Stop for the day at +N%. Banking a good day needs no model. 0 = off.' },
    { key: 'DAILY_LOSS_CAP', group: 'Money', label: 'Daily loss cap ($)', type: 'number',
      min: 0, max: 10_000_000, default: 0,
      help: 'Absolute cap, for when the feed reports no balance. 0 = off.' },

    // ---- Filters ----
    { key: 'HTF_FILTER', group: 'Filters', label: 'Candle-trend filter', type: 'bool', default: true,
      help: 'Hold clicks against the candle trend, and buys into overbought / sells into oversold RSI.' },
    { key: 'HTF_CANDLE_SEC', group: 'Filters', label: 'Candle period (s)', type: 'int',
      min: 10, max: 3600, default: 60,
      help: '60 = 1-minute candles. Changing it restarts the candle history.' },
    { key: 'HTF_RSI_BLOCK', group: 'Filters', label: 'RSI block level', type: 'int',
      min: 0, max: 100, default: 70,
      help: 'Block buys at/above this RSI and sells at/below its mirror (100 − level). 0 = off.' },

    // ---- Data & alerts ----
    { key: 'RECORD_TICKS', group: 'Data & alerts', label: 'Record ticks', type: 'bool', default: false,
      help: 'Journal every quote for the backtester (tens of MB over a day). Export below.' },
    { key: 'ALERT_SOUND', group: 'Data & alerts', label: 'Beep on trade', type: 'bool', default: true,
      help: 'High tone for BUY, low for SELL.' },
  ]);

  const GROUPS = Object.freeze([...new Set(SCHEMA.map((row) => row.group))]);

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  /** Is `value` acceptable for this schema row? */
  function valid(row, value) {
    switch (row.type) {
      case 'bool': return value === true || value === false;
      case 'int': return Number.isInteger(value) && value >= row.min && value <= row.max;
      case 'number': return finite(value) && value >= row.min && value <= row.max;
      case 'enum': return row.options.includes(value);
      default: return false;
    }
  }

  /**
   * The overrides a stored settings object is allowed to apply: only
   * schema keys, only valid values. Anything else is reported, not applied
   * — a money knob outside its rails must fall back to the default, never
   * be "clamped" into something the user did not type.
   * @param {*} raw whatever chrome.storage returned
   * @returns {{overrides: Object, rejected: string[]}}
   */
  function sanitize(raw) {
    const overrides = {};
    const rejected = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { overrides, rejected };
    for (const row of SCHEMA) {
      if (!Object.prototype.hasOwnProperty.call(raw, row.key)) continue;
      const value = raw[row.key];
      if (valid(row, value)) overrides[row.key] = value;
      else rejected.push(row.key);
    }
    return { overrides, rejected };
  }

  /** Parse what an <input> holds into the row's type; null when unusable. */
  function parse(row, text) {
    if (row.type === 'bool') return text === true || text === 'true' || text === 'on';
    if (row.type === 'enum') return row.options.includes(text) ? text : null;
    const trimmed = String(text).trim();
    if (trimmed === '') return null;        // Number('') is 0 — a cleared field is not a zero
    const value = Number(trimmed);
    if (!finite(value)) return null;
    if (row.type === 'int') return Number.isInteger(value) ? value : null;
    return value;
  }

  /** { key: default } for every row — the popup's reset target. */
  function defaults() {
    const out = {};
    for (const row of SCHEMA) out[row.key] = row.default;
    return out;
  }

  const api = Object.freeze({ SETTINGS_KEY, SCHEMA, GROUPS, valid, sanitize, parse, defaults });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && !('NexaSettings' in globalThis)) {
    // Guarded: redefining a non-configurable property on a second injection
    // into the same context would throw and kill the whole script.
    Object.defineProperty(globalThis, 'NexaSettings', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
