// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Runnable proof of the CC10X <- Recede pattern. No install; no external CC10X.
 * We feed synthetic CC10X phase signals across many `code.fix` runs and watch
 * the human review recede as an (agent, task_type) earns trust, then snap back
 * on a REVERT. A separate `code.migrate` lane shows never_recede holding.
 *
 *   node integrations/cc10x/demo.ts
 */

import { Cc10xRecede, type Cc10xBuildInput } from "./cc10x-adapter.ts";
import { fixedCheckpoint } from "../../reference/ts/src/index.ts";

// Count how often CC10X's human review actually fired.
let reviews = 0;
const approve = fixedCheckpoint("APPROVE", "human-reviewer");
const countingReview = async (p: Parameters<typeof approve>[0]) => {
  reviews++;
  return approve(p);
};

// Deterministic clock so the printed trajectory is reproducible run-to-run.
let t = Date.parse("2026-07-01T09:00:00.000Z");
const clock = () => new Date((t += 1000)).toISOString();

const bridge = new Cc10xRecede({ checkpoint: countingReview, now: clock });
const AGENT = "claude-code";

// A clean CC10X build: verifier passes, silent-failure-hunter clean, tests
// honest, review would approve. All phases PASS at high confidence.
const cleanFix = (n: number): Cc10xBuildInput => ({
  agent: AGENT,
  taskType: "code.fix",
  intent: `fix #${n}: null-guard in parser`,
  risk: "reversible.low",
  phases: [
    { phase: "verifier", kind: "VERIFY", pass: true, confidence: 1 },
    { phase: "silent-failure-hunter", kind: "VERIFY", pass: true, confidence: 1 },
    { phase: "test-honesty", kind: "VALIDATE", pass: true, confidence: 0.9 },
    { phase: "review", kind: "VALIDATE", pass: true, confidence: 0.85 },
  ],
});

const line = (tag: string, msg: string) => console.log(`${tag.padEnd(12)} ${msg}`);

console.log("=".repeat(74));
console.log("CC10X x Recede — human review recedes as code.fix is proven, per agent");
console.log("(reference PATTERN, not a fork of CC10X; Recede gate is pure)");
console.log("=".repeat(74));

let lastAutonomousIntentId = "";
let recededAt = 0;

console.log("\n[1] ACCRUE — feed clean code.fix builds; watch the human gate recede:");
for (let i = 1; i <= 30; i++) {
  const reviewsBefore = reviews;
  const out = await bridge.recordBuild(cleanFix(i), () => `patch-${i}`);
  const fired = reviews > reviewsBefore;
  if (!fired) lastAutonomousIntentId = out.warrant.intent.id;
  if (!fired && recededAt === 0) recededAt = i;
  const s = out.trust.after;
  if (i <= 3 || (recededAt > 0 && i >= recededAt - 1 && i <= recededAt + 1) || i % 10 === 0) {
    line(`build #${i}`, `tier=${s.tier} score=${s.score.toFixed(2)} conf=${s.confidence.toFixed(2)} n=${String(s.sample_count).padStart(2)} review=${fired ? "FIRED" : "receded"}`);
  }
}

console.log(
  `\n[2] RECEDE — human review first disappeared at build #${recededAt}; ${reviews}/30 builds gated.` +
    `\n    Same call site, no rule change — the gate receded on accrued evidence.`,
);

// A next-day REVERT of a fix that had shipped AUTONOMOUSLY: late negative
// evidence that also trips the near-miss ratchet (an unattended action was
// later overturned).
console.log("\n[3] SNAP-BACK — an autonomously-shipped fix is REVERTED post-merge:");
const rev = bridge.revert(lastAutonomousIntentId);
line("REVERT", `score ${rev.before.score.toFixed(2)} -> ${rev.after.score.toFixed(2)}, tier ${rev.before.tier} -> ${rev.after.tier}`);

// The next build of the same scope: does review snap back?
const reviewsBefore = reviews;
const out = await bridge.recordBuild(cleanFix(31), () => "patch-31");
const snapped = reviews > reviewsBefore;
line("build #31", `tier=${out.trust.after.tier} review=${snapped ? "SNAPPED BACK (gate fired again)" : "still receded"}`);
console.log("    No rule was edited. The gate moved because the evidence moved.");

// A separate never_recede lane: a schema migration ALWAYS gates.
console.log("\n[4] NEVER-RECEDE — a schema migration always gates, even at high trust:");
for (let i = 1; i <= 8; i++) {
  await bridge.recordBuild(
    { agent: AGENT, taskType: "code.migrate", intent: `reversible prep #${i}`, risk: "reversible.low",
      phases: cleanFix(i).phases },
    () => `mig-prep-${i}`,
  );
}
const migTrust = bridge.trustOf(AGENT, "code.migrate");
const reviewsBeforeSchema = reviews;
const schema = await bridge.recordBuild(
  { agent: AGENT, taskType: "code.migrate", intent: "drop legacy column — irreversible", risk: "irreversible.critical",
    phases: cleanFix(99).phases },
  () => "DROP COLUMN legacy",
);
const schemaGated = reviews > reviewsBeforeSchema;
line("schema mig", `code.migrate at tier=${migTrust.tier} -> gate=${schemaGated ? "HUMAN REVIEW" : "autonomous"}  reason="${schema.gateDecision.reason}"`);

console.log("\n" + "=".repeat(74));
console.log("Trajectory: gated -> receded -> snapped back on REVERT; never_recede floor held.");
console.log("=".repeat(74));
