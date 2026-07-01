<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# Recede — TypeScript reference implementation

The **primary, canonical** implementation of the [Recede protocol](../../SPEC.md):
evidence-earned, risk-gated trust for human/agent oversight. **Zero runtime
dependencies.** Tests run on the built-in `node:test` runner — no `npm install`.

> Trust is a trajectory, not a checkpoint. Oversight recedes exactly where the
> evidence says it can, and snaps back the instant the evidence turns.

## Requirements

Modern Node (**≥ 22.6**, tested on 26). This package ships `.ts` sources that
Node runs directly via built-in type stripping — no build step, no `tsc`. A
`tsconfig.json` is included for type-checking if you have TypeScript installed.

## Quickstart

```bash
node --test "test/*.test.ts"   # run the conformance + behavior suite
node demo.ts                    # run the killer refund example
```

```ts
import { Recede, MemoryLedger, check, consoleCheckpoint, defaultPolicy } from "recede";

const r = new Recede({
  ledger: new MemoryLedger(),
  checkpoint: consoleCheckpoint(),   // the CLI human-decision surface
  policy: defaultPolicy(),
});

const amountOK = check.verify("amount", io => io.output.amount <= io.input.orderTotal);
const policyOK = check.validate("policy", async io => ({ ok: true, confidence: 0.9 }));

const out = await r.run(() => issueRefund(order), {
  actor: "billing-bot",
  taskType: "refund.issue",
  intent: `Refund order ${order.id} — duplicate charge`,
  risk: "reversible.low",
  input: { orderTotal: order.total },
  checks: [amountOK, policyOK],
});

out.result;      // the step's return value (or the human-edited value on MODIFY)
out.trust;       // { before, after, delta } for (billing-bot, refund.issue)
out.checkpoint;  // undefined when it ran autonomously — that's the product working
out.warrant;     // the hash-linked evidence chain
```

The gate is **implicit**: there is no `if (needsApproval)` in your code. As the
ledger accrues verified, validated runs, that same call site graduates from
"always ask a human" to "proceed autonomously" — and reverts on regression.

## The eight core operations

`open · gate · act · check · checkpoint · seal · update · replay`. `run()`
composes all eight; you can also call them directly. **`gate`, `update`, and
`replay` are PURE** (I7): same inputs, same output, no side effects — which is
what makes "oversight recedes as trust is earned" a *provable* property.

```ts
import { open, gate, act, seal, update, replay, defaultPolicy } from "recede";

const policy = defaultPolicy();
const decision = gate(trustState, "financial.reversible", policy);
// -> { autonomous, altitude?, reason, policy_digest }   (I6: pins the policy)
```

## What's in `src/`

| File | Responsibility |
|---|---|
| `hash.ts` | Canonical serialization + content-addressing (`id = hash(canonical(record))`). |
| `records.ts` | The wire model + record constructors; Warrant assembly. |
| `policy.ts` | Tiers T0–T4, the `(RiskClass × Tier)` matrix, `never_recede`, policy digest, `defaultPolicy()`. |
| `gate.ts` | The **pure** gate — receding oversight (I3, I6, I7). |
| `weighting.ts` | Reference weighting: asymmetric earn/lose, time+drift decay, near-miss ratchet, confidence cap (I5). |
| `trust.ts` | The **pure** `update()` / `replay()` reducers + `TrustState` (I1, I2, I4). |
| `ledger.ts` | `MemoryLedger` and an append-only-file `FileLedger` (JSON Lines). |
| `checkpoint.ts` | `consoleCheckpoint()` CLI surface + non-interactive handlers. |
| `check.ts` | The ergonomic `check.verify` / `check.validate` builders. |
| `recede.ts` | The `Recede` class + `run()` front door + deferred `reseal()`. |
| `index.ts` | Public surface. |

## Invariants (proved in `test/`)

- **I1** scope isolation · **I2** replay reconstructability · **I3** irreversible
  floor / never-recede · **I4** trust can decrease · **I5** confidence cap ·
  **I6** policy-digest on every decision · **I7** gate/update/replay purity.

`test/invariants.test.ts` proves I1–I7 directly; `test/weighting.test.ts` proves
the reference weighting (asymmetric earn/lose, decay+drift, near-miss ratchet,
trust-theater guard, matrix monotonicity); `test/recede.test.ts` proves the
front door end-to-end, including deferred-outcome re-folding and the file
ledger round-trip.

## License

Apache-2.0 © 2026 Yuval Raz.
