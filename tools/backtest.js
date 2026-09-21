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

   --walk-forward is the honest version of --sweep: the recording is cut
   into time slices, the configuration is picked on the slices BEFORE each
   one and then traded on that slice unseen. A sweep winner that does not
   survive this was fitted to noise.

   Usage:
     node tools/backtest.js [export.json ...] [options]
       (no file: every *.json in recordings/ — several exports are merged and
        de-duplicated, so overlapping journals are fine)
       --strategy momentum|zscore|trend|both   models to replay  (default both;
                                         'trend' = trade the EMA state every cooldown)
       --expiry <sec>                    label horizon; picks the windows (default 60)
       --payout <pct>                    payout for EV/break-even (default 85)
       --cooldown <sec>                  simulated trade spacing (default 60)
       --symbol <SYM>                    restrict to one symbol
       --auto                            replay the auto-mode scoreboard
       --sweep                           parameter grid search (in-sample)
       --walk-forward [folds]            out-of-sample evaluation (default 5 folds)
       --by-hour                         hit-rate by local hour of day
       --htf                             apply the candle-trend / RSI filter
                                         (CONFIG.HTF_* in content.js) to every entry
       --json                            machine-readable output
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { decide } = require('../strategy.js');
const AP = require('../autopilot.js');
const { horizonFor, buildVariants } = require('../horizons.js');
const Candles = require('../candles.js');

// A grid of ~18 configurations ranked by EV on 5 trades is a lottery, not a
// calibration: the winner is whichever one got lucky. Rows need 30 decided
// trades to appear (in a sweep, or to be chosen by a walk-forward fold), and
// they are ranked by the Wilson lower bound of the hit-rate — the estimate
// that already pays for its own sample size.
const SWEEP_MIN_DECIDED = 30;

// Mirror content.js — the replay must see exactly what the live bot sees.
const MAX_HISTORY = 300;
const MAX_SAMPLE_GAP_MS = 5_000;
const EXPIRY_TOLERANCE_MS = 5_000;
const MAX_REALIZED_VOLATILITY = 0.001;
const MIN_TICKS_10S = 8;
const POST_RESET_QUIET_MS = 30_000;
// Auto-mode bar, as in content.js CONFIG.
const AUTO = { MIN_SAMPLES: 100, MARGIN: 0.01, ROLLING: 300, CONFIDENCE_Z: 2.0 };
// The higher-timeframe filter, as in content.js CONFIG (HTF_*).
const HTF = { CANDLE_SEC: 60, EMA_FAST: 8, EMA_SLOW: 21, RSI_PERIOD: 14, RSI_BLOCK: 70, KEEP: 240 };

/**
 * The live tradeVeto's candle gates, replayed: a fresh series per call
 * that the caller feeds every sample of the symbol (candles persist across
 * gap segments, as they do live). `veto(dir)` names the gate that would
 * hold an entry in that direction, or null.
 */
function htfGate() {
  const series = Candles.createSeries(HTF.CANDLE_SEC * 1000, HTF.KEEP);
  const opts = { fast: HTF.EMA_FAST, slow: HTF.EMA_SLOW, rsiPeriod: HTF.RSI_PERIOD, rsiBlock: HTF.RSI_BLOCK };
  return {
    push: (t, price) => Candles.push(series, t, price),
    veto: (dir) => {
      const view = Candles.bias(series, opts);
      if (view.warm && view.dir !== null && view.dir !== dir) return 'against candle trend';
      if ((dir === 'UP' && view.blockUp) || (dir === 'DOWN' && view.blockDown)) return 'rsi stretched';
      return null;
    },
  };
}

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

/** Every signal one configuration produces over the samples, labeled one
    expiry later, plus the evaluation count and the gate histogram — the raw
    material backtestSymbol and walkForward both work from. */
function collectSignals(samples, config, opts) {
  const reasons = Object.create(null);
  const signals = [];
  let evaluations = 0;
  const slip = opts.slippageFrac || 0;
  const gate = opts.htf ? htfGate() : null;

  for (const segment of segmentSamples(samples, MAX_SAMPLE_GAP_MS)) {
    const history = [];
    for (let index = 0; index < segment.length; index += 1) {
      history.push({ t: segment[index].t, price: segment[index].price });
      if (history.length > MAX_HISTORY) history.shift();
      if (gate) gate.push(segment[index].t, segment[index].price);
      const view = decide(history, config);
      evaluations += 1;
      if (!view.signal) {
        reasons[view.reason] = (reasons[view.reason] || 0) + 1;
        continue;
      }
      const veto = (opts.vetoes === false ? null : offlineVeto(segment, index)) ||
        (gate ? gate.veto(view.signal) : null);
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
  return { evaluations, reasons, signals };
}

function backtestSymbol(samples, config, opts) {
  const { evaluations, reasons, signals } = collectSignals(samples, config, opts);
  const taken = simulateTrades(signals, opts.cooldownMs);
  return {
    evaluations,
    reasons,
    all: tally(signals),
    trades: withEv(tally(taken), opts.payoutPct),
    // Kept for --by-hour; stripped from --json output (see main).
    taken,
  };
}

/**
 * Walk-forward evaluation: the recording is cut into `folds` equal time
 * slices. For every slice after the first, the configuration is chosen on
 * the data BEFORE it (best Wilson lower bound of the simulated trades, with
 * at least SWEEP_MIN_DECIDED decided ones) and then traded on the slice
 * itself, unseen. Pooling those out-of-sample trades answers the question
 * a sweep cannot: does the winner keep winning on data it was not fitted
 * to? A fold with no configuration over the bar trades nothing — exactly
 * what the live bot does while nothing is proven.
 *
 * Signals are computed once per configuration over the whole recording
 * (the live history is continuous, so each slice starts warm, as it would
 * live); the folds only decide which signals count as training and which
 * as test.
 */
function walkForward(samples, configs, opts, folds) {
  if (!Array.isArray(samples) || samples.length < 2 ||
      !Number.isInteger(folds) || folds < 2 || !Array.isArray(configs) || configs.length === 0) {
    return null;
  }
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const edge = (k) => t0 + (t1 - t0) * k / folds;   // slice k spans [edge(k), edge(k+1))
  const perConfig = configs.map((config) => ({
    label: configLabel(config),
    signals: collectSignals(samples, config, opts).signals,
  }));
  const oos = [];
  const steps = [];
  for (let k = 1; k < folds; k += 1) {
    const trainEnd = edge(k);
    const testEnd = k === folds - 1 ? Infinity : edge(k + 1);
    let best = null;
    for (const entry of perConfig) {
      const train = tally(simulateTrades(
        entry.signals.filter((s) => s.t < trainEnd), opts.cooldownMs));
      if (train.wins + train.losses < SWEEP_MIN_DECIDED || train.lowerBound === null) continue;
      if (best === null || train.lowerBound > best.train.lowerBound) best = { entry, train };
    }
    if (best === null) {
      steps.push({ fold: k, from: trainEnd, chosen: null, train: null, test: null });
      continue;
    }
    const taken = simulateTrades(
      best.entry.signals.filter((s) => s.t >= trainEnd && s.t < testEnd), opts.cooldownMs);
    oos.push(...taken);
    steps.push({
      fold: k, from: trainEnd, chosen: best.entry.label,
      train: best.train, test: withEv(tally(taken), opts.payoutPct),
    });
  }
  return { folds, steps, oos: withEv(tally(oos), opts.payoutPct), oosTrades: oos };
}

/** Simulated trades bucketed by local hour of day. Markets have a daily
    rhythm (session opens, the OTC weekend feed, thin nights) and a record
    that only wins at certain hours is a schedule, not a strategy. */
function hourBuckets(trades) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const trade of trades) {
    if (!trade || !Number.isFinite(trade.t)) continue;
    buckets[new Date(trade.t).getHours()].push(trade);
  }
  return buckets
    .map((list, hour) => ({ hour, ...tally(list) }))
    .filter((bucket) => bucket.total > 0);
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
  const gate = opts.htf ? htfGate() : null;

  for (const segment of segmentSamples(samples, MAX_SAMPLE_GAP_MS)) {
    const history = [];
    let pendings = [];
    for (let index = 0; index < segment.length; index += 1) {
      const sample = { t: segment[index].t, price: segment[index].price };
      history.push(sample);
      if (history.length > MAX_HISTORY) history.shift();
      if (gate) gate.push(sample.t, sample.price);

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
      if (gate && gate.veto(dir)) continue;
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

function verdict(tallied, breakEven) {
  if (tallied.lowerBound === null) return 'too few trades';
  return tallied.lowerBound >= breakEven ? 'PROVEN above break-even' : 'not proven above break-even';
}

function printWalkForward(results, breakEven) {
  for (const r of results) {
    console.log('\n' + r.symbol + ' — walk-forward, ' + r.folds + ' folds (configuration picked on ' +
      'everything before each slice, then traded on the slice unseen)');
    for (const step of r.steps) {
      const at = new Date(step.from).toISOString().slice(0, 16).replace('T', ' ');
      if (step.chosen === null) {
        console.log('  fold ' + step.fold + ' from ' + at + ': nothing over the bar on the training data — no trades');
        continue;
      }
      console.log('  fold ' + step.fold + ' from ' + at + ': ' + step.chosen +
        ' (train LB ' + pct(step.train.lowerBound) + '/' + (step.train.wins + step.train.losses) +
        ') -> ' + step.test.wins + 'W-' + step.test.losses + 'L-' + step.test.draws + 'D' +
        ' hit ' + pct(step.test.hitRate) + ' LB ' + pct(step.test.lowerBound));
    }
    console.log('  OUT-OF-SAMPLE: ' + r.oos.total + ' trades — ' + r.oos.wins + 'W-' + r.oos.losses +
      'L-' + r.oos.draws + 'D  hit ' + pct(r.oos.hitRate) + '  lower bound ' + pct(r.oos.lowerBound) +
      ' | EV ' + (r.oos.ev >= 0 ? '+' : '') + r.oos.ev + ' stakes  [' + verdict(r.oos, breakEven) + ']');
  }
  console.log('\nOut-of-sample is the number to believe. A sweep that says "proven" while this ' +
    'says "not proven" found a configuration that fitted the past, not the market.');
}

function printHours(label, buckets, breakEven) {
  const rows = buckets.filter((b) => b.wins + b.losses >= 10);
  console.log('\n' + label + ' — by local hour of day (hours with 10+ decided trades)');
  if (rows.length === 0) {
    console.log('  no hour has 10 decided trades yet');
    return;
  }
  console.log('  ' + pad('hour', 7) + pad('trades', 8) + pad('hit', 8) + pad('LB', 8) + 'verdict');
  for (const b of rows) {
    console.log('  ' + pad(String(b.hour).padStart(2, '0') + ':00', 7) + pad(b.wins + b.losses, 8) +
      pad(pct(b.hitRate), 8) + pad(pct(b.lowerBound), 8) +
      (b.lowerBound >= breakEven ? 'above BE' : 'below BE'));
  }
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

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

function usage() {
  console.error('Usage: node tools/backtest.js [export.json ...] ' +
    '[--strategy momentum|zscore|trend|both] [--expiry sec] [--payout pct] ' +
    '[--cooldown sec] [--symbol SYM] [--auto] [--sweep] [--walk-forward [folds]] ' +
    '[--by-hour] [--htf] [--json]\n' +
    'With no file, every *.json in recordings/ is loaded.');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    files: [], strategy: 'both', expirySec: 60, payoutPct: 85,
    cooldownSec: 60, symbol: null, sweep: false, auto: false, json: false,
    walkForward: 0, byHour: false, htf: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sweep') opts.sweep = true;
    else if (arg === '--auto') opts.auto = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--by-hour') opts.byHour = true;
    else if (arg === '--htf') opts.htf = true;
    else if (arg === '--walk-forward') {
      // The fold count is optional: "--walk-forward 8" or just "--walk-forward".
      const next = argv[index + 1];
      if (next !== undefined && /^\d+$/.test(next)) { opts.walkForward = Number(next); index += 1; }
      else opts.walkForward = 5;
    }
    else if (arg === '--strategy') { opts.strategy = argv[index + 1]; index += 1; }
    else if (arg === '--expiry') { opts.expirySec = Number(argv[index + 1]); index += 1; }
    else if (arg === '--payout') { opts.payoutPct = Number(argv[index + 1]); index += 1; }
    else if (arg === '--cooldown') { opts.cooldownSec = Number(argv[index + 1]); index += 1; }
    else if (arg === '--symbol') { opts.symbol = argv[index + 1]; index += 1; }
    else if (!arg.startsWith('--')) opts.files.push(arg);
    else { console.error('Unknown option: ' + arg); process.exit(2); }
  }
  if (opts.files.length === 0) {
    // The pipeline's default: everything exported into recordings/.
    let names = [];
    try { names = fs.readdirSync(RECORDINGS_DIR).filter((name) => /\.json$/i.test(name)).sort(); }
    catch (_) { /* no recordings/ folder */ }
    if (names.length === 0) {
      console.error('No export given and nothing in recordings/. Turn on "Record ticks", ' +
        'export from the popup (or __nexaDebug.exportTicks()) and drop the file there.');
      usage();
    }
    opts.files = names.map((name) => path.join(RECORDINGS_DIR, name));
  }
  if (!['momentum', 'zscore', 'trend', 'both'].includes(opts.strategy) ||
      !Number.isFinite(opts.expirySec) || opts.expirySec <= 0 ||
      !Number.isFinite(opts.payoutPct) || opts.payoutPct <= 0 ||
      !Number.isFinite(opts.cooldownSec) || opts.cooldownSec < 0 ||
      !Number.isInteger(opts.walkForward) || (opts.walkForward !== 0 && opts.walkForward < 2)) {
    console.error('Invalid option value.');
    process.exit(2);
  }
  opts.expiryMs = opts.expirySec * 1000;
  opts.cooldownMs = opts.cooldownSec * 1000;
  return opts;
}

/**
 * One or more nexa-ticks-v1 exports merged into a single {ticks, trades}.
 * The recorder keeps a rolling window, so two exports a day apart share most
 * of their rows: ticks are de-duplicated on symbol + arrival time (a quotes
 * frame carries one row per symbol, so that pair is unique), trades on their
 * click time + symbol.
 */
function loadExports(files) {
  const ticks = [];
  const trades = [];
  const seenTicks = new Set();
  const seenTrades = new Set();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.format !== 'nexa-ticks-v1' || !Array.isArray(raw.ticks)) {
      console.error('Not a nexa-ticks-v1 export: ' + file);
      process.exit(2);
    }
    for (const row of raw.ticks) {
      if (!Array.isArray(row) || row.length < 4) continue;
      if (files.length > 1) {
        const key = row[0] + '|' + row[2];
        if (seenTicks.has(key)) continue;
        seenTicks.add(key);
      }
      ticks.push(row);
    }
    for (const trade of Array.isArray(raw.trades) ? raw.trades : []) {
      if (!trade || typeof trade !== 'object') continue;
      if (files.length > 1) {
        const key = trade.t + '|' + trade.sym;
        if (seenTrades.has(key)) continue;
        seenTrades.add(key);
      }
      trades.push(trade);
    }
  }
  return { ticks, trades, files: files.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = loadExports(opts.files);

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
    console.log('Loaded ' + raw.ticks.length.toLocaleString() + ' ticks from ' + raw.files +
      ' file' + (raw.files === 1 ? '' : 's') + ', ' +
      bySymbol.size + ' symbols | expiry ' + opts.expirySec + 's (horizon ' + horizon.label +
      ') | payout ' + opts.payoutPct + '% -> break-even hit-rate ' +
      (breakEven * 100).toFixed(1) + '%' +
      (opts.slippageFrac > 0
        ? ' | entry handicap ' + (opts.slippageFrac * 100).toFixed(4) + '% (median real slippage)'
        : ' | no slippage handicap (fewer than 5 real fills in the export)') +
      (opts.htf ? ' | HTF filter on (' + HTF.CANDLE_SEC + 's candles, EMA ' + HTF.EMA_FAST + '/' +
        HTF.EMA_SLOW + ', RSI ' + HTF.RSI_BLOCK + ')' : ''));
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

  if (opts.walkForward > 0) {
    // The candidate set is the sweep grid — the choice a person would make
    // from a sweep table, made automatically and honestly per fold.
    const grid = sweepConfigs(opts.strategy, opts.expirySec);
    const results = symbols.map((sym) => ({
      symbol: sym, ...walkForward(bySymbol.get(sym), grid, opts, opts.walkForward),
    }));
    if (opts.json) {
      const slim = results.map(({ oosTrades, ...rest }) => (opts.byHour
        ? { ...rest, byHour: hourBuckets(oosTrades) } : rest));
      console.log(JSON.stringify({ breakEven, walkForward: slim }, null, 2));
      return;
    }
    printWalkForward(results, breakEven);
    if (opts.byHour) {
      for (const r of results) {
        printHours(r.symbol + ' (out-of-sample)', hourBuckets(r.oosTrades), breakEven);
      }
    }
    return;
  }

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
    const slim = results.map(({ taken, ...rest }) => (opts.byHour
      ? { ...rest, byHour: hourBuckets(taken) } : rest));
    console.log(JSON.stringify({ breakEven, results: slim }, null, 2));
    return;
  }
  if (opts.sweep) printSweep(results, breakEven);
  else printReport(results, breakEven);
  if (opts.byHour && !opts.sweep) {
    for (const r of results) printHours(r.symbol + ' — ' + r.config, hourBuckets(r.taken), breakEven);
  }

  if (Array.isArray(raw.trades) && raw.trades.length > 0) {
    printRealTrades(raw.trades);
  }
}

module.exports = {
  groupBySymbol, segmentSamples, labelAt, offlineVeto, collectSignals, backtestSymbol,
  backtestAuto, walkForward, hourBuckets, loadExports, simulateTrades, sweepConfigs,
  baseConfigsFor, medianSlippageFrac, htfGate, BASE_CONFIGS, SWEEP_MIN_DECIDED, HTF,
};

if (require.main === module) main();
