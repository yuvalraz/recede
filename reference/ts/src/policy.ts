// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Tiers, the Policy shape, the reference risk taxonomy, and the default Policy.
 *
 * The Policy is a versioned, declarative `(RiskClass x Tier) -> gate` matrix
 * plus the weighting/decay parameters and the never-recede ceiling. Its digest
 * pins every gate decision to the exact rules that produced it (I6).
 */

import type { RiskClass } from "./records.ts";
import { digest } from "./hash.ts";

/** Ordered trust tiers. Index gives the ordering the Gate relies on. */
export const TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
export type Tier = (typeof TIERS)[number];

export function tierIndex(t: Tier): number {
  return TIERS.indexOf(t);
}

/** A gate cell: autonomous, or require a checkpoint at a named altitude. */
export type GateCell =
  | { kind: "AUTONOMOUS" }
  | { kind: "REQUIRE_CHECKPOINT"; altitude: string };

/** Reference risk taxonomy, ordered by stakes ascending. */
export const RISK_ORDER: RiskClass[] = [
  "read.only",
  "reversible.low",
  "financial.reversible",
  "irreversible.critical",
];

export interface WeightParams {
  /** How much a fully-confident positive outcome raises raw score. */
  positive_gain: number;
  /** Penalty multiplier: negatives move score this many times faster. */
  negative_multiplier: number;
  /** Extra one-shot debit when an autonomous action is later overturned. */
  near_miss_debit: number;
  /** Confidence gained per confirmed sample (diminishing via sample_count). */
  confidence_gain: number;
  /** Minimum samples required per tier index to lift the confidence cap. */
  confidence_samples_per_tier: number[];
  /** Score thresholds (lower bound) to be eligible for each tier index. */
  score_tier_floor: number[];
}

export interface DecayParams {
  /** Idle half-life in milliseconds; score decays toward its tier floor. */
  idle_half_life_ms: number;
  /** Drift discount applied per unit of normalized input-distribution drift. */
  drift_discount: number;
}

export interface Policy {
  id: string;
  version: string;
  /** matrix[risk][tier] -> gate cell. */
  matrix: Record<RiskClass, Record<Tier, GateCell>>;
  weights: WeightParams;
  decay: DecayParams;
  /** RiskClasses that MUST keep a checkpoint at every tier (I3). */
  never_recede: RiskClass[];
  /**
   * Optional weighting-strategy selector (SPEC §9). Undefined ⇒ the byte-frozen
   * reference v0.1 weighting. A registered tag (e.g. `recede/ref-weighting-v0.2`)
   * selects an alternate pooled profile; an UNREGISTERED tag fails loud at fold
   * time. Digest-safe: `undefined` is dropped by canonicalize (hash.ts:51-53),
   * so the 0.1.0 default digest is unchanged; any adopter that SETS it gets a
   * correctly-pinned, different digest (I6).
   */
  weighting?: string;
  /**
   * Optional per-(evidence-class → tier) weight table consumed only by pooled
   * weighting profiles. Undefined ⇒ dropped by canonicalize (digest-safe).
   */
  evidence_weights?: Record<string, Partial<Record<string, number>>>;
}

/**
 * Policy digest (I6): a content hash over the policy's decision-affecting
 * fields. Excludes nothing meaningful — id/version/matrix/weights/decay/floor.
 * Two policies with identical rules share a digest; any rule change moves it.
 */
export function policyDigest(policy: Policy): string {
  return digest({
    id: policy.id,
    version: policy.version,
    matrix: policy.matrix,
    weights: policy.weights,
    decay: policy.decay,
    never_recede: policy.never_recede,
    // Digest-safe: both are `undefined` on the 0.1.0 default and dropped by
    // canonicalize, so this addition is byte-identical for the default policy.
    weighting: policy.weighting,
    evidence_weights: policy.evidence_weights,
  });
}

/**
 * The reference default Policy. Encodes the tier ladder from SPEC section 4:
 *  - T0: everything gated.
 *  - T1: gated except read.only.
 *  - T2: low-risk autonomous; high/critical gated.
 *  - T3: autonomous up to high (financial.reversible); critical gated.
 *  - T4: autonomous incl. high risk; irreversible.critical still gated (I3).
 *
 * `never_recede` = [irreversible.critical], so that cell is a checkpoint at
 * every tier no matter what the matrix says — the Gate enforces this floor.
 */
export function defaultPolicy(): Policy {
  const cp = (altitude: string): GateCell => ({
    kind: "REQUIRE_CHECKPOINT",
    altitude,
  });
  const auto: GateCell = { kind: "AUTONOMOUS" };

  const row = (cells: GateCell[]): Record<Tier, GateCell> => ({
    T0: cells[0],
    T1: cells[1],
    T2: cells[2],
    T3: cells[3],
    T4: cells[4],
  });

  return {
    id: "recede.reference",
    version: "0.1.0",
    matrix: {
      // risk            T0        T1        T2        T3        T4
      "read.only":          row([cp("full"), auto,       auto,       auto,       auto]),
      "reversible.low":     row([cp("full"), cp("brief"),auto,       auto,       auto]),
      "financial.reversible": row([cp("full"), cp("full"),cp("brief"),auto,      auto]),
      "irreversible.critical": row([cp("full"), cp("full"),cp("full"),cp("full"),cp("full")]),
    },
    weights: {
      positive_gain: 0.12,
      negative_multiplier: 3.0,
      near_miss_debit: 0.25,
      confidence_gain: 0.14,
      // samples needed to be *confidence-eligible* for tier index 0..4.
      confidence_samples_per_tier: [0, 3, 10, 25, 60],
      // raw score needed to be *score-eligible* for tier index 0..4.
      score_tier_floor: [0.0, 0.35, 0.55, 0.75, 0.9],
    },
    decay: {
      idle_half_life_ms: 1000 * 60 * 60 * 24 * 30, // 30 days
      drift_discount: 0.5,
    },
    never_recede: ["irreversible.critical"],
  };
}

/**
 * Look up a matrix cell, tolerating an unknown RiskClass by treating it as the
 * most conservative known class (always require a checkpoint). Never-recede is
 * enforced separately in gate() so an org-defined risk can opt into it.
 */
export function matrixCell(policy: Policy, risk: RiskClass, tier: Tier): GateCell {
  const rrow = policy.matrix[risk];
  if (!rrow) return { kind: "REQUIRE_CHECKPOINT", altitude: "full" };
  return rrow[tier];
}
