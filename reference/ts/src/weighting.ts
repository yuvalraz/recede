// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The reference weighting function.
 *
 * SPEC section 9 marks the weighting (asymmetry, decay, near-miss ratchet) as a
 * *reference*, not normative — an implementation MAY substitute its own so long
 * as invariants I1-I7 hold. This module is that reference. It is a set of pure
 * helpers consumed by the update() reducer; it has no I/O and no clock of its
 * own (time is always passed in), so it stays deterministic (I7).
 */

import { TIERS, tierIndex, type Policy, type Tier } from "./policy.ts";
import type { Warrant, CheckRecord } from "./records.ts";

/** Clamp to [0,1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The signed, magnitude-weighted signal a sealed Warrant contributes.
 *
 * Positive path (SUCCESS with clean checks, or a human APPROVE matching the
 * proposal): a bounded positive weighted by mean check confidence.
 * Negative path (FAILURE / REVERTED, a VALIDATE FAIL, or a human REJECT/MODIFY
 * contradicting the proposal): a negative, and near_miss for the ratchet.
 *
 * A Warrant with no closed Outcome and no decisive Checkpoint contributes
 * nothing (trust theater guard, SPEC section 8).
 */
export interface Signal {
  /** Direction/magnitude in roughly [-1, +1] before asymmetric scaling. */
  raw: number;
  /** Mean confidence of the checks; drives confidence accrual + the I5 cap. */
  confidence: number;
  /** True when an autonomous action was later overturned (near-miss ratchet). */
  near_miss: boolean;
  /** A REVERTED outcome or VALIDATE-FAIL may force a demotion regardless. */
  force_demote: boolean;
  /** Whether this Warrant carries closed evidence at all. */
  counts: boolean;
}

function meanConfidence(checks: CheckRecord[]): number {
  if (checks.length === 0) return 0;
  const sum = checks.reduce((a, c) => a + c.confidence, 0);
  return sum / checks.length;
}

/** Extract the trust signal from one Warrant. Pure. */
export function signalOf(w: Warrant): Signal {
  const checks = w.checks;
  const conf = meanConfidence(checks);
  const validateFail = checks.some(
    (c) => c.check_kind === "VALIDATE" && c.verdict === "FAIL",
  );
  const anyFail = checks.some((c) => c.verdict === "FAIL");
  const anyInconclusive = checks.some((c) => c.verdict === "INCONCLUSIVE");

  // A decisive human decision is itself closed evidence.
  const lastCp = w.checkpoints[w.checkpoints.length - 1];

  // Whether the action ran autonomously (no gating checkpoint fired for it).
  const ranAutonomously = w.checkpoints.length === 0;

  const out = w.outcome;

  // No closed evidence at all -> moves nothing.
  if (!out && !lastCp) {
    return { raw: 0, confidence: conf, near_miss: false, force_demote: false, counts: false };
  }

  // UNRESOLVED deferred outcomes are held out until re-sealed (SPEC section 6).
  if (out && out.result === "UNRESOLVED") {
    return { raw: 0, confidence: conf, near_miss: false, force_demote: false, counts: false };
  }

  // --- Human decision contribution ---
  // MODIFY: agent proposed the wrong thing -> scored as a VALIDATE-FAIL on the
  // original proposal even if the final outcome succeeded (SPEC section 4).
  // REJECT: contradicts the proposal -> negative.
  // APPROVE matching the proposal is the strongest positive signal.
  let cpRaw = 0;
  let cpForceDemote = false;
  if (lastCp) {
    switch (lastCp.decision) {
      case "APPROVE":
        cpRaw = +1.0;
        break;
      case "MODIFY":
        cpRaw = -1.0;
        cpForceDemote = true;
        break;
      case "REJECT":
        cpRaw = -1.0;
        cpForceDemote = true;
        break;
      case "ESCALATE":
        cpRaw = 0; // deferred to a higher authority; no signal yet.
        break;
    }
  }

  // --- Outcome contribution ---
  let outRaw = 0;
  let outForceDemote = false;
  let nearMiss = false;
  if (out) {
    switch (out.result) {
      case "SUCCESS":
        // Clean success only counts positively if checks did not contradict it.
        outRaw = validateFail || anyFail ? -0.5 : anyInconclusive ? +0.3 : +1.0;
        break;
      case "FAILURE":
        outRaw = -1.0;
        outForceDemote = validateFail;
        break;
      case "REVERTED":
        outRaw = -1.0;
        outForceDemote = true;
        // A reverted action that had run autonomously trips the ratchet.
        nearMiss = ranAutonomously;
        break;
    }
  } else if (validateFail || anyFail) {
    // Checkpoint-only warrant but the checks already contradict the proposal.
    outRaw = -0.5;
  }

  // Combine: a contradicting human decision dominates a nominal success.
  const raw =
    cpRaw !== 0 && Math.sign(cpRaw) !== Math.sign(outRaw)
      ? cpRaw // human overrides the machine's self-report
      : clampSigned(cpRaw + outRaw);

  return {
    raw,
    confidence: conf,
    near_miss: nearMiss,
    force_demote: cpForceDemote || outForceDemote,
    counts: true,
  };
}

function clampSigned(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/**
 * Fold one signal into a running (score, confidence) pair — the asymmetric
 * accrual. Positives use diminishing returns toward 1; negatives are scaled by
 * negative_multiplier so trust is lost faster than earned (I4). The near-miss
 * ratchet applies an extra one-shot debit.
 */
export function foldSignal(
  score: number,
  confidence: number,
  sample_count: number,
  s: Signal,
  policy: Policy,
): { score: number; confidence: number } {
  if (!s.counts) return { score, confidence };

  const w = policy.weights;
  let nextScore = score;

  if (s.raw >= 0) {
    // Diminishing returns: closer to 1 => smaller step. Weight by confidence.
    const step = w.positive_gain * s.raw * s.confidence * (1 - score);
    nextScore = score + step;
  } else {
    // Asymmetric: negatives move faster. Not damped by (1 - score).
    const step = w.positive_gain * s.raw * w.negative_multiplier;
    nextScore = score + step; // s.raw is negative -> subtracts
  }

  if (s.near_miss) {
    nextScore -= w.near_miss_debit;
  }

  // Confidence accrues with diminishing returns as samples grow, and is nudged
  // down by low-confidence or negative evidence.
  const confStep = w.confidence_gain * (1 - confidence);
  const nextConf =
    s.raw >= 0 && s.confidence > 0
      ? confidence + confStep * s.confidence
      : confidence - confStep * 0.5;

  return { score: clamp01(nextScore), confidence: clamp01(nextConf) };
}

/**
 * Time + drift decay. Score relaxes toward the current tier's score floor over
 * an idle window (exponential, half-life from policy), and is discounted when
 * the input distribution has drifted from the window that earned the trust.
 * `drift` is a caller-supplied normalized measure in [0,1] (0 = no drift).
 */
export function decayScore(
  score: number,
  tier: Tier,
  idle_ms: number,
  drift: number,
  policy: Policy,
): number {
  const floor = policy.weights.score_tier_floor[tierIndex(tier)] ?? 0;
  const halfLife = policy.decay.idle_half_life_ms;
  const factor = halfLife > 0 ? Math.pow(0.5, Math.max(0, idle_ms) / halfLife) : 1;
  // Relax toward floor by (1 - factor).
  let decayed = floor + (score - floor) * factor;
  // Drift discount: pull further toward floor proportional to drift.
  const d = clamp01(drift) * policy.decay.drift_discount;
  decayed = decayed - (decayed - floor) * d;
  return clamp01(decayed);
}

/**
 * The tier for a (score, confidence, sample_count) triple. This is where the
 * confidence cap (I5) lives: the resulting tier is the LOWER of the
 * score-implied tier and the confidence/sample-implied tier. One lucky run
 * (high score, tiny sample) cannot promote past T1.
 */
export function tierFor(
  score: number,
  sample_count: number,
  policy: Policy,
): Tier {
  const w = policy.weights;

  let scoreTier = 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (score >= w.score_tier_floor[i]) {
      scoreTier = i;
      break;
    }
  }

  let confTier = 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (sample_count >= w.confidence_samples_per_tier[i]) {
      confTier = i;
      break;
    }
  }

  // I5: the confidence-implied tier caps the score-implied tier.
  return TIERS[Math.min(scoreTier, confTier)];
}
