<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# The everyday example — a coding agent earns trust across a backlog

This is the example the [Recede README](../../README.md) leads with, made
runnable. Your team put an AI agent in the development loop: it reads a ticket,
writes the fix, runs CI, opens a PR. A human is nominally reviewing all of it —
but no one can meaningfully read 40 agent PRs a day, so review collapses into
**rubber-stamp** (theater) or **bottleneck** (the agent's speed is wasted).

The root cause is a **trust-calibration bug**. Today, trust in an agent is:

- **mis-attributed** — one global "do I trust the AI?" verdict, when *trusted to
  fix a flaky test* and *trusted to run a schema migration* are completely
  different questions; and
- **mis-calibrated** — granted or withheld by feeling, not by evidence.

Recede fixes both. Trust is held **per `(Actor, TaskType)`** and moves **only on
evidence**, so small daily verified wins compound into earned, bounded autonomy
— and review recedes exactly where the evidence warrants, snapping back the
instant quality regresses. This folder is that story, made runnable. It imports
the canonical [TypeScript reference implementation](../../reference/ts) and
reimplements none of the protocol. It is framework-agnostic — no coupling to any
particular agent harness.

**Zero runtime dependencies.** Runs on Node's built-in TypeScript type stripping.

## Run it

```bash
node demo.ts        # from this directory; requires Node >= 22.6 (tested on 26)
```

## What you'll watch

The call site never changes — it is always the same
`r.run(() => agent.implement(ticket), …)`. What changes is what the *evidence*
has earned. The trace walks six beats:

| # | Beat | What the trace shows |
|---|------|----------------------|
| 1 | **Baseline** | Cold start at tier **T0**: every `code.fix` pauses for a human review. |
| 2 | **Earning trust** | ~30 clean, **verified + validated** fixes compound trust T0 → T3. |
| 3 | **Review recedes** | The *same code* stops paging a human for low-risk fixes. They **merge autonomously** — **Warrant still recorded**, so every unread merge has a receipt. |
| 4 | **Snap back** | An autonomously-merged fix is **REVERTED in staging**. Trust craters below the tier floor (asymmetric loss), and review **re-arms automatically** — no rule edited. |
| 5 | **Stakes gate** | A `code.migrate` (`irreversible.critical`) **GATES at every tier** via `never_recede` (**I3**). Earned autonomy on `code.fix` never leaks into a schema migration — and migration is a *separate scope*, cold at T0 (**I1**). |
| 6 | **Replay** | `replay()` over the stored Warrants + the pinned policy reproduces the **exact** final trust state for both scopes (**I2**) — the audit answer to "why did that PR merge unattended?". Fail-closed: the demo exits non-zero if replay ≠ stored. |

## V&V is first-class and split

**Verify** = "did it do the thing right." **Validate** = "did it do the *right*
thing." Conflating "tests are green" with "it did what I asked" is how
confidently-wrong code merges — so Recede keeps them separate.

```ts
// VERIFY — "did it do the thing right": CI, tests, and types are all green.
const ciGreen = check.verify("ci/tests/types green", io => io.output.ci === "green");

// VALIDATE — "did it do the RIGHT thing": the delivered change matches the
// ticket, at quality (a stand-in for a review LLM-as-judge / senior reviewer).
const intentFit = check.validate("intent-fit (delivered flow matches ticket)", async io =>
  io.output.intentFit ? { ok: true, confidence: 0.9 } : { ok: false, confidence: 0.95 });
```

In your real pipeline these wrap signals you already have: `ciGreen` is your CI
status; `intentFit` is your reviewer or an eval judge. You wrap one function.

## The one call

```ts
const r = new Recede({ ledger: new MemoryLedger(), checkpoint: consoleCheckpoint(), policy });

const out = await r.run(() => agent.implement(ticket), {
  actor: "code-agent",
  taskType: "code.fix",
  intent: `Fix ${ticket.id}: ${ticket.title}`,
  risk: "reversible.low",
  checks: [ciGreen, intentFit],
});

out.result;      // the merged change (or the human-edited version)
out.checkpoint;  // undefined once review has receded for low-risk fixes
out.trust;       // { before, after, delta } for (code-agent, code.fix)
out.warrant;     // the hash-linked evidence chain, on the ledger for audit
```

The gate is **implicit**: there is no `if (needsReview)` in the agent. As the
ledger accrues verified, validated changes, that same call site graduates from
"always ask a human" to "merge autonomously" — and reverts the moment the agent
regresses. A `code.migrate` on the same actor stays gated regardless, because
it is a different scope *and* an irreversible one.

## Reference output

`demo.ts` prints a legible, sectioned trajectory and exits non-zero if the I2
replay check ever fails. See [`OUTPUT.txt`](./OUTPUT.txt) for a captured run —
review recedes at fix #11, snaps back to T1 after the staging revert, and the
migration gates at every tier while `code.fix` sits at T3.

## The higher-stakes frontier

An agent issuing refunds, moving money, touching customers rides the *same*
protocol — but that is the frontier, harder to validate, not the starting point.
See [`examples/refund`](../refund) once the everyday case is clear.

## License

Apache-2.0 © 2026 Yuval Raz.
