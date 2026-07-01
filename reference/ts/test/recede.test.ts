// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// End-to-end: the run() front door, the killer refund story, deferred re-fold,
// checkpoint firing, and the FileLedger round-trip.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Recede,
  MemoryLedger,
  FileLedger,
  check,
  autoApprove,
  fixedCheckpoint,
} from "../src/index.ts";

// A deterministic clock so ids and outputs are reproducible.
function seqClock() {
  let n = 0;
  return () => new Date(1_700_000_000_000 + n++ * 1000).toISOString();
}

test("run(): the gate is implicit — checkpoint fires early, recedes with evidence", async () => {
  const r = new Recede({ ledger: new MemoryLedger(), checkpoint: autoApprove(), now: seqClock() });
  const amountOK = check.verify<{ orderTotal: number }, { amount: number }>(
    "amount",
    (io) => io.output.amount <= io.input.orderTotal,
  );
  const policyOK = check.validate("policy", async () => ({ ok: true, confidence: 0.9 }));

  const opts = {
    actor: "billing-bot",
    taskType: "refund.issue",
    intent: "refund duplicate charge",
    risk: "reversible.low",
    input: { orderTotal: 100 },
    checks: [amountOK, policyOK],
  } as const;

  const first = await r.run(() => ({ amount: 10 }), opts);
  assert.ok(first.checkpoint, "Day 1: reversible.low at T0/T1 gates");

  // Accrue clean runs until the scope reaches T2 (low-risk autonomous).
  let last = first;
  for (let i = 0; i < 40; i++) last = await r.run(() => ({ amount: 10 }), opts);

  assert.equal(last.checkpoint, undefined, "later: small clean refunds proceed autonomously");
  assert.ok(last.trust.after.tier === "T2" || last.trust.after.tier === "T3");
});

test("run(): high stakes always gate even at high trust (never_recede)", async () => {
  const r = new Recede({ ledger: new MemoryLedger(), checkpoint: autoApprove(), now: seqClock() });
  const opts = {
    actor: "billing-bot",
    taskType: "refund.issue",
    intent: "small refund",
    risk: "reversible.low",
    checks: [check.verify("ok", () => true)],
  } as const;
  for (let i = 0; i < 60; i++) await r.run(() => ({}), opts);

  // Now a critical, irreversible action on the SAME scope — must gate.
  const crit = await r.run(() => ({}), {
    ...opts,
    intent: "irreversible payout to flagged account",
    risk: "irreversible.critical",
  });
  assert.ok(crit.checkpoint, "high stakes gate regardless of accrued trust (I3)");
});

test("run(): replay() over stored warrants equals the stored trust (I2 through the class)", async () => {
  const r = new Recede({ ledger: new MemoryLedger(), checkpoint: autoApprove(), now: seqClock() });
  const opts = {
    actor: "bot",
    taskType: "email.draft",
    intent: "draft reply",
    risk: "read.only",
    checks: [check.verify("ok", () => true), check.validate("j", async () => ({ ok: true, confidence: 0.8 }))],
  } as const;
  let last;
  for (let i = 0; i < 20; i++) last = await r.run(() => ({}), opts);

  const replayed = r.replay("bot", "email.draft");
  assert.equal(replayed.tier, last!.trust.after.tier);
  assert.ok(Math.abs(replayed.score - last!.trust.after.score) < 1e-12);
  assert.equal(replayed.sample_count, last!.trust.after.sample_count);
});

test("run(): a REJECT aborts execution and does not run the wrapped fn", async () => {
  let ran = false;
  const r = new Recede({
    ledger: new MemoryLedger(),
    checkpoint: fixedCheckpoint("REJECT", "human"),
    now: seqClock(),
  });
  const res = await r.run(
    () => {
      ran = true;
      return { did: "work" };
    },
    { actor: "bot", taskType: "refund.issue", intent: "sketchy refund", risk: "reversible.low" },
  );
  assert.equal(ran, false, "rejected action must not execute");
  assert.equal(res.result, undefined);
  assert.ok(res.trust.after.score <= res.trust.before.score);
});

test("run(): MODIFY substitutes the human-edited value and is scored as a proposal failure", async () => {
  const r = new Recede({
    ledger: new MemoryLedger(),
    checkpoint: fixedCheckpoint("MODIFY", "human", { amount: 5 }),
    now: seqClock(),
  });
  const res = await r.run(() => ({ amount: 999 }), {
    actor: "bot",
    taskType: "refund.issue",
    intent: "over-large refund",
    risk: "reversible.low",
  });
  assert.deepEqual(res.result, { amount: 5 }, "human-edited value is used");
});

test("deferred outcome: UNRESOLVED holds trust, reseal REVERTED re-folds negative evidence", async () => {
  const r = new Recede({ ledger: new MemoryLedger(), checkpoint: autoApprove(), now: seqClock() });
  const opts = {
    actor: "bot",
    taskType: "refund.issue",
    intent: "refund",
    risk: "read.only",
    checks: [check.verify("ok", () => true)],
  } as const;

  // Prime some clean successes.
  let primed;
  for (let i = 0; i < 15; i++) primed = await r.run(() => ({}), opts);
  const beforeDefer = primed!.trust.after.score;

  // A deferred run: sealed UNRESOLVED, must NOT move trust yet.
  const deferred = await r.run(() => ({}), { ...opts, deferUntil: "2100-01-01T00:00:00.000Z" });
  assert.equal(deferred.warrant.outcome!.result, "UNRESOLVED");
  assert.ok(
    Math.abs(deferred.trust.after.score - beforeDefer) < 1e-12,
    "UNRESOLVED outcome holds trust steady",
  );

  // Ground truth arrives: the next-day check flips it to REVERTED.
  const intentId = deferred.warrant.intent.id;
  const { before, after } = r.reseal(intentId, "REVERTED", "next-day-fraud-check");
  assert.ok(after.score < before.score, "re-folded REVERTED lowers trust");

  // And replay reproduces the re-folded state (I2 with a superseding outcome).
  const replayed = r.replay("bot", "refund.issue");
  assert.ok(Math.abs(replayed.score - after.score) < 1e-12);
});

test("FileLedger: append-only file survives a reopen and replays to the same trust", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-"));
  const path = join(dir, "ledger.jsonl");

  const r1 = new Recede({ ledger: new FileLedger(path), checkpoint: autoApprove(), now: seqClock() });
  const opts = {
    actor: "bot",
    taskType: "refund.issue",
    intent: "refund",
    risk: "read.only",
    checks: [check.verify("ok", () => true)],
  } as const;
  let last;
  for (let i = 0; i < 12; i++) last = await r1.run(() => ({}), opts);
  const storedScore = last!.trust.after.score;

  // Reopen from disk — a fresh Recede over the same file.
  const r2 = new Recede({ ledger: new FileLedger(path), checkpoint: autoApprove() });
  const reloaded = r2.trustOf("bot", "refund.issue");
  assert.ok(Math.abs(reloaded.score - storedScore) < 1e-12, "trust snapshot survives reopen");

  const replayed = r2.replay("bot", "refund.issue");
  assert.ok(Math.abs(replayed.score - storedScore) < 1e-12, "records replay to the same trust");
  assert.equal(r2.ledger.warrantsFor("bot", "refund.issue").length, 12);
});
