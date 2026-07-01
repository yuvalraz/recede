# Recede — Python reference

Python mirror of the [Recede](../../SPEC.md) protocol reference. Same records,
same eight operations, same invariants — an idiomatic Python surface so the
protocol reads as language-agnostic. **Zero runtime dependencies** (stdlib only);
tests run under stdlib `unittest` with no install.

> Apache-2.0 © 2026 Yuval Raz. Status: v0.1 DRAFT — the protocol is the
> deliverable; this code is proof.

## Install / run

Nothing to install — it's a stdlib-only package. From this directory:

```bash
python -m unittest          # the conformance suite (invariants I1-I7, purity, replay)
python -m examples.refund_demo   # the runnable killer example
```

Or `pip install -e .` to put `recede` on your path.

## Quickstart

Wrap the function you already have. The gate is **implicit** — there is no
`if needs_approval` in your code; `run()` decides from trust + risk + policy.

```python
from recede import Recede, MemoryLedger, console_checkpoint, Policy, check

r = Recede(ledger=MemoryLedger(), checkpoint=console_checkpoint(), policy=Policy())

amount_ok = check.verify("amount", lambda io: io.output["amount"] <= io.input["order_total"])
policy_ok = check.validate("policy", lambda io: {"ok": True, "confidence": 0.8})

out = r.run(
    lambda: agent.issue_refund(order),
    actor="billing-bot",
    task_type="refund.issue",
    intent=f"Refund order {order['id']} — duplicate charge",
    risk="financial.reversible",
    inputs=order,
    checks=[amount_ok, policy_ok],
)

out.result       # the step return (or the human-edited value on MODIFY)
out.trust        # TrustDelta(before, after) with .delta for (billing-bot, refund.issue)
out.checkpoint   # None if it ran autonomously
out.warrant      # the hash-linked evidence chain
```

As the ledger accrues verified, validated runs, that same call site graduates
from "always ask a human" to "proceed autonomously" — and snaps back if the
agent regresses.

## The API (mirror of the TypeScript reference)

### Ergonomic front door

| Python | Purpose |
|---|---|
| `Recede(ledger=, checkpoint=, policy=)` | the runtime |
| `r.run(fn, actor=, task_type=, intent=, risk=, checks=[...])` | wrap-and-gate a call → `RunResult` |
| `r.run_async(...)` | same, awaitable |
| `check.verify(name, fn)` | did-it-*right* (sync, boolean-ish) |
| `check.validate(name, fn)` | did-the-*right-thing* (sync/async → `{ok, confidence}`) |
| `MemoryLedger()` / `FileLedger(path)` | append-only, hash-linked stores |
| `console_checkpoint()` / `auto_checkpoint()` | CLI review surface / headless handler |

### The eight operations

Five **record-emitting** ops (content-addressed constructors, in `recede.ops`):

```python
from recede import ops
intent = ops.open(actor, task_type, proposed_action, declared_risk, expected_effects)
action = ops.act(intent, operations, result)
chk    = ops.check(action, "VERIFY"|"VALIDATE", method, "PASS"|"FAIL"|"INCONCLUSIVE", confidence, evidence_refs)
cp     = ops.checkpoint(warrant_ref, reason, presented_evidence, altitude, decision=, reviewer=)
out    = ops.seal(warrant_ref, "SUCCESS"|"FAILURE"|"REVERTED"|"UNRESOLVED", ground_truth_source, deferred_until=)
```

Three **PURE** ops (deterministic, no side effects — invariant I7, in `recede.core`):

```python
from recede import gate, update, replay
decision = gate(trust_state, declared_risk, policy)   # → GateDecision(autonomous, altitude?, reason, policy_digest)
new_state = update(trust_state, warrant, policy)        # reducer: folds one sealed Warrant
states    = replay(warrants, policy)                    # reconstruct all scopes; MUST equal stored state (I2)
```

> `open` is a Python builtin, so the intent-opening op is also exported as
> `recede.open_intent`. Use `recede.ops.open` inside the `ops` namespace.

## Invariants (proven by the suite)

- **I1 Scope isolation** — trust is per `(actor, task_type)`; one scope never leaks into another.
- **I2 Reconstructability** — `replay()` over the ledger reproduces live `TrustState` exactly.
- **I3 Irreversible floor** — `never_recede` risks keep a checkpoint at *every* tier, even T4.
- **I4 Trust can decrease** — loss > gain; a REVERTED outcome forces a tier demotion.
- **I5 Confidence cap** — the confidence-implied tier caps the score-implied tier; one lucky run cannot promote past T1.
- **I6 Policy digest** — every gate decision carries the exact policy digest that produced it.
- **I7 Purity** — `gate` / `update` / `replay` are deterministic and mutate nothing.

The reference weighting (asymmetric earn/lose, diminishing returns, near-miss
ratchet, time+drift decay) lives in `recede.weighting` and is a *reference*, not
normative — swap it for your own as long as the invariants hold.

## Layout

```
recede/
  canonical.py    content-addressing (id = sha256 of the canonical body)
  records.py      the wire-agnostic data model + TrustState + Warrant
  policy.py       (RiskClass × Tier) matrix, weights, decay, never_recede, digest
  weighting.py    reference weighting function (asymmetric, ratchet, decay)
  core.py         PURE gate / update / replay  (I7)
  ops.py          open / act / check / checkpoint / seal
  checks.py       check.verify / check.validate builders
  checkpoint.py   console + auto checkpoint handlers
  ledger.py       MemoryLedger + append-only FileLedger
  recede.py       the Recede front door + run()
examples/refund_demo.py   the runnable killer example
tests/                    stdlib unittest conformance suite
```
