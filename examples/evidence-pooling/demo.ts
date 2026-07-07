// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * evidence-pooling — the flat-mean pathology and its pooled fix, proven through
 * the REAL kernel fold (offline, keyless, deterministic).
 *
 * The AHA:
 *
 *   Take a strong VERIFY (independent, mutation-tested integration evidence) and
 *   add a WEAK VALIDATE (a low-confidence llm-judge note). Under v0.1's flat-mean
 *   confidence, that extra weak-but-passing check DRAGS trust BELOW the
 *   strong-VERIFY-alone lane — adding corroborating evidence LOWERS trust. That is
 *   the P0 pathology (see EVIDENCE.md): confidence = mean(check confidences), so a
 *   0.1 VALIDATE averages a 1.0 VERIFY down to 0.55.
 *
 *   Under v0.2's class-deduped noisy-OR pool, the same weak VALIDATE can only ADD:
 *   pool = 1 - Π(1 - w_i) >= the strongest single class weight. Adding evidence
 *   never subtracts.
 *
 *   The control: the same lane folded twice is byte-identical, so the divergence
 *   in (a)/(b) is CAUSED by the weighting profile, not run-to-run noise.
 *
 * Both policies fold the SAME warrants through the SAME runLane() — only the
 * policy (v0.1 defaultPolicy vs v0.2 referencePolicyV02) differs. Weights are
 * DECLARED, auditable POLICY, not a prediction that one check catches more bugs
 * (see EVIDENCE.md, red-team rules 1 + 4).
 *
 * Zero deps; Node built-in type stripping (>= 22.6, tested on 26).
 *   node demo.ts
 */

import { defaultPolicy, referencePolicyV02, pooledConfidence } from "../../reference/ts/src/index.ts";
import {
  STRONG_WEIGHT,
  EVIDENCE_WEIGHTS,
  strongVERIFY,
  weakVALIDATE,
  runLane,
  warrantFor,
  ACTOR,
  TASK,
  RISK,
  CYCLES,
  type LaneResult,
} from "./lanes.ts";

// ---------------------------------------------------------------------------
// Self-checking harness. Each assert increments a shared counter; the final
// count is snapshotted BEFORE the completeness guard (a plain `if`, not an
// assert) and compared against an INDEPENDENT literal constant — a silently
// skipped assertion therefore fails the demo.
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
// The two policies. IMPORT-ONLY: both are consumed from the reference kernel;
// the demo reimplements no protocol logic.
// ---------------------------------------------------------------------------
const v01 = defaultPolicy();
const v02 = referencePolicyV02(EVIDENCE_WEIGHTS);

// Two check sets folded under each policy via the SAME runLane():
//   strongOnly = [strongVERIFY]                 (one strong class)
//   strongPlusWeak = [strongVERIFY, weakVALIDATE]  (+ one weak class)
const V01_strongOnly = await runLane(v01, [strongVERIFY]);
const V01_strongPlusWeak = await runLane(v01, [strongVERIFY, weakVALIDATE]);
const V02_strongOnly = await runLane(v02, [strongVERIFY]);
const V02_strongPlusWeak = await runLane(v02, [strongVERIFY, weakVALIDATE]);
// Determinism control: fold the SAME lane a second time.
const CTRL_a = await runLane(v01, [strongVERIFY, weakVALIDATE]);
const CTRL_b = await runLane(v01, [strongVERIFY, weakVALIDATE]);
// Single warrants for the CYCLE-INDEPENDENT structural pool invariant. These are
// the v0.2 noisy-OR pool over declared per-check weights on ONE warrant — a
// property of `pooledConfidence`, independent of how many cycles were folded.
const W_strongOnly = await warrantFor(v02, [strongVERIFY]);
const W_strongPlusWeak = await warrantFor(v02, [strongVERIFY, weakVALIDATE]);
const POOL_strongOnly = pooledConfidence(W_strongOnly, v02);
const POOL_strongPlusWeak = pooledConfidence(W_strongPlusWeak, v02);

console.log("\n" + BAR);
console.log("  EVIDENCE-POOLING — flat-mean drags; pooled adds");
console.log(`  actor=${ACTOR}  task=${TASK}  risk=${RISK}  cycles=${CYCLES}`);
console.log(`  clock=fixed  idle_ms=0 (no decay)  strong declared weight=${STRONG_WEIGHT}`);
console.log(BAR);
console.log(
  "  Same warrants, same runLane(). strongOnly folds one strong VERIFY; \n" +
    "  strongPlusWeak adds a weak VALIDATE. v0.1 averages the weak confidence\n" +
    "  into the mean (drags down); v0.2 pools it via noisy-OR (adds). Weights\n" +
    "  are declared policy, not a prediction (EVIDENCE.md, red-team rules 1+4).",
);

// (a) v0.1 PATHOLOGY ---------------------------------------------------------
section("(a) v0.1 PATHOLOGY — a weak VALIDATE DRAGS trust below VERIFY-alone");
console.log(
  `     v0.1 strongOnly     : score=${V01_strongOnly.finalScore.toFixed(9)} (${V01_strongOnly.finalTier})`,
);
console.log(
  `     v0.1 strongPlusWeak : score=${V01_strongPlusWeak.finalScore.toFixed(9)} (${V01_strongPlusWeak.finalTier})`,
);
console.log(
  `     drag = ${(V01_strongOnly.finalScore - V01_strongPlusWeak.finalScore).toFixed(9)} (adding evidence LOWERED trust)`,
);
assert(
  V01_strongPlusWeak.finalScore < V01_strongOnly.finalScore,
  `A1: under v0.1, score([strongVERIFY, weakVALIDATE]) < score([strongVERIFY]) ` +
    `(${V01_strongPlusWeak.finalScore.toFixed(6)} < ${V01_strongOnly.finalScore.toFixed(6)}) — the flat-mean averaging-down bug`,
);
assert(
  V01_strongOnly.allCleanSuccess && V01_strongPlusWeak.allCleanSuccess,
  `A2: both v0.1 lanes sealed ${CYCLES} clean SUCCESS outcomes (identical pass/fail shape; only the added weak check differs)`,
);

// (b) v0.2 FIX ---------------------------------------------------------------
section("(b) v0.2 FIX — pooled evidence can only ADD (>= strong-alone AND >= strong weight)");
console.log(
  `     v0.2 strongOnly     : score=${V02_strongOnly.finalScore.toFixed(9)} (${V02_strongOnly.finalTier})`,
);
console.log(
  `     v0.2 strongPlusWeak : score=${V02_strongPlusWeak.finalScore.toFixed(9)} (${V02_strongPlusWeak.finalTier})`,
);
console.log(
  `     lift = ${(V02_strongPlusWeak.finalScore - V02_strongOnly.finalScore).toFixed(9)} (adding evidence RAISED trust, never below)`,
);
assert(
  V02_strongPlusWeak.finalScore >= V02_strongOnly.finalScore,
  `A3: under v0.2, score([strongVERIFY, weakVALIDATE]) >= score([strongVERIFY]) ` +
    `(${V02_strongPlusWeak.finalScore.toFixed(6)} >= ${V02_strongOnly.finalScore.toFixed(6)}) — pooling means adding can only ADD`,
);
// The STRUCTURAL, cycle-independent invariant the demo actually claims: the
// noisy-OR pool `1 - Π(1 - w_i)` over declared per-check weights never sits below
// its strongest single class, and adding a PASS class can only ADD to it. Both
// are properties of `pooledConfidence` on ONE warrant — true at any cycle count,
// unlike the folded trust score (whose fold asymptote is 1.0, not the pool weight).
console.log(
  `     pool strongOnly     : ${POOL_strongOnly.toFixed(6)}  (= strongest single class weight ${STRONG_WEIGHT})`,
);
console.log(
  `     pool strongPlusWeak : ${POOL_strongPlusWeak.toFixed(6)}  (adding the weak class only ADDED to the pool)`,
);
assert(
  POOL_strongPlusWeak >= STRONG_WEIGHT,
  `A4: the v0.2 pool over [strongVERIFY, weakVALIDATE] never sits below its strongest single class ` +
    `(pooledConfidence=${POOL_strongPlusWeak.toFixed(6)} >= strong declared weight ${STRONG_WEIGHT}) — structural, at any cycle count`,
);
assert(
  POOL_strongPlusWeak >= POOL_strongOnly,
  `A5: adding a PASS class can only ADD to the v0.2 pool ` +
    `(pooledConfidence([strong,weak])=${POOL_strongPlusWeak.toFixed(6)} >= pooledConfidence([strong])=${POOL_strongOnly.toFixed(6)}) — noisy-OR is monotone in added PASS checks`,
);

// (c) CONTROL — determinism --------------------------------------------------
section("(c) CONTROL — the SAME lane folded twice is byte-identical (divergence is the weighting, not noise)");
console.log(
  `     controlA : score=${CTRL_a.finalScore.toFixed(12)}  n=${CTRL_a.finalSampleCount}`,
);
console.log(
  `     controlB : score=${CTRL_b.finalScore.toFixed(12)}  n=${CTRL_b.finalSampleCount}`,
);
assert(
  CTRL_a.finalScore === CTRL_b.finalScore && CTRL_a.finalTier === CTRL_b.finalTier,
  `A6: the same lane folded twice is BYTE-IDENTICAL (score=${CTRL_a.finalScore.toFixed(12)}) — the (a)/(b) divergence is CAUSED by the weighting profile, not run-to-run noise`,
);

// (I2) REPLAY — the movement is real, replayable protocol trust ---------------
// Fold-vs-replay differ ONLY in the non-hashed `updated` timestamp — compare
// score (within 1e-9) + tier + sample_count, never the timestamp.
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
  `     v0.1 strongPlusWeak: stored=${V01_strongPlusWeak.finalScore.toFixed(9)} / replay=${V01_strongPlusWeak.replayScore.toFixed(9)}`,
);
console.log(
  `     v0.2 strongPlusWeak: stored=${V02_strongPlusWeak.finalScore.toFixed(9)} / replay=${V02_strongPlusWeak.replayScore.toFixed(9)}`,
);
assert(replayOk(V01_strongPlusWeak), "A7: replay() == live trust for the v0.1 lane (score+tier+n)");
assert(replayOk(V02_strongPlusWeak), "A8: replay() == live trust for the v0.2 lane (score+tier+n)");

// ---------------------------------------------------------------------------
// Completeness guard. Snapshot the live counter BEFORE the guard (the guard is
// a plain `if`, not an assert(), so it does not increment) and compare against
// an INDEPENDENT literal constant — a self-referential ${n}/${n} would prove
// nothing.
// ---------------------------------------------------------------------------
const passed = assertCount;
const EXPECTED_ASSERTIONS = 8;

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
  console.log("  A weak VALIDATE dragged v0.1 trust below VERIFY-alone; under v0.2");
  console.log("  the same evidence only added. The control fold was byte-identical.");
}
console.log(BAR + "\n");
