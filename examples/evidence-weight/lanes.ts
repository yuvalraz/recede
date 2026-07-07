// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * evidence-weight — shared lane logic for the declared-evidence-weight demo.
 *
 * The claim this file makes runnable: on today's kernel, with NO protocol
 * change, two lanes with IDENTICAL clean-SUCCESS outcomes and IDENTICAL green
 * VERIFY(ci) evidence can still diverge in trust, purely because their VALIDATE
 * evidence carries a different DECLARED weight.
 *
 * The honest mechanism (Phase 0, see EVIDENCE.md):
 *   - check.verify hardcodes confidence 1.0 (reference/ts/src/check.ts), so a
 *     VERIFY check cannot yet carry differential weight.
 *   - check.validate takes a CALLER-supplied confidence that flows into
 *     foldSignal's confidence-weighted positive step (reference/ts/src/weighting.ts):
 *     step = positive_gain * raw * meanConfidence * (1 - score).
 *   - So we encode "declared evidence weight" as the VALIDATE check's confidence.
 *     A higher weight raises the mean check confidence, which raises each clean
 *     SUCCESS's positive step, which lifts the trust score faster, which crosses
 *     the (reversible.low x tier) autonomy boundary at T2 sooner.
 *
 * runLane(weight) is the SINGLE shared code path. Everything is held constant
 * across lanes EXCEPT `weight`: same actor, task_type, risk, injected clock
 * epoch/tick, ticket ids, check set, idle_ms=0 (no decay). Any divergence
 * between two lanes is therefore attributable ONLY to the declared weight. That
 * is what makes the same-weight control in demo.ts non-vacuous.
 *
 * Zero runtime dependencies; runs on Node built-in type stripping (>= 22.6,
 * tested on 26). It imports the canonical protocol from ../../reference/ts and
 * reimplements no protocol logic.
 */

import {
  Recede,
  MemoryLedger,
  check,
  fixedCheckpoint,
  defaultPolicy,
  type CheckSpec,
  type RunResult,
  type Tier,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// The domain. A change is just the clean-pipeline signal it would produce: a
// green CI verdict. DEV is the wrapped function; it knows nothing about trust.
// ---------------------------------------------------------------------------

export interface CleanChange {
  ticket: string;
  ciGreen: boolean;
}

/** Dogfood convention: model@harness. Same actor family on both lanes. */
export const ACTOR = "opus-4.8@claude-code";
/** Same task-type shape on both lanes. */
export const TASK = "code.fix";
/** reversible.low is AUTONOMOUS at T2 in the default policy (policy.ts). */
export const RISK = "reversible.low";

/** How many identical clean-SUCCESS cycles each lane runs. */
export const CYCLES = 18;

// The declared evidence weights (VALIDATE confidence in [0,1]) — the ONLY input
// that differs between lanes. Weights are DECLARED, auditable policy, not a
// prediction that one check catches more bugs (see EVIDENCE.md, M0/M1).
/** Strong: independent, isolated, attested evidence (high declared weight). */
export const WEIGHT_STRONG = 0.9;
/** Weak: self-authored, gameable evidence (low declared weight). */
export const WEIGHT_WEAK = 0.1;
/** Control: a single weight used for BOTH control lanes (same weight -> converge). */
export const WEIGHT_CONTROL = 0.5;

/**
 * VERIFY(ci): identical for every lane. The kernel hardcodes VERIFY confidence
 * to 1.0 (check.ts), so this carries no differential weight by construction.
 */
export const ciGreen: CheckSpec<unknown, CleanChange> = check.verify<unknown, CleanChange>(
  "ci/tests/types green",
  (io) => io.output.ciGreen,
);

/**
 * VALIDATE(evidence): the declared-evidence-weight channel.
 *
 * The lane's DECLARED evidence weight rides straight into the VALIDATE check's
 * confidence. That confidence flows into foldSignal's confidence-weighted
 * positive step (weighting.ts), so a higher declared weight lifts trust faster
 * on the same clean SUCCESS. Verdict is still just the clean pass/fail
 * (io.output.ciGreen); the WEIGHT is what differs between lanes. Weight is a
 * declared, auditable policy value in [0,1], not a prediction (see EVIDENCE.md).
 */
export function evidenceOf(weight: number): CheckSpec<unknown, CleanChange> {
  return check.validate<unknown, CleanChange>(
    "declared-evidence-weight",
    async (io) => ({ ok: io.output.ciGreen, confidence: weight }),
  );
}

/** One point on a lane's trust trajectory. */
export interface CyclePoint {
  cycle: number;
  /** Tier the checkpoint gate JUDGED this cycle on: the pre-cycle (entry) tier. */
  gatingTier: Tier;
  /** Tier AFTER this cycle's SUCCESS folds in: the post-fold (exit) tier. */
  tier: Tier;
  score: number;
  gated: boolean;
}

export interface LaneResult {
  weight: number;
  /** 1-based cycle where the checkpoint first disappears; -1 if never. */
  firstAutonomous: number;
  finalScore: number;
  finalTier: Tier;
  finalSampleCount: number;
  /** Every cycle sealed SUCCESS (identical clean outcome shape). */
  allCleanSuccess: boolean;
  /** Protocol replay() of the same scope (I2 sanity). */
  replayScore: number;
  replayTier: Tier;
  replaySampleCount: number;
  trajectory: CyclePoint[];
}

/**
 * A fresh, isolated engine: its own ledger + deterministic injected clock, with
 * APPROVE at every checkpoint (fixedCheckpoint — never autoApprove, which would
 * fabricate a T0 APPROVE). idle_ms stays 0 (run() default) so no decay enters
 * and the trajectory is byte-exact and replayable.
 */
function makeEngine(): Recede {
  const ledger = new MemoryLedger();
  const EPOCH = Date.parse("2026-01-01T09:00:00.000Z");
  const TICK_MS = 60_000; // one minute per record
  let tick = 0;
  const clock = (): string => new Date(EPOCH + tick++ * TICK_MS).toISOString();
  return new Recede({
    ledger,
    policy: defaultPolicy(),
    checkpoint: fixedCheckpoint("APPROVE", "reviewer"),
    now: clock,
  });
}

/**
 * THE SINGLE SHARED CODE PATH. Run CYCLES identical clean-SUCCESS cycles for one
 * lane at the given declared weight, then read the stored trust and its replay.
 * Each ticket id is UNIQUE so the content-hashed warrant ids never collapse
 * (records.ts hashes ts + intent).
 */
export async function runLane(weight: number): Promise<LaneResult> {
  const engine = makeEngine();
  const checks: CheckSpec<unknown, CleanChange>[] = [ciGreen, evidenceOf(weight)];
  let firstAutonomous = -1;
  let allCleanSuccess = true;
  const trajectory: CyclePoint[] = [];

  for (let i = 1; i <= CYCLES; i++) {
    const id = `EW-${String(i).padStart(3, "0")}`;
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
    // The gate decided on trust.before (recede.ts: gate(before, ...)); trust.after
    // is this SUCCESS folded in. Record both so the trajectory shows entry->exit.
    trajectory.push({
      cycle: i,
      gatingTier: out.trust.before.tier,
      tier: out.trust.after.tier,
      score: out.trust.after.score,
      gated,
    });
  }

  const stored = engine.trustOf(ACTOR, TASK);
  const replayed = engine.replay(ACTOR, TASK);
  return {
    weight,
    firstAutonomous,
    finalScore: stored.score,
    finalTier: stored.tier,
    finalSampleCount: stored.sample_count,
    allCleanSuccess,
    replayScore: replayed.score,
    replayTier: replayed.tier,
    replaySampleCount: replayed.sample_count,
    trajectory,
  };
}
