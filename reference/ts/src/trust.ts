// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The TrustState model and the pure reducers update() and replay().
 *
 * TrustState is the current standing of one (Actor, TaskType) scope. It moves
 * ONLY through sealed Outcomes and Checkpoint decisions folded by the reference
 * weighting (SPEC section 4). Both reducers here are pure (I7): no I/O, no
 * hidden clock — any time input is passed explicitly — so replay() from stored
 * Warrants + Policy reproduces the exact state (I2).
 */

import type { Tier } from "./policy.ts";
import { defaultPolicy, tierIndex, type Policy } from "./policy.ts";
import type { Warrant } from "./records.ts";
import {
  clamp01,
  decayScore,
  foldSignal,
  signalOf,
  tierFor,
} from "./weighting.ts";

export interface TrustState {
  actor: string;
  task_type: string;
  tier: Tier;
  score: number;
  confidence: number;
  sample_count: number;
  window_ref?: string | null;
  updated?: string;
}

/** Cold start: conservative neutral prior at T0 (SPEC section 4). */
export function coldStart(actor: string, task_type: string): TrustState {
  return {
    actor,
    task_type,
    tier: "T0",
    score: 0,
    confidence: 0,
    sample_count: 0,
    window_ref: null,
  };
}

/** A tier transition, emitted so decay/demotion never crosses silently. */
export interface Transition {
  from: Tier;
  to: Tier;
  reason: string;
}

export interface UpdateResult {
  state: TrustState;
  transition?: Transition;
}

/**
 * PURE reducer. Fold one sealed Warrant into a TrustState, producing the next
 * state (and any tier transition). Optionally apply idle/drift decay first,
 * given the elapsed idle time and drift since the last update.
 *
 * Scope isolation (I1): the caller is responsible for only feeding this a
 * Warrant whose intent scope matches `prev.(actor, task_type)`. update() asserts
 * it to fail loud rather than silently blend scopes.
 */
export function update(
  prev: TrustState,
  warrant: Warrant,
  policy: Policy = defaultPolicy(),
  opts: { idle_ms?: number; drift?: number; now?: string } = {},
): UpdateResult {
  // I1: refuse to fold cross-scope evidence.
  if (
    warrant.intent.actor !== prev.actor ||
    warrant.intent.task_type !== prev.task_type
  ) {
    throw new Error(
      `scope violation (I1): warrant (${warrant.intent.actor}, ${warrant.intent.task_type}) ` +
        `does not match state (${prev.actor}, ${prev.task_type})`,
    );
  }

  const fromTier = prev.tier;

  // 1. Decay toward the current tier floor for the idle gap + drift.
  const idle_ms = opts.idle_ms ?? 0;
  const drift = opts.drift ?? 0;
  let score = prev.score;
  if (idle_ms > 0 || drift > 0) {
    score = decayScore(score, prev.tier, idle_ms, drift, policy);
  }

  // 2. Fold the warrant's signal.
  const s = signalOf(warrant);
  let confidence = prev.confidence;
  let sample_count = prev.sample_count;

  if (s.counts) {
    const folded = foldSignal(score, confidence, sample_count, s, policy);
    score = folded.score;
    confidence = folded.confidence;
    sample_count += 1;
  }

  // 3. Derive the tier from (score, sample_count) under the confidence cap.
  let toTier = tierFor(score, sample_count, policy);

  // 4. Forced demotion: a REVERTED outcome / VALIDATE-FAIL / human REJECT|MODIFY
  //    drops at least one tier regardless of the derived tier (SPEC section 4).
  if (s.force_demote) {
    const forced = Math.max(0, tierIndex(prev.tier) - 1);
    if (tierIndex(toTier) > forced) {
      toTier = (["T0", "T1", "T2", "T3", "T4"] as const)[forced];
    }
  }

  const next: TrustState = {
    actor: prev.actor,
    task_type: prev.task_type,
    tier: toTier,
    score: clamp01(score),
    confidence: clamp01(confidence),
    sample_count,
    window_ref: warrant.outcome?.id ?? warrant.intent.id,
    updated: opts.now,
  };

  let transition: Transition | undefined;
  if (toTier !== fromTier) {
    transition = {
      from: fromTier,
      to: toTier,
      reason: s.force_demote
        ? "forced demotion on negative closed evidence"
        : idle_ms > 0 && !s.counts
          ? "decay/drift crossed a tier boundary"
          : "evidence-driven tier change",
    };
  }

  return { state: next, transition };
}

/** A Warrant paired with the idle/drift context needed to re-fold it. */
export interface ReplayEntry {
  warrant: Warrant;
  idle_ms?: number;
  drift?: number;
  now?: string;
}

/**
 * PURE. Reconstruct a TrustState from an ordered list of Warrants + Policy.
 * Folds each in sequence starting from cold start. By I2 this MUST equal the
 * state that was produced incrementally by update() over the same inputs.
 *
 * Accepts either bare Warrants (no decay context) or ReplayEntry wrappers.
 */
export function replay(
  actor: string,
  task_type: string,
  warrants: (Warrant | ReplayEntry)[],
  policy: Policy = defaultPolicy(),
): TrustState {
  let state = coldStart(actor, task_type);
  for (const entry of warrants) {
    const e: ReplayEntry = "warrant" in entry ? entry : { warrant: entry };
    // Only fold warrants in this scope (I1); skip others silently — replay of a
    // single scope must ignore other scopes' evidence entirely.
    if (
      e.warrant.intent.actor !== actor ||
      e.warrant.intent.task_type !== task_type
    ) {
      continue;
    }
    state = update(state, e.warrant, policy, {
      idle_ms: e.idle_ms,
      drift: e.drift,
      now: e.now,
    }).state;
  }
  return state;
}
