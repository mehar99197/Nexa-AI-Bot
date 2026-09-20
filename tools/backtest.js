#!/usr/bin/env node
'use strict';

/* ==========================================================================
   Nexa backtest harness — replays a tick export through the live modules.

   Input: the JSON file the widget's Export button downloads
   (format "nexa-ticks-v1": { ticks: [[symbol, serverTs, arrivalMs, price],
   ...], trades: [...] }).

   For every historical sample it computes the signal the way content.js
   does — same history cap, same gap segmentation, and the SAME horizon
   windows for the chosen expiry (horizons.js; this used to replay a
   hardcoded 60s copy whatever --expiry said) — then labels each signal with
   what the price did one expiry later. Two views are reported: every signal
   (raw model accuracy) and a cooldown-respecting simulation (the trades the
   live bot would actually have taken, with EV in stakes).

   --auto replays the auto-mode scoreboard itself: the whole variant pool
   trades virtually, records roll, and a "real" trade is taken only when a
   variant qualified under the live bar (Wilson lower bound) fired — the
   closest offline answer to "would auto mode have made money on my feed".

   What it still cannot replay: slippage (unless real fills are in the
   export, whose median is then applied as an entry handicap), the server's
   settlement price, the payout/duration read off the page, and the
   post-reset/thin-feed vetoes' exact timing.

   Usage:
     node tools/backtest.js <export.json> [options]
       --strategy momentum|zscore|trend|both   models to replay  (default both;
                                         'trend' = trade the EMA state every cooldown)
       --expiry <sec>                    label horizon; picks the windows (default 60)
       --payout <pct>                    payout for EV/break-even (default 85)
       --cooldown <sec>                  simulated trade spacing (default 60)
       --symbol <SYM>                    restrict to one symbol
       --auto                            replay the auto-mode scoreboard
       --sweep                           parameter grid search
       --json                            machine-readable output
   ========================================================================== */

const fs = require('node:fs');
const { decide } = require('../strategy.js');
const AP = require('../autopilot.js');
const { horizonFor, buildVariants } = require('../horizons.js');

// Mirror content.js — the replay must see exactly what the live bot sees.
const MAX_HISTORY = 300;
const MAX_SAMPLE_GAP_MS = 5_000;
const EXPIRY_TOLERANCE_MS = 5_000;
const MAX_REALIZED_VOLATILITY = 0.001;
const MIN_TICKS_10S = 8;
const POST_RESET_QUIET_MS = 30_000;
// Auto-mode bar, as in content.js CONFIG.
const AUTO = { MIN_SAMPLES: 100, MARGIN: 0.01, ROLLING: 300, CONFIDENCE_Z: 2.0 };

/** The single-model configs the live bot runs for this expiry. */
function baseConfigsFor(expirySec) {
  const row = horizonFor(expirySec);
  return {
    momentum: { STRATEGY: 'momentum', ...row.momentum, MAX_REALIZED_VOLATILITY },
    zscore: { STRATEGY: 'zscore', ...row.zscore, MAX_REALIZED_VOLATILITY },
    // Trend state: a signal on every sample, so the cooldown sets the
    // cadence — replays the live 'Trend Follow' mode (and the direction the
    // instant entry after Start would pick).
    trend: { STRATEGY: 'trend', ...row.momentum, MAX_REALIZED_VOLATILITY },
  };
}

// Kept for callers/tests that want the 60s defaults by name.
const BASE_CONFIGS = baseConfigsFor(60);

/** [[sym, serverTs, arrivalMs, price], ...] -> Map(sym -> sorted samples). */
function groupBySymbol(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [sym, ts, t, price] = row;
    if (typeof sym !== 'string' || !Number.isFinite(t) ||
        !Number.isFinite(price) || price <= 0) {
      continue;
    }
    if (!map.has(sym)) map.set(sym, []);
    map.get(sym).push({ ts, t, price });
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t);
  return map;
}

/** Split on receive gaps, mirroring the live history reset. Segments of a
    single sample carry no return and are dropped. */
function segmentSamples(samples, gapMs) {
  const segments = [];
  let current = [];
  for (const sample of samples) {
    const prev = current[current.length - 1];
    if (prev && sample.t - prev.t > gapMs) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/**
 * What the price did one expiry after segment[index]: the first sample at or
 * past t + expiryMs settles the option. null when the segment ends first or
 * the settling sample is more than toleranceMs late (a data hole at expiry).
 * `entry` overrides the entry price (slippage handicap).
 */
function labelAt(segment, index, expiryMs, toleranceMs, entry) {
  const target = segment[index].t + expiryMs;
  const entryPrice = entry === undefined ? segment[index].price : entry;
  for (let j = index + 1; j < segment.length; j += 1) {
    if (segment[j].t >= target) {
      if (segment[j].t - target > toleranceMs) return null;
      return {
        label: Math.sign(segment[j].price - entryPrice),
        expiryPrice: segment[j].price,
        at: segment[j].t,
      };
    }
  }
  return null;
}

/**
 * The live tradeVeto gates that can be replayed offline: a thin feed (fewer
 * than MIN_TICKS_10S samples in the last 10s) and the quiet period after a
 * history reset (every segment starts with one). Returns a reason or null.
 */
function offlineVeto(segment, index) {
  const now = segment[index].t;
  if (now - segment[0].t < POST_RESET_QUIET_MS) return 'stabilizing';
  let recent = 0;
  for (let k = index; k >= 0 && now - segment[k].t <= 10_000; k -= 1) recent += 1;
  if (recent < MIN_TICKS_10S) return 'thin feed';
  return null;
}

function isWin(signal) {
  return signal.dir === 'UP' ? signal.label > 0 : signal.label < 0;
}

function tally(signals) {
  const labeled = signals.filter((s) => s.label !== null);
  const wins = labeled.filter(isWin).length;
  const draws = labeled.filter((s) => s.label === 0).length;
  const losses = labeled.length - wins - draws;
  const decided = wins + losses;
  return {
    total: signals.length,
    labeled: labeled.length,
    wins,
    losses,
    draws,
    hitRate: decided === 0 ? null : wins / decided,
    // What we can be confident the hit-rate really is — the number that
    // matters when comparing configurations (see printSweep).
    lowerBound: decided === 0 ? null : AP.wilsonLowerBound(wins, decided, AUTO.CONFIDENCE_Z),
  };
}

/** The trades the live bot would have taken: every signal consumes the
    cooldown (even one that later can't be labeled), takers are spaced. */
function simulateTrades(signals, cooldownMs) {
  let lastAt = -Infinity;
  const taken = [];
  for (const signal of signals) {
    if (signal.t - lastAt < cooldownMs) continue;
    lastAt = signal.t;
    taken.push(signal);
  }
  return taken;
}

/** Entry price after the slippage handicap, in the trade's direction. */
function handicapped(price, dir, slippageFrac) {
  if (!slippageFrac) return price;
  return dir === 'UP' ? price * (1 + slippageFrac) : price * (1 - slippageFrac);
}

function withEv(tallied, payoutPct) {
  const decided = tallied.wins + tallied.losses;
  const ev = tallied.wins * (payoutPct / 100) - tallied.losses;
  return {
    ...tallied,
    ev: +ev.toFixed(2),
    evPerTrade: decided === 0 ? null : +(ev / decided).toFixed(3),
  };
}

function backtestSymbol(samples, config, opts) {
  const reasons = Object.create(null);
  const signals = [];
  let evaluations = 0;
  const slip = opts.slippageFrac || 0;

  for (const segment of segmentSamples(samples, MAX_SAMPLE_GAP_MS)) {
    const history = [];
    for (let index = 0; index < segment.length; index += 1) {
      history.push({ t: segment[index].t, price: segment[index].price });
      if (history.length > MAX_HISTORY) history.shift();
      const view = decide(history, config);
      evaluations += 1;
      if (!view.signal) {
        reasons[view.reason] = (reasons[view.reason] || 0) + 1;
        continue;
      }
      const veto = opts.vetoes === false ? null : offlineVeto(segment, index);
      if (veto) {
        reasons['held: ' + veto] = (reasons['held: ' + veto] || 0) + 1;
        continue;
      }
      reasons[view.reason] = (reasons[view.reason] || 0) + 1;
      const entry = handicapped(segment[index].price, view.signal, slip);
      const outcome = labelAt(segment, index, opts.expiryMs, EXPIRY_TOLERANCE_MS, entry);
      signals.push({
        t: segment[index].t,
        dir: view.signal,
        price: segment[index].price,
        label: outcome === null ? null : outcome.label,
      });
    }
  }

  const all = tally(signals);
  const taken = simulateTrades(signals, opts.cooldownMs);
  return {
    evaluations,
    reasons,
    all,
    trades: withEv(tally(taken), opts.payoutPct),
  };
}

/**
 * Replay auto mode: every variant trades virtually on each sample, virtual
 * outcomes roll into per-variant records, and a "real" trade is taken when a
 * variant that fired is currently qualified — exactly content.js's
 * autoOnSample + bestQualified, minus the DOM.
 */
function backtestAuto(samples, opts) {
  const row = horizonFor(opts.expiryMs / 1000);
  const pool = buildVariants(row, MAX_REALIZED_VOLATILITY);
  const breakEven = AP.breakEvenRate(opts.payoutPct);
  const qualify = { breakEven, minSamples: AUTO.MIN_SAMPLES, margin: AUTO.MARGIN,
    confidenceZ: AUTO.CONFIDENCE_Z };
  const records = {};
  const statsOf = (id) => AP.statsOf(records[id]);
  const slip = opts.slippageFrac || 0;
  const real = [];
  let virtualCount = 0;
  let firstQualifiedAt = null;
  let zaThreshold = row.zscore.Z_SCORE_THRESHOLD;
  const zBuffer = [];

  for (const segment of segmentSamples(samples, MAX_SAMPLE_GAP_MS)) {
    const history = [];
    let pendings = [];
    for (let index = 0; index < segment.length; index += 1) {
      const sample = { t: segment[index].t, price: segment[index].price };
      history.push(sample);
      if (history.length > MAX_HISTORY) history.shift();

      const settled = AP.settlePendings(pendings, sample, EXPIRY_TOLERANCE_MS);
      pendings = settled.keep;
      for (const { variantId, outcome } of settled.outcomes) {
        records[variantId] = AP.recordOutcome(records[variantId], outcome, AUTO.ROLLING);
        virtualCount += 1;
      }

      const er = AP.efficiencyRatio(history, 30);
      const fired = [];
      for (const variant of pool) {
        if (pendings.some((p) => p.variantId === variant.id)) continue;
        if (variant.minER !== undefined && (er === null || er < variant.minER)) continue;
        const config = variant.adaptive
          ? { ...variant.config, Z_SCORE_THRESHOLD: zaThreshold } : variant.config;
        const result = decide(history, config);
        if (variant.adaptive && Number.isFinite(result.zScore) && result.zScore !== 0) {
          zBuffer.push(Math.abs(result.zScore));
          if (zBuffer.length > 240) zBuffer.shift();
          if (zBuffer.length >= 40) {
            const p90 = AP.percentile(zBuffer, 0.9);
            if (p90 !== null) zaThreshold = Math.min(3, Math.max(1, p90));
          }
        }
        if (!result.signal) continue;
        pendings.push({
          variantId: variant.id, dir: result.signal,
          price: handicapped(sample.price, result.signal, slip),
          expiresAt: sample.t + opts.expiryMs,
        });
        fired.push(variant.id);
      }

      const best = AP.bestQualified(fired, statsOf, qualify);
      if (best === null) continue;
      if (firstQualifiedAt === null) firstQualifiedAt = sample.t;
      if (offlineVeto(segment, index)) continue;
      const dir = pendings.find((p) => p.variantId === best.id).dir;
      const outcome = labelAt(segment, index, opts.expiryMs, EXPIRY_TOLERANCE_MS,
        handicapped(sample.price, dir, slip));
      real.push({ t: sample.t, dir, variant: best.id, label: outcome === null ? null : outcome.label });
    }
  }

  const taken = simulateTrades(real, opts.cooldownMs);
  const variants = pool.map((v) => ({ id: v.id, ...statsOf(v.id),
    lowerBound: (() => { const s = statsOf(v.id); return s.n === 0 ? null
      : AP.wilsonLowerBound(s.wins, s.n, AUTO.CONFIDENCE_Z); })() }));
  return {
    horizon: row.label,
    breakEven,
    bar: breakEven + AUTO.MARGIN,
    virtualOutcomes: virtualCount,
    variants,
    firstQualifiedAt,
    real: withEv(tally(taken), opts.payoutPct),
  };
}

function sweepConfigs(strategy, expirySec) {
  const base = baseConfigsFor(expirySec);
  const configs = [];
  if (strategy === 'momentum' || strategy === 'both') {
    // The live pool's spread around the horizon's base pair, plus a
    // MIN_MOMENTUM axis.
    for (const [fs, ss] of [[0.65, 0.65], [1, 1], [1.45, 1.5]]) {
      const fast = Math.max(2, Math.round(base.momentum.EMA_FAST * fs));
      const slow = Math.max(fast + 2, Math.round(base.momentum.EMA_SLOW * ss));
      for (const scale of [0.5, 1, 3]) {
        configs.push({
          ...base.momentum, EMA_FAST: fast, EMA_SLOW: slow,
          MOMENTUM_TICKS: Math.min(base.momentum.MOMENTUM_TICKS, slow),
          MIN_MOMENTUM: base.momentum.MIN_MOMENTUM * scale,
        });
      }
    }
  }
  if (strategy === 'zscore' || strategy === 'both') {
    const z0 = base.zscore.Z_SCORE_THRESHOLD;
    for (const z of [z0 - 0.3, z0, z0 + 0.5]) {
      for (const scale of [0.5, 1, 2]) {
        configs.push({
          ...base.zscore, Z_SCORE_THRESHOLD: +z.toFixed(2),
          MIN_EFFICIENCY_RATIO: +(base.zscore.MIN_EFFICIENCY_RATIO * scale).toFixed(3),
        });
      }
    }
  }
  return configs;
}

function configLabel(config) {
  if (config.STRATEGY === 'trend') {
    return 'trend state EMA ' + config.EMA_FAST + '/' + config.EMA_SLOW + ' (every cooldown)';
  }
  return config.STRATEGY === 'momentum'
    ? 'momentum EMA ' + config.EMA_FAST + '/' + config.EMA_SLOW +
      ' mom' + config.MOMENTUM_TICKS + '>=' + config.MIN_MOMENTUM
    : 'zscore z>=' + config.Z_SCORE_THRESHOLD +
      ' eff>=' + config.MIN_EFFICIENCY_RATIO;
}

/* ---------------------------- reporting --------------------------------- */

function pct(value) {
  return value === null || value === undefined ? '--' : (value * 100).toFixed(1) + '%';
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function topReasons(reasons, n) {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => reason + ' ' + count.toLocaleString())
    .join(' · ');
}

function printReport(results, breakEven) {
  for (const r of results) {
    console.log('\n' + r.symbol + ' — ' + r.config);
    console.log('  evaluations ' + r.evaluations.toLocaleString() +
      ' | signals ' + r.all.total + ' (' + r.all.labeled + ' labeled)');
    console.log('  all signals: ' + r.all.wins + 'W-' + r.all.losses + 'L-' +
      r.all.draws + 'D  hit ' + pct(r.all.hitRate) + '  lower bound ' + pct(r.all.lowerBound));
    console.log('  simulated trades: ' + r.trades.total + ' taken — ' +
      r.trades.wins + 'W-' + r.trades.losses + 'L-' + r.trades.draws + 'D' +
      '  hit ' + pct(r.trades.hitRate) + '  lower bound ' + pct(r.trades.lowerBound) +
      ' | EV ' + (r.trades.ev >= 0 ? '+' : '') + r.trades.ev + ' stakes' +
      (r.trades.lowerBound === null ? '' :
        '  [' + (r.trades.lowerBound >= breakEven ? 'PROVEN above' : 'not proven above') +
        ' break-even]'));
    console.log('  gates: ' + topReasons(r.reasons, 4));
  }
}

// A grid of ~18 configurations ranked by EV on 5 trades is a lottery, not a
// calibration: the winner is whichever one got lucky. Rows need 30 decided
// trades to appear, and they are ranked by the Wilson lower bound of the
// hit-rate — the estimate that already pays for its own sample size.
const SWEEP_MIN_DECIDED = 30;

function printSweep(results, breakEven) {
  const rows = results
    .filter((r) => r.trades.wins + r.trades.losses >= SWEEP_MIN_DECIDED)
    .sort((a, b) => (b.trades.lowerBound || 0) - (a.trades.lowerBound || 0));
  if (rows.length === 0) {
    console.log('\nNo configuration produced ' + SWEEP_MIN_DECIDED +
      '+ decided trades — record more data first. (Ranking fewer than that ' +
      'just picks the luckiest configuration.)');
    return;
  }
  console.log('\n' + pad('symbol', 16) + pad('config', 42) + pad('trades', 8) +
    pad('hit', 8) + pad('LB', 8) + pad('EV/trade', 10) + 'verdict');
  for (const r of rows.slice(0, 30)) {
    console.log(pad(r.symbol, 16) + pad(r.config, 42) +
      pad(r.trades.wins + r.trades.losses, 8) + pad(pct(r.trades.hitRate), 8) +
      pad(pct(r.trades.lowerBound), 8) + pad(r.trades.evPerTrade, 10) +
      (r.trades.lowerBound >= breakEven ? 'proven above BE' : 'not proven'));
  }
  if (rows.length > 30) console.log('… ' + (rows.length - 30) + ' more rows (use --json for all)');
  console.log('\nRead "proven above BE" as: the one-sided ~97.7% lower confidence bound ' +
    'of the hit-rate on THIS recording clears break-even. Out-of-sample it will be lower — ' +
    'the best of ' + results.length + ' configurations is still the best of ' +
    results.length + '.');
}

function printAuto(results) {
  for (const r of results) {
    console.log('\n' + r.symbol + ' — auto mode, horizon ' + r.horizon +
      ' (bar: lower bound >= ' + pct(r.bar) + ' over ' + AUTO.MIN_SAMPLES + ')');
    console.log('  virtual outcomes ' + r.virtualOutcomes.toLocaleString() +
      (r.firstQualifiedAt === null ? ' | no variant ever qualified'
        : ' | first qualification at ' + new Date(r.firstQualifiedAt).toISOString()));
    for (const v of r.variants) {
      console.log('    ' + pad(v.id, 8) + (v.n === 0 ? '--'
        : pct(v.hitRate) + '/' + v.n + '  LB ' + pct(v.lowerBound)));
    }
    console.log('  real trades the bot would have taken: ' + r.real.total + ' — ' +
      r.real.wins + 'W-' + r.real.losses + 'L-' + r.real.draws + 'D  hit ' +
      pct(r.real.hitRate) + '  LB ' + pct(r.real.lowerBound) + ' | EV ' +
      (r.real.ev >= 0 ? '+' : '') + r.real.ev + ' stakes');
  }
}

/** Real trades only — dry-run rows are journaled too (mode "dry") and
    would otherwise inflate the account's record. */
function realTradeRows(trades) {
  return trades.filter((t) => t && !t.dry);
}

function printRealTrades(trades) {
  const rows = realTradeRows(trades);
  const dryCount = trades.length - rows.length;
  const wins = rows.filter((t) => t.profit > 0).length;
  const losses = rows.filter((t) => t.profit < 0).length;
  const draws = rows.length - wins - losses;
  const pnl = rows.reduce(
    (total, t) => total + (Number.isFinite(t.profit) ? t.profit : 0), 0);
  console.log('\nReal recorded trades: ' + rows.length + ' — ' +
    wins + 'W-' + losses + 'L-' + draws + 'D | P&L ' + pnl.toFixed(2) +
    (dryCount > 0 ? ' (' + dryCount + ' dry-run rows excluded)' : ''));
  const slips = rows.filter((t) => Number.isFinite(t.slippage) &&
    Number.isFinite(t.clickPrice) && t.clickPrice > 0);
  if (slips.length > 0) {
    const avgAbs = slips.reduce(
      (total, t) => total + Math.abs(t.slippage / t.clickPrice), 0) / slips.length;
    console.log('Avg |slippage|: ' + (avgAbs * 100).toFixed(4) +
      '% of price over ' + slips.length + ' fills');
  }
}

/** Median |slippage| as a fraction of price from the export's real fills,
    or 0 when there are fewer than 5 — mirrors CONFIG.MIN_SLIPPAGE_SAMPLES. */
function medianSlippageFrac(trades) {
  const fracs = realTradeRows(trades || [])
    .filter((t) => Number.isFinite(t.slippage) && Number.isFinite(t.clickPrice) && t.clickPrice > 0)
    .map((t) => Math.abs(t.slippage / t.clickPrice))
    .sort((a, b) => a - b);
  if (fracs.length < 5) return 0;
  const mid = fracs.length >> 1;
  return fracs.length % 2 ? fracs[mid] : (fracs[mid - 1] + fracs[mid]) / 2;
}

/* ------------------------------ CLI ------------------------------------- */

function parseArgs(argv) {
  const opts = {
    file: null, strategy: 'both', expirySec: 60, payoutPct: 85,
    cooldownSec: 60, symbol: null, sweep: false, auto: false, json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sweep') opts.sweep = true;
    else if (arg === '--auto') opts.auto = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--strategy') { opts.strategy = argv[index + 1]; index += 1; }
    else if (arg === '--expiry') { opts.expirySec = Number(argv[index + 1]); index += 1; }
    else if (arg === '--payout') { opts.payoutPct = Number(argv[index + 1]); index += 1; }
    else if (arg === '--cooldown') { opts.cooldownSec = Number(argv[index + 1]); index += 1; }
    else if (arg === '--symbol') { opts.symbol = argv[index + 1]; index += 1; }
    else if (!arg.startsWith('--') && opts.file === null) opts.file = arg;
    else { console.error('Unknown option: ' + arg); process.exit(2); }
  }
  if (!opts.file) {
    console.error('Usage: node tools/backtest.js <export.json> ' +
      '[--strategy momentum|zscore|trend|both] [--expiry sec] [--payout pct] ' +
      '[--cooldown sec] [--symbol SYM] [--auto] [--sweep] [--json]');
    process.exit(2);
  }
  if (!['momentum', 'zscore', 'trend', 'both'].includes(opts.strategy) ||
      !Number.isFinite(opts.expirySec) || opts.expirySec <= 0 ||
      !Number.isFinite(opts.payoutPct) || opts.payoutPct <= 0 ||
      !Number.isFinite(opts.cooldownSec) || opts.cooldownSec < 0) {
    console.error('Invalid option value.');
    process.exit(2);
  }
  opts.expiryMs = opts.expirySec * 1000;
  opts.cooldownMs = opts.cooldownSec * 1000;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  if (raw.format !== 'nexa-ticks-v1' || !Array.isArray(raw.ticks)) {
    console.error('Not a nexa-ticks-v1 export: ' + opts.file);
    process.exit(2);
  }

  const bySymbol = groupBySymbol(raw.ticks);
  const symbols = [...bySymbol.keys()]
    .filter((sym) => opts.symbol === null || sym === opts.symbol);
  if (symbols.length === 0) {
    console.error(opts.symbol === null
      ? 'No usable ticks in the export.'
      : 'Symbol not in export: ' + opts.symbol +
        '. Available: ' + [...bySymbol.keys()].join(', '));
    process.exit(2);
  }

  // Payout p% needs a hit-rate of 1/(1+p) just to break even.
  const breakEven = 100 / (100 + opts.payoutPct);
  opts.slippageFrac = medianSlippageFrac(raw.trades);
  const horizon = horizonFor(opts.expirySec);
  if (!opts.json) {
    console.log('Loaded ' + raw.ticks.length.toLocaleString() + ' ticks, ' +
      bySymbol.size + ' symbols | expiry ' + opts.expirySec + 's (horizon ' + horizon.label +
      ') | payout ' + opts.payoutPct + '% -> break-even hit-rate ' +
      (breakEven * 100).toFixed(1) + '%' +
      (opts.slippageFrac > 0
        ? ' | entry handicap ' + (opts.slippageFrac * 100).toFixed(4) + '% (median real slippage)'
        : ' | no slippage handicap (fewer than 5 real fills in the export)'));
  }

  if (opts.auto) {
    const results = symbols.map((sym) => ({ symbol: sym, ...backtestAuto(bySymbol.get(sym), opts) }));
    if (opts.json) console.log(JSON.stringify({ breakEven, results }, null, 2));
    else {
      printAuto(results);
      if (Array.isArray(raw.trades) && raw.trades.length > 0) printRealTrades(raw.trades);
    }
    return;
  }

  const base = baseConfigsFor(opts.expirySec);
  const configs = opts.sweep ? sweepConfigs(opts.strategy, opts.expirySec)
    : opts.strategy === 'both'
      ? [base.momentum, base.zscore]
      : [base[opts.strategy]];

  const results = [];
  for (const sym of symbols) {
    const samples = bySymbol.get(sym);
    for (const config of configs) {
      const result = backtestSymbol(samples, config, opts);
      results.push({ symbol: sym, config: configLabel(config), ...result });
    }
    if (!opts.json && opts.sweep) {
      console.log('swept ' + sym + ' (' + samples.length.toLocaleString() + ' ticks)');
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ breakEven, results }, null, 2));
    return;
  }
  if (opts.sweep) printSweep(results, breakEven);
  else printReport(results, breakEven);

  if (Array.isArray(raw.trades) && raw.trades.length > 0) {
    printRealTrades(raw.trades);
  }
}

module.exports = {
  groupBySymbol, segmentSamples, labelAt, offlineVeto, backtestSymbol, backtestAuto,
  simulateTrades, sweepConfigs, baseConfigsFor, medianSlippageFrac, BASE_CONFIGS,
};

if (require.main === module) main();
