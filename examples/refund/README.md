<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# The higher-stakes frontier — the refund story

> **This is the frontier, not the starting point.** A refund agent moves money
> and touches customers — the *same* Recede protocol, but a harder task to
> validate and a higher blast radius when it's wrong. **For the everyday case,
> start with [`examples/sdlc`](../sdlc)** — a coding agent earning trust across a
> backlog, which is where most teams feel review fatigue today. Come here once
> that story is clear, to see the identical protocol hold under higher stakes.

The [Recede README](../../README.md) tells a 30-second story: a refund bot earns
autonomy from evidence, high stakes still gate, and a next-day fraud reversal
snaps oversight back — **with no rule edited**. This folder is that story, made
runnable. It imports the canonical [TypeScript reference implementation](../../reference/ts)
and reimplements none of the protocol.

**Zero runtime dependencies.** Runs on Node's built-in TypeScript type stripping.

## Run it

```bash
node refund.ts        # from this directory; requires Node >= 22.6 (tested on 26)
```

## What you'll watch

The call site never changes — it is always the same `r.run(() => issueRefund(order), …)`.
What changes is what the *evidence* has earned. The trace walks six beats:

| # | Beat | What the trace shows |
|---|------|----------------------|
| 1 | **Baseline** | Cold start at tier **T0**: every refund pauses at a human checkpoint. |
| 2 | **Earning trust** | Clean, **verified + validated** refunds accrue trust: T0 → T1 → T2 → T3. |
| 3 | **Oversight recedes** | The *same code* stops paging a human for small, policy-clean refunds. They run autonomously — **Warrant still recorded**. |
| 4 | **Stakes gate** | A **$2,000 abuse-flagged** refund GATES even at high trust: `irreversible.critical` is `never_recede`, so it keeps a checkpoint at every tier (**I3**). The reviewer catches it and REJECTs. |
| 5 | **Snap back** | Three autonomous refunds are **REVERTED** by a next-day fraud check. Trust craters below the tier floor (asymmetric loss + near-miss ratchet), and the checkpoint **re-arms automatically** — no rule edited. |
| 6 | **Replay** | `replay()` over the stored Warrants + the pinned policy reproduces the **exact** final trust state (**I2**) — the audit answer to "why did this run unattended?". |

## The two checks (V&V is first-class and split)

```ts
// VERIFY — "did it do the thing right": the refund never exceeds the order total.
const amountWithinTotal = check.verify("amount<=orderTotal", io => io.output.amount <= io.input.orderTotal);

// VALIDATE — "did it do the *right* thing": a stand-in fraud/policy judge.
const policyJudge = check.validate("fraud-policy-judge", async io => {
  const flagged = io.input.flagged === true, large = io.output.amount >= 1000;
  return (flagged || large) ? { ok: false, confidence: 0.95 } : { ok: true, confidence: 0.9 };
});
```

Conflating verify and validate is how confidently-wrong output slips through. The
$2,000 refund passes `amount<=orderTotal` (it *is* the order total) but fails the
policy judge — which is exactly why the split matters.

## The one call

```ts
const r = new Recede({ ledger: new MemoryLedger(), checkpoint: fixedCheckpoint("APPROVE", "reviewer") });

const out = await r.run(() => issueRefund(order), {
  actor: "billing-bot",
  taskType: "refund.issue",
  risk: "financial.reversible",
  intent: `Refund order ${order.id}`,
  input: { orderTotal: order.total },
  checks: [amountWithinTotal, policyJudge],
});

out.checkpoint;  // undefined once trust is earned — that's the product working
out.trust;       // { before, after, delta } for (billing-bot, refund.issue)
out.warrant;     // the hash-linked evidence chain, on the ledger for audit
```

The gate is **implicit**: there is no `if (needsApproval)` in the agent. As the
ledger accrues verified, validated runs, that same call site graduates from
"always ask a human" to "proceed autonomously" — and reverts on regression.

## Reference output

`refund.ts` prints a legible, sectioned trace and exits non-zero if the I2 replay
check ever fails. See [`OUTPUT.txt`](./OUTPUT.txt) for a captured run.

## License

Apache-2.0 © 2026 Yuval Raz.
