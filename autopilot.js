/* Auto-mode primitives shared by the isolated content script and tests.

   The auto system runs a pool of strategy variants VIRTUALLY on the live
   feed: each virtual signal is settled one expiry later against the real
   price, building a rolling win/loss record per variant. Real clicks go
   only to a variant whose measured record clears the break-even hit-rate
   with margin. These are the pure pieces — no DOM, no storage, no timers —
   so they can be unit-tested; content.js owns the orchestration. */
(() => {
  'use strict';

  /**
   * Kaufman efficiency ratio over the last `span` returns: |net move| /
   * path length. 1 = perfectly straight trend, 0 = pure chop.
   * @param {Array<{price: number}>} history
   * @param {number} span
   * @returns {number|null} null while there is not enough (valid) history
   */
  function efficiencyRatio(history, span) {
    if (!Array.isArray(history) || !Number.isInteger(span) || span < 1 ||
        history.length < span + 1) {
      return null;
    }
    let net = 0;
    let path = 0;
    for (let index = history.length - span; index < history.length; index += 1) {
      const prev = history[index - 1];
      const curr = history[index];
      if (!prev || !curr || !(prev.price > 0) || !(curr.price > 0)) return null;
      const ret = Math.log(curr.price / prev.price);
      net += ret;
      path += Math.abs(ret);
    }
    return path === 0 ? 0 : Math.abs(net) / path;
  }

  /**
   * Value at the given fraction of the sorted sample (0..1). Used for the
   * adaptive z-threshold (p90 of recent |z|).
   * @returns {number|null} null for an empty sample
   */
  function percentile(values, fraction) {
    if (!Array.isArray(values) || values.length === 0 ||
        !Number.isFinite(fraction)) {
      return null;
    }
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1,
      Math.max(0, Math.floor(sorted.length * fraction)));
    return sorted[index];
  }

  /**
   * Longest suffix of samples with no receive gap wider than gapMs, capped
   * at `cap` entries. Used to seed a fresh history from the scanner's
   * per-symbol buffers without ever spanning an outage.
   * @param {Array<{t: number}>} samples - ascending by t
   * @returns {Array} a new array; empty when input is empty/invalid
   */
  function gapFreeSuffix(samples, gapMs, cap) {
    if (!Array.isArray(samples) || samples.length === 0 ||
        !Number.isFinite(gapMs) || !Number.isFinite(cap) || cap < 1) {
      return [];
    }
    let start = samples.length - 1;
    while (start > 0 && samples[start].t - samples[start - 1].t <= gapMs) {
      start -= 1;
    }
    const suffix = samples.slice(start);
    return suffix.length > cap ? suffix.slice(suffix.length - cap) : suffix;
  }

  /**
   * Settle every pending virtual trade that has reached expiry. The first
   * sample at/after expiresAt settles it — unless that sample is more than
   * toleranceMs late (a data hole at expiry), in which case the pending is
   * silently dropped: an unknowable outcome must never count either way.
   * @param {Array<{variantId: string, dir: string, price: number, expiresAt: number}>} pendings
   * @param {{t: number, price: number}} sample
   * @param {number} toleranceMs
   * @returns {{keep: Array, outcomes: Array<{variantId: string, outcome: 'w'|'l'|'d'}>}}
   */
  function settlePendings(pendings, sample, toleranceMs) {
    const keep = [];
    const outcomes = [];
    for (const pending of pendings) {
      if (sample.t < pending.expiresAt) {
        keep.push(pending);
        continue;
      }
      if (sample.t - pending.expiresAt > toleranceMs) continue;
      const diff = sample.price - pending.price;
      const outcome = diff === 0 ? 'd'
        : (pending.dir === 'UP') === (diff > 0) ? 'w' : 'l';
      outcomes.push({ variantId: pending.variantId, outcome });
    }
    return { keep, outcomes };
  }

  /**
   * Append one outcome character ('w'/'l'/'d') to a rolling record string,
   * trimming the oldest beyond `cap`.
   */
  function recordOutcome(recent, outcome, cap) {
    const next = (typeof recent === 'string' ? recent : '') + outcome;
    return next.length > cap ? next.slice(next.length - cap) : next;
  }

  /**
   * Win/loss stats of a rolling record string. hitRate counts decided
   * outcomes only — draws return the stake and prove nothing.
   */
  function statsOf(recent) {
    const source = typeof recent === 'string' ? recent : '';
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const ch of source) {
      if (ch === 'w') wins += 1;
      else if (ch === 'l') losses += 1;
      else if (ch === 'd') draws += 1;
    }
    const n = wins + losses;
    return { wins, losses, draws, n, hitRate: n === 0 ? null : wins / n };
  }

  /**
   * A payout of p% pays +p on a win and -100 on a loss, so the hit-rate
   * that merely breaks even is 100/(100+p): 54.1% at 85%, 58.8% at 70%.
   * @returns {number|null} fraction in (0,1), or null for invalid payout
   */
  function breakEvenRate(payoutPct) {
    if (!Number.isFinite(payoutPct) || payoutPct <= 0) return null;
    return 100 / (100 + payoutPct);
  }

  /**
   * Wilson score interval, lower bound: the hit-rate we can be confident the
   * variant REALLY has, given `wins` of `n` decided outcomes. Unlike the raw
   * ratio it shrinks toward 0.5 for small n, so 18/30 (60%) reads as ~0.45 at
   * z=2 while 180/300 (60%) reads as ~0.54.
   * @param {number} wins
   * @param {number} n decided outcomes (wins + losses)
   * @param {number} z one-sided confidence (1.645 ≈ 95%, 2.0 ≈ 97.7%)
   * @returns {number|null} null for invalid input or n === 0
   */
  function wilsonLowerBound(wins, n, z) {
    if (!Number.isInteger(wins) || !Number.isInteger(n) || n <= 0 ||
        wins < 0 || wins > n || !Number.isFinite(z) || z < 0) {
      return null;
    }
    const p = wins / n;
    const z2 = z * z;
    const centre = p + z2 / (2 * n);
    const spread = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return Math.max(0, (centre - spread) / (1 + z2 / n));
  }

  /**
   * The best variant currently allowed to place real trades.
   *
   * The bar is the Wilson LOWER bound, not the observed hit-rate: with eight
   * variants re-tested on every outcome, the raw ratio of a coin-flip pool
   * cleared "break-even + 4 points over 30 samples" in 100% of simulated
   * runs and kept real trades armed half the time. Requiring the lower
   * confidence bound to clear break-even + margin brings that to ~0.2% of
   * the time at z=2 / 100 samples, while a genuine 60% model still arms
   * ~94% of the time once it has 100+ outcomes. Qualifiers are ranked by
   * that bound too, which favours the better-evidenced record over the
   * luckier one.
   *
   * Fails closed: any missing or non-finite option disqualifies everything.
   * @param {string[]} ids
   * @param {(id: string) => {wins: number, n: number, hitRate: number|null}} statsById
   * @param {{breakEven: number, minSamples: number, margin: number, confidenceZ?: number}} opts
   * @returns {{id: string, stats: Object, lowerBound: number}|null}
   */
  function bestQualified(ids, statsById, opts) {
    if (!Array.isArray(ids) || !opts || !Number.isFinite(opts.breakEven) ||
        !Number.isFinite(opts.minSamples) || !Number.isFinite(opts.margin)) {
      return null;
    }
    const z = opts.confidenceZ === undefined ? 2.0 : opts.confidenceZ;
    if (!Number.isFinite(z) || z < 0) return null;
    const bar = opts.breakEven + opts.margin;
    let best = null;
    for (const id of ids) {
      const stats = statsById(id);
      if (!stats || stats.hitRate === null || stats.n < opts.minSamples) continue;
      const lowerBound = wilsonLowerBound(stats.wins, stats.n, z);
      if (lowerBound === null || lowerBound < bar) continue;
      if (best === null || lowerBound > best.lowerBound) {
        best = { id, stats, lowerBound };
      }
    }
    return best;
  }

  /**
   * Fractional Kelly stake for a binary option.
   *
   * A contract paying b (payout fraction, 0.85 at 85%) on a win and -1 on a
   * loss, hit at rate p, has the growth-optimal stake f* = p - (1 - p) / b of
   * the balance. That is optimal only if p is exactly right — and p is an
   * estimate, so `fraction` (0.25 = quarter Kelly) scales it down, `maxPct`
   * caps it, and the result never drops below `minStake` (the platform
   * minimum). A hit-rate that is unknown or below break-even sizes to the
   * minimum rather than zero: whether to trade at all was decided upstream
   * by the strategy gates; sizing is not a second vote, it only decides how
   * much evidence-backed money rides on an entry.
   *
   * Pass the LOWER confidence bound as the hit-rate, not the observed
   * ratio — a lucky 60%/20 must not be sized like a proven 60%/300.
   * @param {{balance: number, payoutPct: number, hitRate: number|null,
   *          fraction: number, maxPct: number, minStake: number}} args
   * @returns {number|null} dollars (2 decimals), or null when the balance or
   *   payout is unknown — the caller then leaves the platform's amount alone
   */
  function kellyStake(args) {
    if (!args || typeof args !== 'object') return null;
    const { balance, payoutPct, hitRate, fraction, maxPct, minStake } = args;
    if (!Number.isFinite(balance) || balance <= 0 ||
        !Number.isFinite(payoutPct) || payoutPct <= 0 ||
        !Number.isFinite(fraction) || fraction <= 0 ||
        !Number.isFinite(maxPct) || maxPct <= 0 ||
        !Number.isFinite(minStake) || minStake <= 0) {
      return null;
    }
    const floor = Math.round(minStake * 100) / 100;
    if (!Number.isFinite(hitRate) || hitRate <= 0 || hitRate >= 1) return floor;
    const b = payoutPct / 100;
    const full = hitRate - (1 - hitRate) / b;
    if (full <= 0) return floor;
    const f = Math.min(full * fraction, maxPct / 100);
    return Math.max(floor, Math.round(balance * f * 100) / 100);
  }

  /**
   * The amount at or below `amount` that a person would type into the stake
   * field: 1 2 3 5 under ten, then 10 15 20 25 30 40 50 75 100 150 … (the
   * same mantissas every decade). Never below `minStake`, the platform
   * minimum, which may itself be any figure. A sizer that asks for $2.37
   * one trade and $2.64 the next is a machine; $2 is a person.
   */
  function humanStake(amount, minStake) {
    const floor = Number.isFinite(minStake) && minStake > 0 ? Math.round(minStake * 100) / 100 : 0.01;
    if (!Number.isFinite(amount) || amount <= floor) return floor;
    const eps = 1e-9;
    if (amount < 10) {
      const pick = [5, 3, 2, 1].find((v) => v <= amount + eps);
      return Math.max(floor, pick === undefined ? floor : pick);
    }
    const decade = Math.pow(10, Math.floor(Math.log10(amount)));
    const mantissa = [7.5, 5, 4, 3, 2.5, 2, 1.5, 1].find((v) => v <= amount / decade + eps) || 1;
    return Math.max(floor, Math.round(mantissa * decade * 100) / 100);
  }

  const api = Object.freeze({
    efficiencyRatio, percentile, gapFreeSuffix, settlePendings, recordOutcome,
    statsOf, breakEvenRate, wilsonLowerBound, bestQualified, kellyStake, humanStake,
  });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && !('NexaAutopilot' in globalThis)) {
    // Guarded: redefining a non-configurable property on a second injection
    // into the same context would throw and kill the whole script.
    Object.defineProperty(globalThis, 'NexaAutopilot', {
      value: api,
      configurable: false,
      writable: false,
    });
  }
})();
