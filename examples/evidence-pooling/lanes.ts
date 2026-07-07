// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * evidence-pooling — shared lane logic for the flat-mean-vs-pooled demo.
 *
 * The claim this file makes runnable, on today's kernel, offline and keyless:
 * take a strong VERIFY and ADD a weak VALIDATE. Under v0.1 (`defaultPolicy()`,
 * flat-mean confidence) the extra weak-but-passing check DRAGS trust below the
 * VERIFY-alone lane. Under v0.2 (`referencePolicyV02(...)`, class-deduped
 * noisy-OR pool) the same weak evidence can only ADD.
 *
 * The honest mechanism (see EVIDENCE.md):
 *   - v0.1 `signalOf` collapses a Warrant's checks to a flat MEAN confidence
 *     (weighting.ts). The weak VALIDATE's stored confidence (0.1) averages the
 *     strong VERIFY's 1.0 down to 0.55, and that mean scales foldSignal's
 *     positive step — so adding the weak check LOWERS every clean-SUCCESS step.
 *   - v0.2 `signalOfV02` overrides ONLY the confidence with a noisy-OR pool over
 *     per-check DECLARED weights (weighting-v0.2.ts): pool = 1 - Π(1 - w_i) over
 *     PASS checks, deduped by evidence class. pool >= the strongest single class
 *     weight and is monotone in added PASS checks, so adding the weak class can
 *     only raise the pool.
 *
 * runLane(policy, checks) is the SINGLE shared code path: it folds a FIXED
 * sequence of clean SUCCESS warrants under the given policy and reads the stored
 * trust and its replay. Everything is held constant across every call EXCEPT the
 * (policy, checks) pair: same actor, task_type, risk, injected clock epoch/tick,
 * ticket ids, idle_ms=0 (no decay). Any divergence is therefore attributable
 * ONLY to the policy and the check set. The same-lane-twice control in demo.ts
 * is non-vacuous because of that determinism.
 *
 * Weights are DECLARED, auditable POLICY, not a prediction that one check catches
 * more bugs (EVIDENCE.md, red-team rules 1 + 4). Zero runtime dependencies; runs
 * on Node built-in type stripping (>= 22.6, tested on 26). It imports the
 * canonical protocol from ../../reference/ts and reimplements no protocol logic.
 */

import {
  Recede,
  MemoryLedger,
  fixedCheckpoint,
  evRef,
  type CheckSpec,
  type CheckResult,
  type Policy,
  type RunResult,
  type Tier,
  type Warrant,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// The domain. A change is just the clean-pipeline signal it would produce.
// ---------------------------------------------------------------------------

export interface CleanChange {
  ticket: string;
  ciGreen: boolean;
}

/** Dogfood convention: model@harness. Same actor on every lane. */
export const ACTOR = "opus-4.8@claude-code";
/** Same task-type shape on every lane. */
export const TASK = "code.fix";
/** reversible.low is AUTONOMOUS at T2 in the default policy (policy.ts). */
export const RISK = "reversible.low";

/**
 * How many identical clean-SUCCESS cycles each lane folds. Chosen so the v0.2
 * strong lane's trust score climbs past the strong DECLARED weight (0.7) with
 * margin (foldSignal is diminishing-returns: step = positive_gain·pool·(1-score)
 * from a ~0 cold start), while the v0.1 pathology stays wide (~0.66 vs ~0.87).
 */
export const CYCLES = 16;

// ---------------------------------------------------------------------------
// Declared evidence-weight table (v0.2 policy). DECLARED, auditable policy —
// NOT a prediction. Two independent classes:
//   integration@L3 = 0.7  (the strong class: independent, mutation-tested CI)
//   llm-judge@L1   = 0.1  (the weak class: a low-tier judge note)
// ---------------------------------------------------------------------------
export const STRONG_WEIGHT = 0.7;
const WEAK_WEIGHT = 0.1;
export const EVIDENCE_WEIGHTS: Policy["evidence_weights"] = {
  integration: { L3: STRONG_WEIGHT },
  "llm-judge": { L1: WEAK_WEIGHT },
};

// ---------------------------------------------------------------------------
// The checks. Built as CheckSpec literals (not check.verify/validate, which pin
// evidence_refs to []) so each carries the hash-covered evidence_ref that drives
// the v0.2 declared weight. The stored `confidence` is what the v0.1 flat mean
// reads; the evidence_ref is what v0.2 reads. Both encode the SAME declared
// strength, so the two policies fold the identical warrants and only the
// weighting profile differs.
// ---------------------------------------------------------------------------

/**
 * strongVERIFY: independent (author `ci` != actor), mutation-tested (`mut=1`, so
 * the assertion-strength gate does not demote it) integration evidence at L3.
 *   v0.1: stored confidence 1.0.
 *   v0.2: effectiveWeight = integration@L3 = 0.7.
 */
export const strongVERIFY: CheckSpec<unknown, CleanChange> = {
  name: "integration-suite green",
  check_kind: "VERIFY",
  run: (ctx): CheckResult => ({
    name: "integration-suite green",
    check_kind: "VERIFY",
    verdict: ctx.output.ciGreen ? "PASS" : "FAIL",
    confidence: 1,
    evidence_refs: [
      evRef("integration", "L3", "ci", "sha256:integration", "ci://run/int", { mutation: true }),
    ],
  }),
};

/**
 * weakVALIDATE: a low-confidence llm-judge note (author `judge` != actor).
 * llm-judge is NOT a test class, so its L1 tier is honored (no gate demotion).
 *   v0.1: stored confidence 0.1 — averages the mean down (the pathology driver).
 *   v0.2: effectiveWeight = llm-judge@L1 (0.1) * caller confidence (0.1) = 0.01.
 */
export const weakVALIDATE: CheckSpec<unknown, CleanChange> = {
  name: "llm-judge sanity note",
  check_kind: "VALIDATE",
  run: (ctx): CheckResult => ({
    name: "llm-judge sanity note",
    check_kind: "VALIDATE",
    verdict: ctx.output.ciGreen ? "PASS" : "FAIL",
    confidence: WEAK_WEIGHT,
    evidence_refs: [evRef("llm-judge", "L1", "judge", "sha256:judge", "note:1")],
  }),
};

export interface LaneResult {
  finalScore: number;
  finalTier: Tier;
  finalSampleCount: number;
  /** 1-based cycle where the checkpoint first disappears; -1 if never. */
  firstAutonomous: number;
  /** Every cycle sealed SUCCESS (identical clean outcome shape). */
  allCleanSuccess: boolean;
  /** Protocol replay() of the same scope (I2 sanity). */
  replayScore: number;
  replayTier: Tier;
  replaySampleCount: number;
}

/**
 * A fresh, isolated engine under the given policy: its own ledger + deterministic
 * injected clock, with APPROVE at every checkpoint (fixedCheckpoint — never
 * autoApprove, which would fabricate a T0 APPROVE). idle_ms stays 0 (run()
 * default) so no decay enters and the trajectory is byte-exact and replayable.
 */
function makeEngine(policy: Policy): Recede {
  const ledger = new MemoryLedger();
  const EPOCH = Date.parse("2026-01-01T09:00:00.000Z");
  const TICK_MS = 60_000; // one minute per record
  let tick = 0;
  const clock = (): string => new Date(EPOCH + tick++ * TICK_MS).toISOString();
  return new Recede({
    ledger,
    policy,
    checkpoint: fixedCheckpoint("APPROVE", "reviewer"),
    now: clock,
  });
}

/**
 * THE SINGLE SHARED CODE PATH. Fold CYCLES identical clean-SUCCESS cycles for one
 * lane under the given policy + check set, then read the stored trust and its
 * replay. Each ticket id is UNIQUE so the content-hashed warrant ids never
 * collapse (records.ts hashes ts + intent).
 */
export async function runLane(
  policy: Policy,
  checks: CheckSpec<unknown, CleanChange>[],
): Promise<LaneResult> {
  const engine = makeEngine(policy);
  let firstAutonomous = -1;
  let allCleanSuccess = true;

  for (let i = 1; i <= CYCLES; i++) {
    const id = `EP-${String(i).padStart(3, "0")}`;
    const out: RunResult<CleanChange> = await engine.run(
      () => ({ ticket: id, ciGreen: true }),
      {
        actor: ACTOR,
        taskType: TASK,
        risk: RISK,
        intent: `${id}: apply a clean, verified fix`,
        checks,
      },
    );
    if (out.warrant.outcome?.result !== "SUCCESS") allCleanSuccess = false;
    const gated = out.checkpoint !== undefined;
    if (firstAutonomous === -1 && !gated) firstAutonomous = i;
  }

  const stored = engine.trustOf(ACTOR, TASK);
  const replayed = engine.replay(ACTOR, TASK);
  return {
    finalScore: stored.score,
    finalTier: stored.tier,
    finalSampleCount: stored.sample_count,
    firstAutonomous,
    allCleanSuccess,
    replayScore: replayed.score,
    replayTier: replayed.tier,
    replaySampleCount: replayed.sample_count,
  };
}

/**
 * Fold ONE clean-SUCCESS cycle for the given check set and return the sealed
 * Warrant, so a caller can read the CYCLE-INDEPENDENT structural pool directly
 * (`pooledConfidence(warrant, policy)`) instead of the cycle-dependent folded
 * score. The warrant's checks + evidence_refs are policy-independent, so the
 * returned Warrant carries the same declared weights the pool reads.
 */
export async function warrantFor(
  policy: Policy,
  checks: CheckSpec<unknown, CleanChange>[],
): Promise<Warrant> {
  const engine = makeEngine(policy);
  const out: RunResult<CleanChange> = await engine.run(
    () => ({ ticket: "EP-W", ciGreen: true }),
    {
      actor: ACTOR,
      taskType: TASK,
      risk: RISK,
      intent: "EP-W: single warrant for the structural pool invariant",
      checks,
    },
  );
  return out.warrant;
}
