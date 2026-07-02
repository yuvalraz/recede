<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# CC10X × Recede — force-multiplier reference adapter

> **This is a reference PATTERN, not a fork of CC10X.** It reimplements nothing
> from any coding-workflow harness. It shows how a phase-gated workflow becomes
> an *overlay input* to the [Recede protocol](../../SPEC.md): existing checks
> become evidence, and human review recedes exactly where the evidence says it
> can.

Recede is an **overlay**. It wraps a step you already run, turns your existing
checks (tests, evals, CI, human approvals) into Verify/Validate evidence
(**Warrants**), and a **pure `gate()`** decides whether a human checkpoint fires.
Trust is held per `(Actor, TaskType)`; the **Actor is the specific harness/runner**
(e.g. `claude-code`, or a pinned model), never a global score. `gate`, `update`,
and `replay` are pure; records are content-addressed. This adapter does not touch
any of that — it only *translates* CC10X phase results into Recede checks + a run.

## The seam: CC10X owns the process, Recede owns the memory

A "CC10X-style" build already produces, per unit of work, a set of phase-gate
verdicts: an independent **verifier**, a parallel **silent-failure-hunter**, a
**test-honesty** gate, and a **human review** decision. CC10X decides *how* work
is routed and verified. Recede adds the one thing a per-run workflow can't: a
**memory of earned trust** that makes the human gate *recede*.

## The mapping

| CC10X phase result | Recede check | V&V lens | Rationale |
|---|---|---|---|
| **verifier** pass/fail | `check.verify("cc10x:verifier")` | **VERIFY** — did it do the thing *right* | Full-confidence did-it-right gate (schema/build/tests green). |
| **silent-failure-hunter** clean? | `check.verify("cc10x:silent-failure-hunter")` | **VERIFY** | A second did-it-right lens: no swallowed errors. |
| **test-honesty** pass/fail | `check.validate("cc10x:test-honesty")` | **VALIDATE** — did it do the *right* thing | A diff can be verifiably correct yet dishonestly tested. Graded confidence. |
| **human review** decision | the Recede **Checkpoint** (`APPROVE`/`REJECT`/`MODIFY`/`ESCALATE`) | — | The gate decides *whether* a checkpoint fires; the human supplies the decision when it does. |
| **REVERT** (post-merge) | `reseal(..., "REVERTED")` | — | The strongest negative evidence; snaps the gate back. |

Each build unit **seals one Warrant** (`intent → action → checks* → outcome`,
hash-linked, content-addressed). Trust **accrues per `(agent, task_type)`** by
folding that Warrant through the pure `update()` reducer.

## How review recedes, and snaps back

1. **Early.** A new `(agent, code.fix)` scope starts at tier **T0** — cold-start,
   conservative. The gate fires the CC10X human review on every build.
2. **Recede.** Each clean, verified, validated, human-**APPROVE**d run raises
   score *and* confidence (with the confidence cap of invariant **I5**: a high
   score on a tiny sample can't promote past T1). Around tier **T2** the
   `(RiskClass × Tier)` matrix cell for a low-risk fix flips to **AUTONOMOUS** —
   the *same call site* stops paging the human. The Warrant is still captured.
3. **Snap-back.** One autonomously-shipped fix gets **REVERTED** post-merge.
   `revert()` reseals a REVERTED outcome that supersedes the original and
   re-folds via pure `replay` (fully reconstructable — **I2**). Negative evidence
   moves faster than positive (asymmetric weighting) and forces a tier demotion,
   so the very next build **requires human review again**. **No rule was edited** —
   the gate is pure; the evidence moved.

## The default coding policy

`codingPolicy()` is the Recede reference policy (matrix + weighting unchanged)
with a coding-flavored id. Task types and their risk mapping:

| Task type | Typical risk | Behavior |
|---|---|---|
| `code.fix` | `reversible.low` | Recedes fastest — small, reversible fixes. |
| `code.feature` | `reversible.low` / `financial.reversible` | Recedes; high-stakes (billing-path) features gate longer. |
| `code.migrate` | `reversible.low` for prep; **`irreversible.critical`** for the actual migration | The migration step **never recedes**. |

**`never_recede`** — schema changes and prod deploys map onto
`irreversible.critical`, which is in the policy's `never_recede` set. Per
invariant **I3**, those keep a human checkpoint at **every tier**, regardless of
accrued trust. Earned autonomy is bounded, never unbounded.

## Files

| File | Responsibility |
|---|---|
| `cc10x-adapter.ts` | The mapping module: phase signals → Recede checks, `codingPolicy()`, the task-type → default-risk table, and the `Cc10xRecede` front door (`recordBuild` / `reseal` / `revert`). |
| `demo.ts` | A runnable trajectory: 30 clean `code.fix` builds (gated → receding), a REVERT snapping the gate back, and a `code.migrate` never-recede lane. |
| `cli.ts` | A thin CLI over the adapter for recording **real** sessions into a persistent `FileLedger` (JSONL) and reading trust back — see [Recording real sessions](#recording-real-sessions). |

## Run it

```bash
node integrations/cc10x/demo.ts   # Node ≥ 22.6 (tested on 26); zero install
```

Sample output (deterministic clock):

```
[1] ACCRUE — feed clean code.fix builds; watch the human gate recede:
build #1     tier=T0 score=0.11 conf=0.13 n= 1 review=FIRED
build #3     tier=T0 score=0.30 conf=0.34 n= 3 review=FIRED
build #10    tier=T2 score=0.70 conf=0.76 n=10 review=FIRED
build #11    tier=T2 score=0.73 conf=0.79 n=11 review=receded
build #30    tier=T3 score=0.97 conf=0.99 n=30 review=receded

[2] RECEDE — human review first disappeared at build #11; 10/30 builds gated.

[3] SNAP-BACK — an autonomously-shipped fix is REVERTED post-merge:
REVERT       score 0.97 -> 0.36, tier T3 -> T1
build #31    tier=T1 review=SNAPPED BACK (gate fired again)

[4] NEVER-RECEDE — a schema migration always gates, even at high trust:
schema mig   code.migrate at tier=T1 -> gate=HUMAN REVIEW  reason="never_recede: ... (I3)"
```

## Usage

```ts
import { Cc10xRecede } from "./cc10x-adapter.ts";

const bridge = new Cc10xRecede({ checkpoint: myHumanReviewSurface });

const out = await bridge.recordBuild(
  {
    agent: "claude-code",              // the Actor = the specific runner
    taskType: "code.fix",
    intent: "fix null-guard in parser",
    risk: "reversible.low",
    phases: [
      { phase: "verifier", kind: "VERIFY", pass: true, confidence: 1 },
      { phase: "silent-failure-hunter", kind: "VERIFY", pass: true, confidence: 1 },
      { phase: "test-honesty", kind: "VALIDATE", pass: true, confidence: 0.9 },
      { phase: "review", kind: "VALIDATE", pass: true, confidence: 0.85 },
    ],
  },
  () => shipTheDiff(),                  // the CC10X "apply" step you already have
);

out.checkpoint;   // defined iff human review fired — undefined once it receded
out.trust;        // { before, after, delta } for (claude-code, code.fix)
out.warrant;      // the hash-linked evidence chain (the receipt)

// Late negative evidence: a merged fix was rolled back.
bridge.revert(out.warrant.intent.id);   // trust drops fast; the gate snaps back
```

## Recording real sessions

`cli.ts` turns the adapter into a dogfooding tool: after every completed
build/verify cycle, seal one Warrant into a persistent, cross-session ledger
(a `FileLedger` JSONL at any path you choose), and read trust state back before
starting work. Zero install, same Node ≥ 22.6 type-stripping as the demo.

**`record` — seal one Warrant per completed cycle.** Phase flags carry the
verdicts your workflow spine already produced (`--verifier` is required;
`skip` = the phase didn't run). Risk defaults from the task type
(`code.fix`/`code.feature`/`docs.write` → `reversible.low`;
`code.migrate`/`release.publish` → `irreversible.critical`, which is in
`never_recede`). `--human none` means the cycle ran without human review — and
is **refused (exit 2) whenever the gate posture demands a checkpoint**, so the
ledger can't accumulate out-of-policy autonomy. Prints the sealed warrant id,
trust before → after, and the lane's gate posture going forward.

```bash
node cli.ts record --ledger ./trust.jsonl \
  --actor my-agent@my-harness --task code.fix \
  --intent "fix null-guard in parser" \
  --verifier pass --hunter pass --tests pass --validate pass \
  --human approve                        # later, once receded: --human none

# a cycle whose ground truth arrives later: seal UNRESOLVED with a window
node cli.ts record --ledger ./trust.jsonl --actor my-agent@my-harness \
  --task code.feature --intent "add retry to sync job" \
  --verifier pass --tests pass --human approve --defer 2026-07-09T00:00:00Z
```

**`reseal` — flip an outcome when ground truth lands.** A deferred outcome
resolves, or a shipped diff is reverted post-merge. Accepts the full intent id
or any unique prefix; prints the trust snap-back.

```bash
node cli.ts reseal --ledger ./trust.jsonl --warrant sha256:7c2682aa \
  --outcome reverted --source "post-merge regression, rolled back"
# => trust before tier=T2 ... after tier=T0 ...; next build gates again
```

**`status` — read-only trust table.** Every `(actor, task-type)` lane with
tier/score/confidence/sample-count, the gate posture per risk class, and an
**I2 replay-integrity check** (`replay()` over the stored Warrants must equal
the stored trust snapshot — PASS/FAIL per lane, non-zero exit on any FAIL).

```bash
node cli.ts status --ledger ./trust.jsonl [--actor <id>] [--task <type>]
# ACTOR              TASK      TIER  SCORE  CONF   N   UPDATED     I2
# my-agent@...       code.fix  T2    0.746  0.801  11  2026-07-02  PASS
#   gate: read.only=autonomous  reversible.low=autonomous  ...
# I2 replay integrity: PASS — replay() == stored trust for 3/3 lanes
```

The ledger path is always yours to supply — the CLI never assumes or writes any
other location. Treat the ledger as private evidence; don't commit it.

## Clean-room

Designed from first principles and public prior art only. This adapter references
no proprietary or employer-internal system, concept, or name — it is a mapping
pattern between a generic phase-gated coding workflow and the open Recede
protocol.

## License

Apache-2.0 © 2026 Yuval Raz.
