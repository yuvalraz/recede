// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The KILLER EXAMPLE — the refund story from the Recede README, end to end.
 *
 * A support agent (`billing-bot`) issues refunds. Nothing about the CALL SITE
 * changes across this whole run: it is always the same `r.run(issueRefund, …)`.
 * What changes is what the *evidence* has earned. We watch, in order:
 *
 *   (1) BASELINE       every refund pauses at a human checkpoint (cold start, T0).
 *   (2) EARNING TRUST  clean, verified + validated refunds accrue trust.
 *   (3) OVERSIGHT      RECEDES — small policy-clean refunds now run autonomously;
 *                      no checkpoint fires, but a Warrant is still recorded.
 *   (4) STAKES GATE    a $2,000 abuse-flagged refund still GATES at high trust
 *                      (irreversible.critical is never_recede — invariant I3).
 *   (5) SNAP BACK      three autonomous refunds are REVERTED by a next-day fraud
 *                      check; trust craters below the tier floor and the gate
 *                      re-arms automatically — no rule was edited.
 *   (6) REPLAY         replay() over the stored Warrants reproduces the exact
 *                      final trust state (invariant I2) — the audit answer to
 *                      "why was this allowed to run unattended?".
 *
 * This file imports the canonical TypeScript reference implementation from
 * ../../reference/ts — it does not reimplement any protocol logic. Zero runtime
 * dependencies; runs on Node's built-in type stripping (>= 22.6).
 *
 *   node refund.ts
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
// The domain: a tiny refund "agent". This is the function you already have —
// Recede wraps it; it knows nothing about trust, gates, or checkpoints.
// ---------------------------------------------------------------------------

interface Order {
  id: string;
  total: number;
}

/** Issue a refund for the whole order total. (In real life: a payments call.) */
function issueRefund(order: Order): { amount: number; order: string } {
  return { amount: order.total, order: order.id };
}

// ---------------------------------------------------------------------------
// The two V&V checks. Verify = "did it do the thing right"; Validate = "did it
// do the *right* thing". Splitting them is how confidently-wrong output is
// caught (SPEC section 5). Both are declarative and passed to r.run().
// ---------------------------------------------------------------------------

/** VERIFY (schema/arithmetic): the refund never exceeds the order total. */
const amountWithinTotal = check.verify<{ orderTotal: number }, { amount: number }>(
  "amount<=orderTotal",
  (io) => io.output.amount <= io.input.orderTotal,
);

/**
 * VALIDATE (policy/intent): a stand-in for an LLM-as-judge or fraud service.
 * Small, unflagged refunds pass with high confidence; a large/abuse-flagged
 * refund is judged NOT the right thing to do.
 */
const policyJudge = check.validate<{ orderTotal: number; flagged?: boolean }, { amount: number }>(
  "fraud-policy-judge",
  async (io) => {
    const flagged = io.input.flagged === true;
    const large = io.output.amount >= 1000;
    if (flagged || large) return { ok: false, confidence: 0.95 };
    return { ok: true, confidence: 0.9 };
  },
);

// ---------------------------------------------------------------------------
// Pretty-printing the trace. The point of Recede is that a human sees LESS as
// trust grows, so the trace is explicit about what a reviewer would (or would
// not) have been paged for on each action.
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

/** One legible line per refund: what happened + whether a human was paged. */
function traceRefund(label: string, out: RunResult<{ amount: number }>): void {
  const t = out.trust.after;
  const paged = out.checkpoint
    ? `CHECKPOINT ↯ human paged (${out.checkpoint.altitude}, ${out.checkpoint.decision})`
    : `autonomous · no human paged`;
  const delta = (out.trust.after.score - out.trust.before.score);
  const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(3);
  console.log(
    `  ${pad(label, 22)} ${pad(t.tier, 4)} ` +
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

// The reviewer approves small, policy-clean refunds at checkpoints (the day-1
// rubber-stamp risk is exactly what Recede exists to *remove* — here every
// APPROVE is honest, small, fast). We build one Recede on this handler, and a
// second view of the SAME ledger + policy whose reviewer REJECTS — that is the
// human catching the abuse-flagged $2,000 refund in beat 4.
const r = new Recede({ ledger, checkpoint: fixedCheckpoint("APPROVE", "reviewer") });
const rReject = new Recede({
  ledger,
  policy: r.policy,
  checkpoint: fixedCheckpoint("REJECT", "reviewer"),
});

const ACTOR = "billing-bot";
const TASK = "refund.issue";

// The call site never changes. Only `intent`/`risk`/`input` describe THIS refund.
const base = {
  actor: ACTOR,
  taskType: TASK,
  risk: "financial.reversible",
  checks: [amountWithinTotal, policyJudge],
} as const;

async function runRefund(
  order: Order,
  intent: string,
  extra: { flagged?: boolean; risk?: string; deferUntil?: string; engine?: Recede } = {},
): Promise<RunResult<{ amount: number }>> {
  const engine = extra.engine ?? r;
  return engine.run(() => issueRefund(order), {
    ...base,
    intent,
    risk: extra.risk ?? base.risk,
    input: { orderTotal: order.total, flagged: extra.flagged },
    ...(extra.deferUntil ? { deferUntil: extra.deferUntil } : {}),
  });
}

console.log("\n" + BAR);
console.log("  RECEDE — the refund story");
console.log("  actor=billing-bot  task=refund.issue  policy=recede.reference@0.1.0");
console.log(BAR);
console.log(
  "  Trust is scoped to (actor, task_type). It moves ONLY through sealed\n" +
    "  Warrants. The gate is a PURE function of (trust, risk, policy): no\n" +
    "  `if (needsApproval)` lives in the agent — run() decides, replayably.",
);

// (1) BASELINE — cold start at T0, every refund is gated. ---------------------
section(1, "BASELINE — cold start (T0): every refund pauses for a human");
const first = await runRefund({ id: "A-1001", total: 12 }, "refund #1 — duplicate charge");
traceRefund("refund #1", first);
console.log(`     warrant: ${warrantChain(first.warrant)}`);
console.log(
  `     gate reason: ${first.gateDecision.reason}\n` +
    `     policy_digest pinned on the decision (I6): ${first.gateDecision.policy_digest.slice(0, 16)}…`,
);

// (2) EARNING TRUST — clean verified + validated refunds accrue. ---------------
section(2, "EARNING TRUST — clean, verified + validated refunds accrue trust");
let last = first;
let firstAutonomous = -1;
for (let i = 2; i <= 40; i++) {
  last = await runRefund({ id: `A-10${String(i).padStart(2, "0")}`, total: 12 }, `refund #${i}`);
  if (firstAutonomous === -1 && !last.checkpoint) firstAutonomous = i;
  // Print a few milestones so the trace stays legible rather than 40 lines.
  if (i === 2 || i === 5 || i === firstAutonomous || i === 20 || i === 40) {
    traceRefund(`refund #${i}`, last);
  }
}
console.log(
  `\n     Oversight receded at refund #${firstAutonomous}: that is the exact run where\n` +
    `     the (RiskClass × Tier) matrix flips 'financial.reversible' to AUTONOMOUS.`,
);

// (3) OVERSIGHT RECEDES — same call site, now runs unattended. -----------------
section(3, "OVERSIGHT RECEDES — same code, no checkpoint, Warrant still recorded");
const auto = await runRefund({ id: "A-1041", total: 12 }, "refund #41 — small, policy-clean");
traceRefund("refund #41", auto);
console.log(`     warrant: ${warrantChain(auto.warrant)}`);
console.log(
  `     The reviewer saw NOTHING for this refund — and that is the product\n` +
    `     working. The Warrant above is still on the ledger for audit.`,
);

// (4) STAKES GATE — high-stakes refund gates even at high trust (I3). ----------
section(4, "STAKES GATE — a $2,000 abuse-flagged refund GATES even at high trust");
const beforeCrit = r.trustOf(ACTOR, TASK);
// Same call site, same high trust — but risk = irreversible.critical, flagged.
// The reviewer (rReject) sees the fraud flag and REJECTS: the human catch.
const crit = await runRefund(
  { id: "A-9999", total: 2000 },
  "refund #42 — $2,000 to an abuse-flagged account",
  { flagged: true, risk: "irreversible.critical", engine: rReject },
);
console.log(
  `  refund #42 ($2000)     gate decided at ${pad(beforeCrit.tier, 4)} score=${beforeCrit.score.toFixed(3)} → ` +
    `CHECKPOINT ↯ human paged (${crit.checkpoint!.altitude}, ${crit.checkpoint!.decision})`,
);
console.log(`     trust was HIGH (${beforeCrit.tier}, score ${beforeCrit.score.toFixed(3)}) — yet the checkpoint FIRED.`);
console.log(`     gate reason: ${crit.gateDecision.reason}`);
console.log(
  `     'irreversible.critical' is in never_recede[], so it retains a checkpoint\n` +
    `     at EVERY tier (I3). The reviewer REJECTED it — attention spent exactly\n` +
    `     where uncertainty × stakes is highest. (That REJECT also dents trust: ` +
    `${beforeCrit.tier}→${crit.trust.after.tier}.)`,
);

// (5) SNAP BACK — deferred outcomes get REVERTED; the gate re-arms. -------------
section(5, "SNAP BACK — three autonomous refunds REVERTED by a next-day fraud check");
// The REJECT in beat 4 nudged trust down a tier; a few more clean refunds
// re-earn T3, so the deferred trio all run autonomously (that is the setup for
// the snap-back to be dramatic).
let reearn = 0;
while (r.trustOf(ACTOR, TASK).tier !== "T3" && reearn < 20) {
  await runRefund({ id: `A-13${reearn}`, total: 12 }, `refund (re-earn #${reearn + 1})`);
  reearn += 1;
}
const backToT3 = r.trustOf(ACTOR, TASK);
console.log(
  `  ${reearn} clean refunds re-earned autonomy → back to ${backToT3.tier} ` +
    `(score ${backToT3.score.toFixed(3)}). Now three refunds run UNATTENDED, deferred\n` +
    `  to a next-day fraud check:`,
);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
const deferredIds: string[] = [];
for (let i = 43; i <= 45; i++) {
  const d = await runRefund(
    { id: `A-11${i}`, total: 12 },
    `refund #${i} — ran autonomously, fraud-checked tomorrow`,
    { deferUntil: tomorrow },
  );
  traceRefund(`refund #${i} (defer)`, d);
  console.log(
    `     sealed ${d.warrant.outcome!.result} — held out of trust until ground truth arrives (SPEC §6).`,
  );
  deferredIds.push(d.warrant.intent.id);
}

console.log("\n     …next day: the fraud service REVERSES all three. Re-sealing each Warrant:");
for (let k = 0; k < deferredIds.length; k++) {
  const { before: b, after: a } = r.reseal(deferredIds[k], "REVERTED", "next-day-fraud-check");
  console.log(
    `       reversal ${k + 1}: ${pad(b.tier, 3)} → ${pad(a.tier, 3)} ` +
      `score ${b.score.toFixed(3)} → ${a.score.toFixed(3)}` +
      (a.tier !== b.tier ? `   (demotion — trust lost fast, I4)` : ``),
  );
}

const afterReversals = r.trustOf(ACTOR, TASK);
const reArmed = await runRefund(
  { id: "A-1200", total: 12 },
  "refund #46 — small, policy-clean (but trust has cratered)",
);
traceRefund("refund #46", reArmed);
console.log(
  `\n     Trust fell to ${afterReversals.tier} — below the T3 floor 'financial.reversible'\n` +
    `     needs to run unattended. So the checkpoint SNAPPED BACK automatically on\n` +
    `     refund #46. No rule was edited; the same call site is gated again.`,
);

// (6) REPLAY — reproduce the final trust state from stored Warrants (I2). -------
section(6, "REPLAY — reconstruct the exact final trust from the stored Warrants (I2)");
const stored = r.trustOf(ACTOR, TASK);
const replayed = r.replay(ACTOR, TASK);
const exact = Math.abs(replayed.score - stored.score) < 1e-9 && replayed.tier === stored.tier;
console.log(`     stored   : tier=${stored.tier}  score=${stored.score.toFixed(9)}  n=${stored.sample_count}`);
console.log(`     replayed : tier=${replayed.tier}  score=${replayed.score.toFixed(9)}  n=${replayed.sample_count}`);
console.log(`     replay() == stored state (invariant I2): ${exact ? "TRUE ✓" : "FALSE ✗"}`);
console.log(
  `     ${ledger.records().length} records on the ledger. "Why did this run unattended?"\n` +
    `     is answered by pointing at the receipts — not by trusting a dashboard.`,
);

console.log("\n" + BAR);
console.log("  Trust is a trajectory, not a checkpoint. Oversight receded where the");
console.log("  evidence allowed, and snapped back the instant the evidence turned.");
console.log(BAR + "\n");

if (!exact) {
  // Fail loud: the whole thesis rests on I2 holding.
  process.exitCode = 1;
}
