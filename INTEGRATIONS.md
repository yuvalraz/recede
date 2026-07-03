<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# Integrations — how Recede rides on flows you already run

Recede is an **overlay**. It does not ask you to adopt a new agent runtime, a
new database, or a new review process. It wraps a step you already run, reads
the checks you already have as evidence, and lets the human checkpoint you
already do **recede** where the evidence has earned it. This document shows
where it plugs in and what each seam buys you.

Everything below is grounded in the shipped reference implementation
([`reference/ts/`](./reference/ts/)) and two runnable reference adapters
([`integrations/cc10x/`](./integrations/cc10x/) and
[`integrations/okf/`](./integrations/okf/)). No install; both adapters run on
Node ≥ 22.6 via native TS type-stripping.

---

## 1. The overlay principle

Recede never replaces your flow. It wraps one step in it.

The unit of integration is a single function call. You already have a step —
issue a refund, apply a diff, send an email, run a migration — and you already
have ways of checking it: tests, evals, a CI gate, an LLM-judge, a human giving
a thumbs-up. Recede's `run()` wraps that step and turns those existing checks
into evidence:

```ts
const out = await r.run(() => stepYouAlreadyHave(), {
  actor: "billing-bot",
  taskType: "refund.issue",
  intent: `Refund order ${order.id} — duplicate charge`,
  risk: "reversible.low",
  checks: [amountOK, policyOK],   // your existing checks, as Verify/Validate
});
```

What the overlay does around that step:

- Each check becomes a typed **Verify** ("did it right") or **Validate** ("did
  the right thing") record. You are not writing new checks; you are labelling
  the ones you have.
- The step plus its checks seal into a **Warrant** — an append-only,
  hash-linked evidence chain (intent → action → checks → outcome).
- A **pure** `gate()` reads current trust for this `(Actor, TaskType)` plus the
  declared risk and decides whether a human checkpoint fires. The gate is
  *implicit*: there is no `if (needsApproval)` in your code.
- Trust folds forward through the pure `update()` reducer, scoped to that one
  `(Actor, TaskType)`.

The integration cost is roughly **wrapping one function**. You do not
restructure your pipeline; you thread one call around the step whose oversight
you want to be able to relax.

Because it consumes signals rather than producing them, Recede **composes with**
other skill and flow frameworks instead of competing with them. A framework
that already runs tests, evals, or a review step is a *source of evidence* for
Recede, not a thing Recede displaces. It sits as a layer above interop
(MCP/A2A), eval/observability tooling, and static guardrails — it reads their
verdicts; it does not reimplement them.

---

## 2. The AGENTS.md policy pattern

`AGENTS.md` is already where a repo declares how agents should behave. It is the
natural home for the **trust contract**: which task-types exist, what risk class
each carries, and which can never run unattended.

The pattern is: declare the policy in `AGENTS.md`, then have a thin `/recede`
skill wrap any agent action, read that policy, and drive `gate()`. Every agent
in the repo then inherits earned-trust gating without each one hand-rolling it.

A concrete `AGENTS.md` snippet:

```markdown
## Recede trust policy

Every agent action is wrapped by the `/recede` skill, which gates on earned
trust per (Actor, TaskType). The Actor is the specific harness/runner.

### Task-types and risk classes

| task_type        | risk                    | notes                              |
|------------------|-------------------------|------------------------------------|
| `code.fix`       | `reversible.low`        | small, revertable diffs            |
| `code.feature`   | `financial.reversible`  | user-visible; higher blast radius  |
| `docs.edit`      | `read.only`             | cheap to undo                      |
| `schema.migrate` | `irreversible.critical` | destructive; see never_recede      |
| `deploy.prod`    | `irreversible.critical` | see never_recede                   |

### never_recede

`schema.migrate` and `deploy.prod` retain a human checkpoint at **every** tier,
no matter how much trust an actor has earned (Recede invariant I3). Trust bounds
autonomy; it never removes the floor for irreversible harm.
```

The `/recede` skill reads that table, maps each declared `risk` onto a Recede
`RiskClass`, and calls `run()` with the right `actor`, `taskType`, and `risk`.
The `never_recede` set maps straight onto the policy's `never_recede[]` — those
task-types keep gating forever. New agents added to the repo pick up the same
contract for free, because the policy lives in `AGENTS.md`, not in each agent.

---

## 3. CC10X force-multiplier

*Reference adapter: [`integrations/cc10x/cc10x-adapter.ts`](./integrations/cc10x/cc10x-adapter.ts)
· runnable demo: `node integrations/cc10x/demo.ts`.*

CC10X is already a verification spine. It runs an independent verifier, a
parallel silent-failure-hunter, REVERT and test-honesty gates, and a human
review before a task is called "done". That machinery is good and Recede does
not reimplement any of it.

CC10X lacks two things Recede supplies:

1. **Memory.** CC10X evaluates each build in isolation. It has no notion that
   *this agent has shipped `code.fix` clean 200 times*, so it keeps asking for
   the same human review on the 201st trivially-clean fix.
2. **A receding human review.** CC10X's human-before-done gate is uniform. It
   does not dial itself down as an actor proves out on a task-type.

Recede adds exactly those. The mapping:

| CC10X | Recede |
|---|---|
| Phase gate result (verifier, silent-failure-hunter) | a **Verify** Check (did-it-right) |
| Phase gate result (test-honesty, human review) | a **Validate** Check (did-the-right-thing) |
| One build unit's phase sequence | one sealed **Warrant** |
| Which agent/runner ran the build | the **Actor** in the `(Actor, TaskType)` trust scope |
| Human review before "done" | the **Checkpoint** — which the gate lets **recede** as trust is earned |
| A post-merge REVERT | late negative evidence re-folded via `reseal()`, tripping the near-miss ratchet |

The behavior this produces, straight from the demo run: clean `code.fix` builds
accrue trust; the human review keeps firing through the early tiers, then stops
firing once the scope reaches the tier where `reversible.low` is autonomous —
same call site, no rule edited. When an autonomously-shipped fix is later
REVERTED, trust drops fast (T3 → T1 in the reference run) and the review
**snaps back** on the next build. A `schema.migrate` in the `never_recede` set
keeps gating at every tier regardless of trust.

**This is a reference integration PATTERN, not a fork.** CC10X is external; the
adapter *maps to* its phase outcomes, feeding verdicts CC10X already computes
into Recede's evidence model. It does not modify CC10X and does not re-derive
any of CC10X's analysis. CC10X owns the process; Recede owns the memory and the
receding gate — and `gate`/`update`/`replay` stay pure and unmodified.

---

## 4. OKF binding

*Reference adapter: [`integrations/okf/okf-export.ts`](./integrations/okf/okf-export.ts)
· docs: [`integrations/okf/README.md`](./integrations/okf/README.md)
· runnable demo: `node integrations/okf/demo.ts`.*

A Recede ledger is machine-truth: content-addressed records and pure trust
state. The protocol deliberately defers the human-facing surface (SPEC §10). The
OKF binding fills that gap by serializing a ledger as a **Google Open Knowledge
Format** bundle — a directory of markdown files with YAML frontmatter that any
OKF-aware reader can consume.

The projection:

- Each `(Actor, TaskType)` trust scope becomes one **concept doc**
  (`type: recede/trust-scope`), with `tier` / `score` / `confidence` /
  `sample_count` and the pinning policy digest in its frontmatter.
- That scope's **`log.md` is the Warrant history** — the chronological evidence
  chain that produced the standing.
- A shared policy concept (`type: recede/policy`) records the gate matrix and
  the `never_recede` ceiling; `index.md` gives progressive disclosure over the
  bundle.

The exporter is thin: it computes no trust of its own. It calls Recede's pure
`replay()` to reconstruct each scope's standing byte-for-byte from its Warrants
(invariant I2), and the pure `gate()` to show the current oversight posture per
risk class. Nothing is asserted that the protocol cannot reconstruct.

Two things this buys:

- **It resolves Recede's deferred human-facing surface.** Trust becomes readable
  markdown a human can audit and an agent can read before acting. The frontmatter
  is the machine read; the prose plus `log.md` is the human audit.
- **It makes the trust map a vendor-neutral lingua franca.** The same bundle
  reads identically whether it is committed to a repo, pasted into a Linear
  document, or attached to a Jira ticket — no proprietary format in between.

---

## 5. Nekuda / agentic commerce

*Reference example: [`examples/agentic-checkout/`](./examples/agentic-checkout/)
· runnable demo: `node examples/agentic-checkout/checkout.ts`.*

A [Nekuda](https://github.com/nekuda-ai) mandate is *ex-ante*: a signed, scoped
permission answering "did the user actually mean it?" before an agent spends.
Recede is *ex-post*: the evidence chain answering "should this agent keep
buying unattended?" — a trust question, not a signature question. The two
compose: the mandate becomes the Warrant's **Intent** record, mandate checks
(cap, allowlist) become **Verify**, and post-purchase judgment (kept vs.
disputed) becomes **Validate**.

The example shows a shopping agent earning autonomy on `commerce.reorder`, a
friendly-fraud chargeback resealing SUCCESS → REVERTED and snapping the
checkpoint back, and a high-value off-allowlist purchase that never recedes.
It runs against a **simulated** gateway — a demo of the pairing, not a shipped
Nekuda SDK integration. See [Nekuda's writing](https://nekuda.substack.com/).

---

## 6. Heterogeneous fleet — measure, don't teleport

Trust in Recede is per-Actor, and the **Actor is the specific harness/runner**.
A local multi-agent harness (say, Claude Code on your machine) and an expensive
cloud single-agent runner are **different actors**. Trust earned by one does not
transfer to the other. That is invariant I1 doing its job: no unearned trust
teleports across a runner boundary just because the task-type is the same.

This matters because of a real industry trap. Local multi-agent flows are, right
now, both **more powerful and cheaper** than cloud single-agent ADLC pipelines
(Linear/Jira drive cloud runners), largely because the local capacity is
vendor-subsidized. So teams get locked into local: the cloud path costs more and
does less, and no one can justify the migration on gut feel.

Recede does not fight this and does not pretend cloud equals local. It
**measures** the trust gap between actors on the *same* task-types under the
*same* evidence bar. Because both actors are gated by the same pure `gate()`
against the same policy, their earned tiers are directly comparable. That gives
you two things:

- **More throughput from the cheap local capacity.** Where the local actor has
  earned trust on a task-type, its human gate recedes — you get more done
  through the capacity you are already paying for, without adding reviewers.
- **An evidence-based routing and migration map.** Offload a task-type to a
  cheaper (or cloud) actor only once *that actor* has earned trust on it, under
  the same bar. When cloud economics flip, you migrate **task-type by
  task-type** — moving each lane once its trust is proven — rather than a
  big-bang switch on faith. The trust map (see the OKF binding, §4) is exactly
  the artifact that tells you which lanes are ready.

Recede's answer to a heterogeneous fleet is not "make them equal" — it is
"measure what each has actually earned, and let the numbers drive where work
runs."

---

## 7. OpenWiki: trust-calibrated wikis

*Reference adapter: [`integrations/openwiki/openwiki-adapter.ts`](./integrations/openwiki/openwiki-adapter.ts)
· docs: [`integrations/openwiki/README.md`](./integrations/openwiki/README.md)
· runnable demo: `node integrations/openwiki/demo.ts`.*

This is the **docs flow** of the one-protocol-many-flows gallery. OpenWiki
generates a wiki from a codebase, but nothing in it knows whether a page is
still true after the code beneath it moves. The task type is `doc.map`, and the
question Recede answers is "which of these generated pages should I still
trust?"

The wrap gives every page a trust trajectory. Pages start at an epsilon floor on
generation, rise only on a human seal, and decay when their cited source files
change. Four wiki events each seal one `doc.map` warrant:

| OpenWiki event | Recede evidence | V&V lens |
|---|---|---|
| `run` (the generator produced or updated pages) | a `doc.map` warrant (child exit, wiki present, gitHead binding, plan snapshot) | **VERIFY** |
| `seal` (a human vouched for named pages) | a human-signed check | **VALIDATE** |
| `sample` (mechanical re-verification of cited refs at HEAD) | one check per page; a page that fails bands `action` and costs the lane trust | **VERIFY** |
| `decay` (source files moved under the pages) | a recorded event, deliberately lane-non-counting | none |

The per-page sidecar (`<wiki>/.trust/state.json`) is a **derived cache**,
reconstructible byte-identically from the warrant chain via `replay`. The read
surface is a generated `TRUST.md` table plus a gated fenced block in `AGENTS.md`
whose language downgrades with the wiki's worst band. The gate manifests where a
wiki reader meets it (the fence language and the `status` posture), not in a
receding human-approval loop.

OpenWiki is never forked or patched. The wrap runs it as a child process,
snapshots its ephemeral `_plan.md` before OpenWiki deletes it, and reads its
output. Sampling is mechanical today (file existence plus a symbol grep); an LLM
`ClaimVerifier` is the named upgrade path, and a single-runner ceiling on the
sidecar is documented. Zero runtime dependencies.

---

## Start here

1. **Wrap one function.** Take the single step whose oversight you want to be
   able to relax, and wrap it in `r.run(fn, { actor, taskType, intent, risk,
   checks })`. Your existing checks become the Verify/Validate evidence. See the
   quickstart in [`reference/ts/README.md`](./reference/ts/README.md).
2. **Declare a policy in `AGENTS.md`.** Add the task-types, their risk classes,
   and the `never_recede` set (§2). A thin `/recede` skill reads it so every
   agent in the repo inherits the same earned-trust gating.
3. **Read the examples.** `node integrations/cc10x/demo.ts` shows a human review
   receding and snapping back on a REVERT (§3). `node integrations/okf/demo.ts`
   exports a ledger to an auditable OKF bundle (§4). `node
   examples/agentic-checkout/checkout.ts` shows the same pattern on a
   mandate-carrying shopping agent (§5). `node integrations/openwiki/demo.ts`
   gives an OpenWiki-generated wiki a per-page trust trajectory, fully offline
   (§7).
