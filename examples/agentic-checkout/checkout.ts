// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Agentic checkout — a Nekuda-style signed mandate, wrapped in Recede.
 *
 * A shopping agent holds a MANDATE: a user-signed, scoped permission to spend
 * ("up to $200, at these merchants, before this date"). Nekuda's ACP-style
 * mandate answers "did the user actually mean it?" ex-ante. Recede answers the
 * question that comes AFTER the purchase clears: "should this agent keep
 * buying unattended?" — and it answers that from evidence, not from a config
 * flag. The mandate is the Warrant's Intent; Recede is what happens next.
 *
 * The story, in order:
 *
 *   (1) BASELINE     every checkout pauses for a human (cold start, T0).
 *   (2) EARNING TRUST  clean, in-mandate reorders accrue trust on their own lane.
 *   (3) RECEDES      a reorder runs unattended — Warrant still recorded.
 *   (4) CHARGEBACK   friendly fraud: a SUCCESS is reseal'd REVERTED after the
 *                    fact; trust re-folds and the checkpoint SNAPS BACK.
 *   (5) STEP-UP      a high-value, new-merchant purchase checkpoints EVERY
 *                    time — irreversible.critical is never_recede (I3).
 *
 * Imports the canonical TypeScript reference implementation from
 * ../../reference/ts — no protocol logic is reimplemented here. Zero runtime
 * dependencies; runs on Node's built-in type stripping (>= 22.6).
 *
 *   node checkout.ts
 */

import {
  Recede,
  MemoryLedger,
  check,
  fixedCheckpoint,
  type RunResult,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// The domain: an agentic-commerce mandate (Nekuda-style) and a purchase.
// ---------------------------------------------------------------------------

/** A user-signed, scoped spending permission — the pre-purchase contract. */
interface Mandate {
  id: string;
  capAmount: number;
  merchantAllowlist: string[];
  expiresAt: string;
  userSignature: string; // placeholder — real signature verification is out of scope here
}

interface PurchaseRequest {
  orderId: string;
  merchant: string;
  amount: number;
}

/** ponytail: a real ACP/gateway call (auth, capture, receipt) goes here; this
 * stub just echoes the charge back as "settled" so the demo has a result to
 * check. Upgrade path: swap this for the actual payment-gateway SDK call. */
function chargeMerchant(req: PurchaseRequest): { charged: number; merchant: string } {
  return { charged: req.amount, merchant: req.merchant };
}

// ---------------------------------------------------------------------------
// The trace helpers (mirrors examples/refund's formatting conventions).
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

function trace(label: string, out: RunResult<{ charged: number }>): void {
  const t = out.trust.after;
  const paged = out.checkpoint
    ? `CHECKPOINT ↯ human paged (${out.checkpoint.altitude}, ${out.checkpoint.decision})`
    : `autonomous · no human paged`;
  const delta = out.trust.after.score - out.trust.before.score;
  const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(3);
  console.log(
    `  ${pad(label, 26)} ${pad(t.tier, 4)} ` +
      `score=${t.score.toFixed(3)} (${pad(deltaStr, 7)}) ` +
      `n=${pad(String(t.sample_count), 3)} → ${paged}`,
  );
}

const EXPECTED_ASSERTIONS = 8;
let assertions = 0;
function assert(cond: boolean, msg: string): void {
  assertions += 1;
  if (!cond) {
    console.error(`\n  ✗ ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// The two V&V checks, mapped onto the mandate.
// ---------------------------------------------------------------------------

/** VERIFY (scope): the charge never exceeds the mandate's cap. */
const withinCap = check.verify<{ cap: number }, { charged: number }>(
  "charged<=mandate.cap",
  (io) => io.output.charged <= io.input.cap,
);

/** VERIFY (scope): the merchant is on the mandate's allowlist. */
const merchantAllowed = check.verify<{ allowlist: string[] }, { merchant: string }>(
  "merchant-on-allowlist",
  (io) => io.input.allowlist.includes(io.output.merchant),
);

/** VERIFY (scope): the settled total reconciles with the requested amount. */
const totalsReconcile = check.verify<{ requested: number }, { charged: number }>(
  "totals-reconcile",
  (io) => io.output.charged === io.input.requested,
);

/**
 * VALIDATE (right purchase): the ex-post "was this the right purchase?"
 * signal, taken at purchase time — a stand-in for a fraud/dispute service
 * confirming the purchase was kept, not disputed, when it settled. Actual
 * disputes arrive later, as a deferred outcome: see the chargeback beat's
 * `r.reseal()` call, which flips a settled SUCCESS to REVERTED after the
 * fact rather than routing through this check.
 */
const keptNotDisputed = check.validate<Record<string, never>, { charged: number }>(
  "kept-not-disputed",
  () => ({ ok: true, confidence: 0.85 }),
);

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

const ledger = new MemoryLedger();
const r = new Recede({ ledger, checkpoint: fixedCheckpoint("APPROVE", "cardholder") });

const ACTOR = "shopping-agent";
const CHECKOUT_TASK = "commerce.checkout";
const REORDER_TASK = "commerce.reorder";
const NEWMERCHANT_TASK = "commerce.newmerchant";

const mandate: Mandate = {
  id: "mandate-9f2a",
  capAmount: 60,
  merchantAllowlist: ["acme-coffee", "acme-office"],
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  userSignature: "sig:placeholder",
};

async function purchase(
  taskType: string,
  req: PurchaseRequest,
): Promise<RunResult<{ charged: number }>> {
  return r.run(() => chargeMerchant(req), {
    actor: ACTOR,
    taskType,
    intent: `order ${req.orderId}: buy from ${req.merchant} for $${req.amount} under mandate ${mandate.id}`,
    risk: "financial.reversible",
    input: {
      cap: mandate.capAmount,
      allowlist: mandate.merchantAllowlist,
      requested: req.amount,
    },
    checks: [withinCap, merchantAllowed, totalsReconcile, keptNotDisputed],
  });
}

console.log("\n" + BAR);
console.log("  RECEDE — the agentic checkout story");
console.log(`  actor=${ACTOR}  mandate=${mandate.id} cap=$${mandate.capAmount}  policy=${r.policy.id}@${r.policy.version}`);
console.log(BAR);
console.log(
  "  The mandate is the Warrant's Intent — a user-signed, scoped spending\n" +
    "  permission (Nekuda-style). It answers 'did you actually mean it?' before\n" +
    "  the purchase. Recede answers what comes after: should this agent keep\n" +
    "  buying unattended? That answer comes from evidence, not a config flag.",
);

// (1) BASELINE — every checkout pauses for a human at cold start. -------------
section(1, "BASELINE — cold start (T0): every checkout stops for a human");
const first = await purchase(CHECKOUT_TASK, { orderId: "CO-1001", merchant: "acme-coffee", amount: 12 });
trace("checkout #1", first);
assert(first.checkpoint !== undefined, "T0 checkout must checkpoint (card-not-present, human-not-present)");
console.log(`     gate reason: ${first.gateDecision.reason}`);
console.log(
  "     Card-not-present, human-not-present — the mandate alone doesn't buy\n" +
    "     autonomy. Every purchase on this lane stops for the cardholder.",
);

// (2) EARNING TRUST — clean, in-mandate reorders compound trust on their own
//     lane (commerce.reorder is scoped separately from commerce.checkout —
//     trust is per (actor, task_type), not per actor). ------------------------
section(2, "EARNING TRUST — clean, in-mandate reorders compound trust");
let last = await purchase(REORDER_TASK, { orderId: "RO-0001", merchant: "acme-coffee", amount: 12 });
let firstAutonomous = -1;
trace("reorder #1", last);
for (let i = 2; i <= 30; i++) {
  last = await purchase(REORDER_TASK, { orderId: `RO-${String(i).padStart(4, "0")}`, merchant: "acme-coffee", amount: 12 });
  if (firstAutonomous === -1 && !last.checkpoint) firstAutonomous = i;
  if (i === 5 || i === firstAutonomous || i === 20 || i === 30) trace(`reorder #${i}`, last);
}
assert(firstAutonomous > 0, "reorders must eventually stop paging a human on commerce.reorder");
console.log(
  `\n     Oversight receded at reorder #${firstAutonomous}: the same mandate, the same call\n` +
    `     site — only the evidence on commerce.reorder changed.`,
);

// (3) OVERSIGHT RECEDES — same mandate, same code, no checkpoint fires. -------
section(3, "OVERSIGHT RECEDES — a reorder executes autonomously, Warrant still recorded");
const auto = await purchase(REORDER_TASK, { orderId: "RO-0031", merchant: "acme-coffee", amount: 12 });
trace("reorder (auto)", auto);
assert(auto.checkpoint === undefined, "a receded reorder must run with outcome.checkpoint undefined");
assert(auto.warrant.outcome !== undefined, "the Warrant must still be sealed even when autonomous");
console.log(
  "     No human saw this reorder. The Warrant above is still on the ledger —\n" +
    "     receded oversight is not unaudited oversight.",
);

// (4) FRIENDLY FRAUD — a chargeback lands on a purchase that already SUCCEEDED
//     and settled autonomously. This is the "card not present, human not
//     present" gap: the buyer got the goods, then disputed the charge anyway.
//     Reseal flips SUCCESS -> REVERTED and the negative evidence re-folds. ----
section(4, "FRIENDLY FRAUD — a chargeback reseals a settled purchase, trust re-folds");
const trustBeforeChargeback = r.trustOf(ACTOR, REORDER_TASK);
const disputed = await purchase(REORDER_TASK, { orderId: "RO-0032", merchant: "acme-coffee", amount: 12 });
trace("reorder (disputed)", disputed);
assert(disputed.warrant.outcome?.result === "SUCCESS", "the disputed purchase must have settled SUCCESS before the chargeback lands");

console.log("\n     …days later: the cardholder disputes the charge. Reseal:");
const { before: cbBefore, after: cbAfter } = r.reseal(
  disputed.warrant.intent.id,
  "REVERTED",
  "chargeback-friendly-fraud",
);
assert(cbAfter.score < cbBefore.score, "a chargeback reseal must lower trust (asymmetric loss, I4)");
console.log(
  `     reseal SUCCESS → REVERTED: ${pad(cbBefore.tier, 3)} → ${pad(cbAfter.tier, 3)} ` +
    `score ${cbBefore.score.toFixed(3)} → ${cbAfter.score.toFixed(3)}` +
    (cbAfter.tier !== cbBefore.tier ? "   (demotion)" : ""),
);

const snapBack = await purchase(REORDER_TASK, { orderId: "RO-0033", merchant: "acme-coffee", amount: 12 });
trace("reorder (post-chargeback)", snapBack);
assert(snapBack.checkpoint !== undefined, "the checkpoint must SNAP BACK on the next reorder once trust drops below the autonomy floor");
console.log(
  `\n     Trust fell from ${trustBeforeChargeback.tier} territory to ${cbAfter.tier} — below the floor\n` +
    "     'financial.reversible' needs to run unattended. The checkpoint\n" +
    "     re-armed automatically. No rule was edited; one bad chargeback bought\n" +
    "     back human review.",
);

// (5) STEP-UP — a high-value, new-merchant purchase checkpoints EVERY time,
//     no matter how much trust the agent has earned elsewhere. This lane
//     declares 'irreversible.critical' risk, which is never_recede in the
//     default policy (I3) — the reference floor a mandate cannot buy past. ---
section(5, "STEP-UP — a high-value, new-merchant purchase always checkpoints");
const rejectHandler = new Recede({ ledger, policy: r.policy, checkpoint: fixedCheckpoint("REJECT", "cardholder") });
let newMerchantGatedEveryTime = true;
for (let i = 1; i <= 3; i++) {
  const engine = i === 1 ? r : rejectHandler;
  const before = r.trustOf(ACTOR, NEWMERCHANT_TASK);
  const stepUp = await engine.run(
    () => chargeMerchant({ orderId: `NM-000${i}`, merchant: "unknown-electronics-shop", amount: 900 }),
    {
      actor: ACTOR,
      taskType: NEWMERCHANT_TASK,
      intent: `order NM-000${i}: $900 at a merchant NOT on mandate ${mandate.id}'s allowlist`,
      risk: "irreversible.critical",
      input: { cap: mandate.capAmount, allowlist: mandate.merchantAllowlist, requested: 900 },
      checks: [withinCap, merchantAllowed, totalsReconcile, keptNotDisputed],
    },
  );
  if (!stepUp.checkpoint) newMerchantGatedEveryTime = false;
  const paged = stepUp.checkpoint
    ? `CHECKPOINT ↯ human paged (${stepUp.checkpoint.altitude}, ${stepUp.checkpoint.decision})`
    : "autonomous · no human paged";
  console.log(`  new-merchant #${i}            was ${before.tier}   → ${paged}`);
}
assert(newMerchantGatedEveryTime, "a never_recede risk class must checkpoint at every tier, regardless of trust");
console.log(
  "\n     Cap breached AND merchant off-allowlist AND irreversible.critical —\n" +
    "     step-up authentication every time. A mandate scopes what an agent MAY\n" +
    "     try; never_recede decides what NEVER stops needing a human, no matter\n" +
    "     how much trust the same actor has banked on other lanes (I3).",
);

console.log("\n" + BAR);
const ranBeforeFinalCheck = assertions;
assert(ranBeforeFinalCheck === EXPECTED_ASSERTIONS, `expected ${EXPECTED_ASSERTIONS} assertions to have run, got ${ranBeforeFinalCheck}`);
console.log(`  ${ranBeforeFinalCheck}/${EXPECTED_ASSERTIONS} assertions passed. Nekuda makes agents able to pay;`);
console.log("  Recede makes good behavior pay.");
console.log(BAR + "\n");
