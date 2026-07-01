# Recede

**Trust is a trajectory, not a checkpoint.** Your coding agents earn autonomy from evidence, one verified change at a time, and human review recedes exactly where the evidence says it can, with a receipt for every action you no longer read.

> Status: **v0.1 DRAFT** — the protocol is the deliverable; the reference code is proof. Breaking changes expected before 1.0. Apache-2.0 © 2026 Yuval Raz.

---

## The problem: review fatigue in the SDLC

You put an AI agent into your development loop. It plans, writes code, adds tests, opens PRs. A human is nominally reviewing all of it. But no one can meaningfully read 40 agent PRs a day, so review collapses into one of two failure modes: **rubber-stamp** everything (the review is theater) or **bottleneck** everything (the agent's speed is wasted).

The root cause is a **trust-calibration bug**. Today, trust in an AI agent is:
- **mis-attributed** — treated as one global "do I trust the AI?" verdict, when *trusted to fix a flaky test* and *trusted to run a schema migration* are completely different questions, and
- **mis-calibrated** — granted or withheld by feeling, not by evidence, so it lurches between blind acceptance and blanket suspicion.

Every tool in this space answers with *more to watch*: bigger dashboards, a 0–1000 "trust score", more alerts. Wrong direction. **The payoff of earned trust should be that review disappears where it's no longer warranted** — and snaps back the instant quality regresses.

## The idea: small daily wins compound

A verified, validated change is a small trust win. It should *accumulate*. Recede makes trust a value held **per `(Actor, TaskType)`** that moves along a trajectory: each clean change nudges it up, a regression drops it fast. Once enough small wins have compounded on `code.fix`, the human checkpoint on low-risk fixes quietly recedes — while `schema.migrate` still stops for a human every time. Nobody edited a rule; the evidence moved.

## What it is

Recede is an open, language- and transport-agnostic **protocol** (plus a thin reference library). It defines *records, transitions, and invariants* — not an agent runtime, a database, an ML model, or a UI. It sits as a **layer above** interop protocols (MCP/A2A), eval/observability tools, and static guardrails, consuming their signals as evidence rather than replacing them. In an SDLC that means your existing CI, tests, and PR reviews *become* the evidence — you wrap one function.

## The model in five bullets

1. **Trust is scoped.** Held per `(Actor, TaskType)` — never one global agent score. Trusted on `code.fix` ≠ trusted on `code.migrate`. Review can recede in one lane while staying tight in another.
2. **Every action emits a Warrant.** An append-only, hash-linked evidence chain: *intent → change → checks → outcome*. Trust is a sum over receipts you can open — no Warrant, no trust movement.
3. **V&V is first-class and split.** **Verify** = "did it do the thing right" (CI, tests, types). **Validate** = "did it do the *right* thing" (does the delivered flow match intent, at quality). Conflating "tests are green" with "it did what I asked" is how confidently-wrong code merges.
4. **The Gate is a pure function.** `gate(trust, risk, policy) → checkpoint | autonomous`. Same inputs, same decision, always replayable. That makes "review recedes as trust is earned" a *provable property*, not a vibe.
5. **Trust is asymmetric and bounded.** Earned slowly, lost fast; it decays with staleness and drift; and irreversible actions (migrations, prod deploys) keep a human checkpoint at *every* tier. Earned autonomy is bounded, never unbounded.

## Why it's different

| Incumbent | What it does | Recede's distinct axis |
|---|---|---|
| Eval / observability tools | Score each run in isolation | **Trust has memory** — carried forward per capability |
| Static guardrails / control standards | Apply the same checkpoints uniformly, forever | **Review is proportional** to earned evidence |
| Governance promotion-ladders | Earned, but coarse HR-style tiers + calendar time + sign-off | **Continuous & machine-verifiable**, per-action |
| Agent identity / A2A | Establish *who* the agent is | Not who it is — **what it has earned** |

## The story in 30 seconds

A coding agent works a backlog of small fixes (`code.fix`). **Day 1:** every change is human-reviewed — the reviewer sees the intent, the check verdicts, the diff, approves in seconds. **Verify** is CI/tests/types green; **Validate** is "the change actually does what the ticket asked, at quality." Each clean, verified-and-validated fix is a small trust win, and they compound. **~30 clean fixes in:** the *same call site* stops paging a human for low-risk fixes — they merge autonomously, Warrant still recorded, no interruption. The reviewer's attention is now spent only where it's warranted. **Then** a fix that shipped autonomously gets reverted in staging: trust drops below the tier floor and review **snaps back automatically** — no rule edited, the evidence moved. And a **`schema.migrate`** always stops for a human, at every tier, because some actions are never safe to recede. Every step is auditable: `replay()` over the stored Warrants reproduces the exact trust state, so "why did this merge unattended?" is answered by pointing at the receipts.

The higher-stakes frontier — an agent issuing refunds, moving money, touching customers — rides the *same* protocol (see [`examples/refund`](./examples/refund)). But that's the frontier. The everyday win is your SDLC: small daily verified wins, compounding into earned, bounded autonomy.

## Quickstart

> _Reference implementation (TypeScript primary, Python mirror) — see [`reference/`](./reference/). Wrapping CC10X or another agent harness? See [`INTEGRATIONS.md`](./INTEGRATIONS.md)._

```ts
const r = new Recede({ ledger: new MemoryLedger(), checkpoint: consoleCheckpoint(), policy });

const ciGreen  = check.verify("ci", io => io.output.ci === "green");
const intentOK = check.validate("intent-fit", async io => ({ ok: await reviewMatchesIntent(io.intent, io.diff), confidence: 0.8 }));

const outcome = await r.run(() => agent.implement(ticket), {
  actor: "code-agent",
  taskType: "code.fix",
  intent: `Fix ${ticket.id}: ${ticket.title}`,
  risk: "reversible.low",
  checks: [ciGreen, intentOK],
});
// The gate is IMPLICIT — no `if (needsReview)` in your code. run() decides.
outcome.result;      // the change (or the human-edited version)
outcome.trust;       // { before, after, delta } for (code-agent, code.fix)
outcome.checkpoint;  // undefined once review has receded for low-risk fixes
outcome.warrant;     // the hash-linked evidence chain: intent -> diff -> checks -> outcome
```

Wrap the function you already have. As the ledger accrues verified, validated changes, that same call site graduates from "always ask a human" to "merge autonomously" — and reverts the moment the agent regresses.

## Status & scope

**v0.1 ships:** the normative record schemas, the trust-state model + tiers + invariants I1–I7, the pure `gate()` + declarative Policy matrix, the pure `update()`/`replay()` reducers, first-class Verify/Validate checks, a reference weighting function (asymmetric + decay + near-miss ratchet), a reference implementation (TypeScript primary, Python mirror) with a cross-language conformance vector, one CLI checkpoint surface, and runnable examples: [`examples/sdlc`](./examples/sdlc) (the everyday case) and [`examples/refund`](./examples/refund) (the higher-stakes frontier). Integrations: [`INTEGRATIONS.md`](./INTEGRATIONS.md) (CC10X force-multiplier, OKF export). See [`SPEC.md`](./SPEC.md).

**Explicitly deferred:** cryptographic identity/PKI, ML scoring, distributed ledgers, a web dashboard (shipping one first would betray the anti-fatigue thesis), multi-agent delegation, framework plugins, and compliance mapping. Interfaces are left where a platform would later grow.

## Clean-room

Designed from first principles and **public** prior art only (append-only logs, content addressing, risk matrices, calibration, human-in-the-loop gating, verification-vs-validation from systems engineering). No proprietary or employer-internal system, concept, or name is referenced.

## License

Apache-2.0 © 2026 Yuval Raz. A protocol earns respect by being implementable and adoptable — take it, build on it, tell me what breaks.
