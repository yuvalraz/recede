// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The killer example: a refund bot earns autonomy, then a fraud reversal snaps
 * oversight back — with no rule edited. Run: `node demo.ts`.
 */

import { Recede, MemoryLedger, check, autoApprove } from "./src/index.ts";

const r = new Recede({ ledger: new MemoryLedger(), checkpoint: autoApprove("reviewer") });

const amountOK = check.verify<{ orderTotal: number }, { amount: number }>(
  "amount<=orderTotal",
  (io) => io.output.amount <= io.input.orderTotal,
);
const policyOK = check.validate("policy-judge", async () => ({ ok: true, confidence: 0.9 }));

const base = {
  actor: "billing-bot",
  taskType: "refund.issue",
  risk: "reversible.low",
  input: { orderTotal: 100 },
  checks: [amountOK, policyOK],
} as const;

function line(tag: string, msg: string) {
  console.log(`${tag.padEnd(10)} ${msg}`);
}

// Day 1: gated.
const first = await r.run(() => ({ amount: 12 }), { ...base, intent: "refund #1 duplicate charge" });
line("day 1", `tier=${first.trust.after.tier}  checkpoint=${first.checkpoint ? "FIRED" : "none"}`);

// Accrue clean runs; watch the gate recede.
let last = first;
for (let i = 2; i <= 45; i++) {
  last = await r.run(() => ({ amount: 12 }), { ...base, intent: `refund #${i}` });
}
line("~45 runs", `tier=${last.trust.after.tier}  score=${last.trust.after.score.toFixed(2)}  checkpoint=${last.checkpoint ? "FIRED" : "RECEDED (autonomous)"}`);

// High stakes still gate, even at high trust (never_recede floor).
const crit = await r.run(() => ({ amount: 2000 }), {
  ...base,
  intent: "refund #46 — $2000 to abuse-flagged account",
  risk: "irreversible.critical",
});
line("high-risk", `checkpoint=${crit.checkpoint ? "FIRED (stakes gate regardless)" : "none"}`);

// A deferred run gets REVERTED by a next-day fraud check — trust snaps back.
const deferred = await r.run(() => ({ amount: 12 }), {
  ...base,
  intent: "refund #47 (fraud-checked next day)",
  deferUntil: new Date(Date.now() + 86_400_000).toISOString(),
});
line("defer", `outcome=${deferred.warrant.outcome!.result}  trust held at ${deferred.trust.after.tier}`);

const beforeReseal = r.trustOf("billing-bot", "refund.issue");
const { after } = r.reseal(deferred.warrant.intent.id, "REVERTED", "next-day-fraud-check");
line("reseal", `REVERTED: tier ${beforeReseal.tier} -> ${after.tier}  score ${beforeReseal.score.toFixed(2)} -> ${after.score.toFixed(2)}`);

// Auditability: replay reproduces the exact stored trust.
const replayed = r.replay("billing-bot", "refund.issue");
line("replay", `reproduced score ${replayed.score.toFixed(6)} == stored ${after.score.toFixed(6)}: ${Math.abs(replayed.score - after.score) < 1e-9}`);
