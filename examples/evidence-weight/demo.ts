// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * evidence-weight — trust moves on DECLARED EVIDENCE WEIGHT, not just pass/fail.
 *
 * The AHA (Phase 0, on today's kernel, offline, keyless, deterministic):
 *
 *   Two lanes run the SAME work: N identical clean-SUCCESS cycles, each with an
 *   identical green VERIFY(ci) check. They end at DIFFERENT trust — the high
 *   declared-weight lane recedes review (reaches autonomy) sooner and ends at a
 *   higher score — purely because their VALIDATE evidence carries a different
 *   DECLARED weight. Pass/fail is identical; the weight is the whole story.
 *
 *   The non-vacuous control: two lanes with identical outcomes AND identical
 *   declared weight converge to a byte-identical trajectory. Divergence and
 *   control run through the SAME runLane() with only the weight differing, so
 *   an always-diverge bug fails the control and an always-converge bug fails the
 *   divergence.
 *
 * Every claim below is ASSERTED (not just printed); any failure sets
 * process.exitCode = 1. The demo IS its own test. Weights are declared,
 * auditable POLICY, not a prediction (see EVIDENCE.md).
 *
 * Zero deps; Node built-in type stripping (>= 22.6, tested on 26).
 *   node demo.ts
 */

import {
  ACTOR,
  TASK,
  RISK,
  CYCLES,
  WEIGHT_STRONG,
  WEIGHT_WEAK,
  WEIGHT_CONTROL,
  runLane,
  type LaneResult,
} from "./lanes.ts";

// ---------------------------------------------------------------------------
// Self-checking harness. Each assert increments a shared counter; the final
// count is snapshotted BEFORE the completeness guard so it never reads N+1.
// ---------------------------------------------------------------------------

let assertCount = 0;
function assert(cond: boolean, msg: string): void {
  assertCount += 1;
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ASSERT FAILED: ${msg}`);
    process.exitCode = 1;
  }
}

const BAR = "─".repeat(74);
function section(label: string): void {
  console.log("\n" + BAR);
  console.log(`  ${label}`);
  console.log(BAR);
}

// ---------------------------------------------------------------------------
// Run the two divergence lanes + the two control lanes through the SAME
// runLane(). The only input that varies is the declared weight.
// ---------------------------------------------------------------------------

const strong = await runLane(WEIGHT_STRONG);
const weak = await runLane(WEIGHT_WEAK);
const controlA = await runLane(WEIGHT_CONTROL);
const controlB = await runLane(WEIGHT_CONTROL);

console.log("\n" + BAR);
console.log("  EVIDENCE-WEIGHT — trust moves on DECLARED evidence weight, not pass/fail");
console.log(`  actor=${ACTOR}  task=${TASK}  risk=${RISK}  cycles=${CYCLES}`);
console.log(`  policy=recede.reference@0.1.0  clock=fixed  idle_ms=0 (no decay)`);
console.log(BAR);
console.log(
  "  Both lanes do the SAME work: N clean-SUCCESS fixes, identical green\n" +
    "  VERIFY(ci). The ONLY difference is the DECLARED weight on the VALIDATE\n" +
    "  evidence (its confidence). Higher declared weight => faster trust accrual\n" +
    "  => review recedes sooner. Weight is declared policy, not a prediction.",
);

// ---------------------------------------------------------------------------
// A compact side-by-side trajectory so a human_verify reviewer sees the split.
// Each cell is entryTier->exitTier: the gate judged the cycle on its ENTRY
// (pre-cycle) tier, THEN this SUCCESS folded in to the EXIT tier. GATED/AUTO is
// the gate's call on the ENTRY tier, so a "T1->T2 GATED" row is gated because it
// ENTERED at T1 (not because T2 is gated), and review recedes the very next
// cycle, which now ENTERS at T2 (reversible.low is autonomous at T2).
// ---------------------------------------------------------------------------
console.log(
  `\n  cyc │ strong w=${WEIGHT_STRONG.toFixed(2)}  entry→exit  │ weak w=${WEIGHT_WEAK.toFixed(2)}  entry→exit`,
);
console.log("  ────┼──────────────────────┼──────────────────────");
for (let i = 0; i < CYCLES; i++) {
  const s = strong.trajectory[i];
  const w = weak.trajectory[i];
  const cell = (p: { gatingTier: string; tier: string; score: number; gated: boolean }) =>
    `${p.gatingTier}→${p.tier} s=${p.score.toFixed(4)} ${p.gated ? "GATED" : "AUTO "}`;
  const mark = !s.gated && w.gated ? "  ← weak still gated" : "";
  console.log(`  ${String(s.cycle).padStart(3)} │ ${cell(s)} │ ${cell(w)}${mark}`);
}

// (1) IDENTICAL OUTCOMES -----------------------------------------------------
section("(1) IDENTICAL OUTCOMES — both lanes: N clean SUCCESS, same evidence volume");
console.log(
  `     strong: ${strong.finalSampleCount} SUCCESS cycles, weak: ${weak.finalSampleCount} SUCCESS cycles`,
);
assert(
  strong.allCleanSuccess && weak.allCleanSuccess,
  "A1: both lanes sealed N clean SUCCESS outcomes (identical pass/fail shape)",
);
assert(
  strong.finalSampleCount === weak.finalSampleCount && strong.finalSampleCount === CYCLES,
  `A2: both lanes accrued identical evidence VOLUME (n=${strong.finalSampleCount}=${weak.finalSampleCount}=${CYCLES}) — only the declared weight differs`,
);

// (2) DIVERGENCE BY DECLARED WEIGHT ------------------------------------------
section("(2) DIVERGENCE — higher declared weight recedes review sooner + higher trust");
console.log(
  `     strong (w=${WEIGHT_STRONG}): autonomy @#${strong.firstAutonomous}, final ${strong.finalTier} score=${strong.finalScore.toFixed(4)}`,
);
console.log(
  `     weak   (w=${WEIGHT_WEAK}): autonomy @#${weak.firstAutonomous}, final ${weak.finalTier} score=${weak.finalScore.toFixed(4)}`,
);
assert(
  strong.firstAutonomous < weak.firstAutonomous,
  `A3: strong-evidence lane reached autonomy SOONER (#${strong.firstAutonomous} < #${weak.firstAutonomous})`,
);
assert(
  strong.finalScore > weak.finalScore,
  `A4: strong-evidence lane ended at HIGHER trust score (${strong.finalScore.toFixed(4)} > ${weak.finalScore.toFixed(4)})`,
);
assert(
  strong.firstAutonomous !== -1 && weak.firstAutonomous !== -1,
  `A5: BOTH lanes eventually reached autonomy within ${CYCLES} cycles (the weak lane is slower, not broken)`,
);

// (3) NON-VACUOUS CONTROL ----------------------------------------------------
section("(3) CONTROL — identical outcomes AND identical weight => identical trajectory");
console.log(
  `     controlA (w=${WEIGHT_CONTROL}): autonomy @#${controlA.firstAutonomous}, score=${controlA.finalScore.toFixed(9)}`,
);
console.log(
  `     controlB (w=${WEIGHT_CONTROL}): autonomy @#${controlB.firstAutonomous}, score=${controlB.finalScore.toFixed(9)}`,
);
assert(
  controlA.finalScore === controlB.finalScore,
  `A6: same-weight lanes converge to a BYTE-IDENTICAL score (${controlA.finalScore.toFixed(9)}) — divergence is CAUSED by the weight, not noise`,
);
assert(
  controlA.firstAutonomous === controlB.firstAutonomous,
  `A7: same-weight lanes reach autonomy at the IDENTICAL cycle (#${controlA.firstAutonomous})`,
);

// (I2) REPLAY ----------------------------------------------------------------
// fold-vs-replay differ ONLY in the non-hashed `updated` timestamp — compare
// score (within 1e-9) + tier + sample_count, NEVER the timestamp.
section("(I2) REPLAY — the trust movement is real protocol trust, replayable");
const EPS = 1e-9;
function replayOk(l: LaneResult): boolean {
  return (
    Math.abs(l.replayScore - l.finalScore) < EPS &&
    l.replayTier === l.finalTier &&
    l.replaySampleCount === l.finalSampleCount
  );
}
console.log(
  `     strong: stored score=${strong.finalScore.toFixed(9)} / replay score=${strong.replayScore.toFixed(9)}`,
);
console.log(
  `     weak  : stored score=${weak.finalScore.toFixed(9)} / replay score=${weak.replayScore.toFixed(9)}`,
);
assert(replayOk(strong), "A8: replay() == live trust for the strong lane (score+tier+n)");
assert(replayOk(weak), "A9: replay() == live trust for the weak lane (score+tier+n)");

// (GATE) ENTRY-TIER FAITHFULNESS ---------------------------------------------
// The trajectory table shows entryTier->exitTier per cycle: the gate judged each
// cycle on its ENTRY (pre-cycle) tier, then this SUCCESS folded in to give the
// EXIT tier. With idle_ms=0 there is no decay, so a cycle's entry tier must equal
// the PRIOR cycle's exit tier. That invariant is what makes the GATED->AUTO
// handoff read honestly in one pass (a T2 GATED row is gated because it ENTERED
// at T1, not because T2 is gated).
section("(GATE) ENTRY-TIER — each cycle's gate ran on the prior cycle's exit tier (no decay)");
function entryChainOk(l: LaneResult): boolean {
  return l.trajectory.every((p, i) => i === 0 || p.gatingTier === l.trajectory[i - 1].tier);
}
assert(
  entryChainOk(strong) && entryChainOk(weak),
  "A10: each cycle's gate entry-tier == the prior cycle's exit-tier (no hidden decay; the entry->exit trajectory is faithful)",
);

// ---------------------------------------------------------------------------
// Completeness guard. Snapshot the live counter BEFORE the guard (the guard is
// a plain `if`, not an assert(), so it does not increment) and compare against
// an INDEPENDENT constant — a self-referential ${n}/${n} would prove nothing.
// ---------------------------------------------------------------------------
const passed = assertCount;
const EXPECTED_ASSERTIONS = 10;

console.log("\n" + BAR);
if (passed !== EXPECTED_ASSERTIONS) {
  console.error(
    `  ✗ ran ${passed} assertions, expected ${EXPECTED_ASSERTIONS} — assertion set incomplete`,
  );
  process.exitCode = 1;
} else if (process.exitCode === 1) {
  console.error(`  ✗ ${passed}/${EXPECTED_ASSERTIONS} assertions ran but at least one FAILED`);
} else {
  console.log(`  ✓ all ${passed}/${EXPECTED_ASSERTIONS} assertions passed`);
  console.log("  Two identical clean-SUCCESS lanes diverged in trust on declared");
  console.log("  evidence weight alone; the same-weight control converged exactly.");
}
console.log(BAR + "\n");
