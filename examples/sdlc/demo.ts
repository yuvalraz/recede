// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * THE EVERYDAY EXAMPLE — a coding agent earning trust across a backlog.
 *
 * An engineering team put an AI agent in the loop. It reads a ticket, writes the
 * fix, runs CI, opens a PR. A human is nominally reviewing all of it — but no one
 * can meaningfully read 40 agent PRs a day, so review collapses into rubber-stamp
 * or bottleneck. The root cause is a trust-calibration bug: trust today is
 * MIS-ATTRIBUTED (one global "do I trust the AI?" instead of per-capability) and
 * MIS-CALIBRATED (granted by feel, not evidence).
 *
 * Recede fixes both. Trust is held per (Actor, TaskType) and moves ONLY on
 * evidence. Nothing about the CALL SITE changes across this whole run — it is
 * always the same `r.run(() => agent.implement(ticket), …)`. What changes is what
 * the evidence has earned. We watch, in order:
 *
 *   (1) BASELINE       every code.fix pauses at a human review (cold start, T0).
 *   (2) EARNING TRUST  ~30 clean, VERIFIED + VALIDATED fixes accrue trust T0→T3.
 *   (3) REVIEW RECEDES low-risk code.fix now merges autonomously; no human paged,
 *                      Warrant still recorded — every unread merge has a receipt.
 *   (4) SNAP BACK      an autonomously-merged fix is REVERTED in staging; trust
 *                      craters below the tier floor and review re-arms itself —
 *                      no rule was edited, the evidence moved.
 *   (5) STAKES GATE    a code.migrate (irreversible.critical) GATES at every tier
 *                      via never_recede / invariant I3 — earned autonomy on fixes
 *                      never leaks into a schema migration.
 *   (6) REPLAY         replay() over the stored Warrants reproduces the exact
 *                      final trust state (invariant I2) — the audit answer to
 *                      "why did that PR merge unattended?". Fail-closed: exit 1
 *                      if replay != stored.
 *
 * This file imports the canonical TypeScript reference implementation from
 * ../../reference/ts — it reimplements no protocol logic, and it is not coupled
 * to any particular agent harness. Zero runtime dependencies; runs on Node's
 * built-in type stripping (>= 22.6, tested on 26).
 *
 *   node demo.ts
 */

import {
  Recede,
  MemoryLedger,
  check,
  fixedCheckpoint,
  type RunResult,
  type Warrant,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// The domain: a tiny coding "agent". This is the function you already have —
// Recede wraps it; it knows nothing about trust, gates, or reviews. A change is
// modelled as the check verdicts it would produce in your real pipeline.
// ---------------------------------------------------------------------------

interface Ticket {
  id: string;
  title: string;
  /** The CI/tests/types verdict this change would produce. */
  ci: "green" | "red";
  /** Whether the delivered change actually does what the ticket asked, at quality. */
  intentFit: boolean;
}

/** What the agent "returns" for a change: a diff + the pipeline signals it carries. */
interface Change {
  ticket: string;
  ci: "green" | "red";
  intentFit: boolean;
  linesChanged: number;
}

/** The agent implements a ticket. (In real life: it edits files and pushes a PR.) */
function implement(t: Ticket): Change {
  return { ticket: t.id, ci: t.ci, intentFit: t.intentFit, linesChanged: 20 };
}

// ---------------------------------------------------------------------------
// V&V is first-class and SPLIT (SPEC section 5).
//   VERIFY   = "did it do the thing right"  → CI / tests / types are green.
//   VALIDATE = "did it do the RIGHT thing"  → the change matches the ticket at
//              quality (a stand-in for a review LLM-as-judge / senior reviewer).
// Conflating "tests are green" with "it did what I asked" is how confidently-
// wrong code merges. Both are declarative and passed to r.run().
// ---------------------------------------------------------------------------

/** VERIFY: CI, tests, and types are all green. */
const ciGreen = check.verify<unknown, Change>(
  "ci/tests/types green",
  (io) => io.output.ci === "green",
);

/** VALIDATE: the delivered change does what the ticket asked, at quality. */
const intentFit = check.validate<unknown, Change>(
  "intent-fit (delivered flow matches ticket)",
  async (io) => (io.output.intentFit ? { ok: true, confidence: 0.9 } : { ok: false, confidence: 0.95 }),
);

// ---------------------------------------------------------------------------
// A deterministic clock. Real time never enters the demo, so the trajectory is
// byte-for-byte reproducible and the I2 replay check is meaningful. Each record
// stamped advances the clock one fixed tick.
// ---------------------------------------------------------------------------

const EPOCH = Date.parse("2026-01-01T09:00:00.000Z");
const TICK_MS = 60_000; // one minute per record
let clockTick = 0;
const clock = (): string => new Date(EPOCH + clockTick++ * TICK_MS).toISOString();

// ---------------------------------------------------------------------------
// Pretty-printing the trajectory. The point of Recede is that a human sees LESS
// as trust grows, so the trace is explicit about what a reviewer would (or would
// not) have been paged for on each change.
// ---------------------------------------------------------------------------

const BAR = "─".repeat(74);

function section(n: number, title: string): void {
  console.log("\n" + BAR);
  console.log(`  ${n}. ${title}`);
  console.log(BAR);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** One legible line per change: what happened + whether a human was paged. */
function traceChange(label: string, out: RunResult<Change>): void {
  const t = out.trust.after;
  const paged = out.checkpoint
    ? `REVIEW ↯ human paged (${out.checkpoint.altitude}, ${out.checkpoint.decision})`
    : `autonomous merge · no human paged`;
  const delta = out.trust.after.score - out.trust.before.score;
  const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(3);
  console.log(
    `  ${pad(label, 26)} ${pad(t.tier, 4)} ` +
      `score=${t.score.toFixed(3)} (${pad(deltaStr, 7)}) ` +
      `n=${pad(String(t.sample_count), 3)} → ${paged}`,
  );
}

function warrantChain(w: Warrant): string {
  const short = (id: string) => id.slice(0, 8);
  const parts = [
    `intent:${short(w.intent.id)}`,
    w.action ? `action:${short(w.action.id)}` : null,
    ...w.checks.map((c) => `${c.check_kind[0]}${c.verdict[0]}:${short(c.id)}`),
    ...w.checkpoints.map((c) => `cp/${c.decision}:${short(c.id)}`),
    w.outcome ? `outcome/${w.outcome.result}:${short(w.outcome.id)}` : null,
  ].filter(Boolean);
  return parts.join(" → ");
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

const ledger = new MemoryLedger();

// The reviewer APPROVES clean fixes at review time (fast, honest, small). We
// build one Recede on this handler, and a second view of the SAME ledger + policy
// whose reviewer REJECTS — that is the human catching the schema migration in
// beat 5. Both share the injected deterministic clock.
const r = new Recede({ ledger, checkpoint: fixedCheckpoint("APPROVE", "reviewer"), now: clock });
const rReject = new Recede({
  ledger,
  policy: r.policy,
  checkpoint: fixedCheckpoint("REJECT", "reviewer"),
  now: clock,
});

const ACTOR = "code-agent";
const FIX = "code.fix";
const MIGRATE = "code.migrate";

// The call site never changes. Only intent/risk/checks describe THIS change.
// code.fix is a small, REVERSIBLE change — the everyday backlog work.
const fixBase = {
  actor: ACTOR,
  taskType: FIX,
  risk: "reversible.low",
  checks: [ciGreen, intentFit],
} as const;

async function runFix(
  ticket: Ticket,
  intent: string,
  engine: Recede = r,
  extra: { deferUntil?: string } = {},
): Promise<RunResult<Change>> {
  return engine.run(() => implement(ticket), {
    ...fixBase,
    intent,
    ...(extra.deferUntil ? { deferUntil: extra.deferUntil } : {}),
  });
}

console.log("\n" + BAR);
console.log("  RECEDE — the everyday SDLC story");
console.log("  actor=code-agent  task=code.fix  policy=recede.reference@0.1.0");
console.log(BAR);
console.log(
  "  Trust is scoped to (actor, task_type) — never one global 'do I trust the\n" +
    "  AI?'. It moves ONLY through sealed Warrants. The gate is a PURE function\n" +
    "  of (trust, risk, policy): no `if (needsReview)` lives in the agent —\n" +
    "  run() decides, replayably. Verify = CI/tests/types green; Validate =\n" +
    "  the change does what the ticket asked, at quality.",
);

// (1) BASELINE — cold start at T0, every code.fix is reviewed. -----------------
section(1, "BASELINE — cold start (T0): every code.fix is human-reviewed");
const first = await runFix(
  { id: "PROJ-1001", title: "fix null deref in parser", ci: "green", intentFit: true },
  "Fix PROJ-1001: null deref in parser",
);
traceChange("PROJ-1001", first);
console.log(`     warrant: ${warrantChain(first.warrant)}`);
console.log(
  `     gate reason: ${first.gateDecision.reason}\n` +
    `     policy_digest pinned on the decision (I6): ${first.gateDecision.policy_digest.slice(0, 16)}…`,
);

// (2) EARNING TRUST — ~30 clean verified + validated fixes accrue. -------------
section(2, "EARNING TRUST — clean, verified + validated fixes compound T0 → T3");
let last = first;
let firstAutonomous = -1;
for (let i = 2; i <= 32; i++) {
  last = await runFix(
    { id: `PROJ-10${String(i).padStart(2, "0")}`, title: `small fix #${i}`, ci: "green", intentFit: true },
    `Fix PROJ-10${String(i).padStart(2, "0")}: small low-risk fix #${i}`,
  );
  if (firstAutonomous === -1 && !last.checkpoint) firstAutonomous = i;
  if (i === 2 || i === 5 || i === firstAutonomous || i === 20 || i === 32) {
    traceChange(`PROJ-10${String(i).padStart(2, "0")}`, last);
  }
}
console.log(
  `\n     Review receded at fix #${firstAutonomous}: that is the exact change where\n` +
    `     the (RiskClass × Tier) matrix flips 'reversible.low' to AUTONOMOUS.\n` +
    `     Small daily verified wins compounded into earned, bounded autonomy.`,
);

// (3) REVIEW RECEDES — same call site, now merges unattended. -------------------
section(3, "REVIEW RECEDES — same code, no review, Warrant still recorded");
const auto = await runFix(
  { id: "PROJ-1041", title: "tidy log message", ci: "green", intentFit: true },
  "Fix PROJ-1041: tidy a log message (low-risk)",
);
traceChange("PROJ-1041", auto);
console.log(`     warrant: ${warrantChain(auto.warrant)}`);
console.log(
  `     The reviewer saw NOTHING for this PR — and that is the product working.\n` +
    `     The Warrant above is still on the ledger: every unread merge has a receipt.`,
);

// (4) SNAP BACK — an autonomous merge is REVERTED in staging; review re-arms. ---
section(4, "SNAP BACK — an autonomously-merged fix is REVERTED in staging");
console.log(
  "  A fix merges autonomously (deferred: staging bake overnight), then staging\n" +
    "  reverts it — the change regressed a flow that CI did not cover:",
);
const tomorrow = new Date(EPOCH + 86_400_000).toISOString();
const deferred = await runFix(
  { id: "PROJ-1042", title: "refactor retry backoff", ci: "green", intentFit: true },
  "Fix PROJ-1042: refactor retry backoff (merged autonomously, staging-baked)",
  r,
  { deferUntil: tomorrow },
);
traceChange("PROJ-1042 (defer)", deferred);
console.log(
  `     sealed ${deferred.warrant.outcome!.result} — held out of trust until staging reports (SPEC §6).`,
);

console.log("\n     …overnight: staging REVERTS it. Re-sealing the Warrant with ground truth:");
const beforeRevert = r.trustOf(ACTOR, FIX);
const { after: afterRevert } = r.reseal(deferred.warrant.intent.id, "REVERTED", "staging-revert");
console.log(
  `       reversal: ${pad(beforeRevert.tier, 3)} → ${pad(afterRevert.tier, 3)} ` +
    `score ${beforeRevert.score.toFixed(3)} → ${afterRevert.score.toFixed(3)}` +
    (afterRevert.tier !== beforeRevert.tier ? `   (demotion — trust lost fast, I4)` : ``),
);
const reArmed = await runFix(
  { id: "PROJ-1043", title: "small fix (but trust just cratered)", ci: "green", intentFit: true },
  "Fix PROJ-1043: small low-risk fix (post-revert)",
);
traceChange("PROJ-1043", reArmed);
console.log(
  `\n     Trust fell to ${afterRevert.tier} — below the tier 'reversible.low' needs to\n` +
    `     merge unattended. So review SNAPPED BACK automatically on PROJ-1043.\n` +
    `     No rule was edited; the same call site is reviewed again.`,
);

// (5) STAKES GATE — a schema migration gates at every tier (I3). ----------------
section(5, "STAKES GATE — a code.migrate (irreversible.critical) GATES at every tier");
// Re-earn trust so the agent is demonstrably high on code.fix, to prove the gate
// on code.migrate is about the TASK's stakes, not low trust.
let reearn = 0;
while (r.trustOf(ACTOR, FIX).tier !== "T3" && reearn < 25) {
  await runFix(
    { id: `PROJ-13${reearn}`, title: `re-earn #${reearn + 1}`, ci: "green", intentFit: true },
    `Fix PROJ-13${reearn}: re-earn autonomy #${reearn + 1}`,
  );
  reearn += 1;
}
const highFixTrust = r.trustOf(ACTOR, FIX);
const migrateTrust = r.trustOf(ACTOR, MIGRATE);
console.log(
  `  The agent is high-trust on code.fix (${highFixTrust.tier}, score ${highFixTrust.score.toFixed(3)})\n` +
    `  after ${reearn} more clean fixes. But code.migrate is a SEPARATE scope — cold\n` +
    `  at ${migrateTrust.tier} (I1: scope isolation), and it is irreversible.critical:`,
);
const migration = await rReject.run(
  () => ({ ticket: "PROJ-2000", ci: "green" as const, intentFit: true, linesChanged: 3 }),
  {
    actor: ACTOR,
    taskType: MIGRATE,
    risk: "irreversible.critical",
    intent: "PROJ-2000: drop legacy `orders_v1` table (schema migration)",
    checks: [ciGreen, intentFit],
  },
);
console.log(
  `  PROJ-2000 (migration)      gate decided → ` +
    `REVIEW ↯ human paged (${migration.checkpoint!.altitude}, ${migration.checkpoint!.decision})`,
);
console.log(`     gate reason: ${migration.gateDecision.reason}`);
console.log(
  `     'irreversible.critical' is in never_recede[], so code.migrate keeps a\n` +
    `     checkpoint at EVERY tier (I3). Earned autonomy on code.fix NEVER leaks\n` +
    `     into a schema migration. The reviewer REJECTED this one.`,
);

// (6) REPLAY — reproduce the final trust state from stored Warrants (I2). -------
section(6, "REPLAY — reconstruct the exact final trust from the stored Warrants (I2)");
const storedFix = r.trustOf(ACTOR, FIX);
const replayedFix = r.replay(ACTOR, FIX);
const storedMig = r.trustOf(ACTOR, MIGRATE);
const replayedMig = r.replay(ACTOR, MIGRATE);
const exactFix =
  Math.abs(replayedFix.score - storedFix.score) < 1e-9 && replayedFix.tier === storedFix.tier;
const exactMig =
  Math.abs(replayedMig.score - storedMig.score) < 1e-9 && replayedMig.tier === storedMig.tier;
const exact = exactFix && exactMig;
console.log(`  (code-agent, code.fix)`);
console.log(`     stored   : tier=${storedFix.tier}  score=${storedFix.score.toFixed(9)}  n=${storedFix.sample_count}`);
console.log(`     replayed : tier=${replayedFix.tier}  score=${replayedFix.score.toFixed(9)}  n=${replayedFix.sample_count}`);
console.log(`  (code-agent, code.migrate)`);
console.log(`     stored   : tier=${storedMig.tier}  score=${storedMig.score.toFixed(9)}  n=${storedMig.sample_count}`);
console.log(`     replayed : tier=${replayedMig.tier}  score=${replayedMig.score.toFixed(9)}  n=${replayedMig.sample_count}`);
console.log(`     replay() == stored state, both scopes (invariant I2): ${exact ? "TRUE ✓" : "FALSE ✗"}`);
console.log(
  `     ${ledger.records().length} records on the ledger. "Why did that PR merge\n` +
    `     unattended?" is answered by pointing at the receipts — not a dashboard.`,
);

console.log("\n" + BAR);
console.log("  Trust is a trajectory, not a checkpoint. Review receded where the");
console.log("  evidence allowed, snapped back the instant staging turned, and never");
console.log("  receded on the migration at all.");
console.log(BAR + "\n");

if (!exact) {
  // Fail loud: the whole thesis rests on I2 holding.
  process.exitCode = 1;
}
