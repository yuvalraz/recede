# Copyright 2026 Yuval Raz
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""The ergonomic front door (README Quickstart).

    r = Recede(ledger=MemoryLedger(), checkpoint=console_checkpoint(), policy=Policy())
    out = r.run(fn, actor=..., task_type=..., intent=..., risk=..., checks=[...])
    out.result       # step return (or human-edited value)
    out.trust        # {before, after, delta} for (actor, task_type)
    out.checkpoint   # None if it ran autonomously
    out.warrant      # the hash-linked evidence chain

``run`` wires the whole lifecycle — open → gate → (checkpoint?) → act → check →
seal → update — around a plain callable. The gate is *implicit*: there is no
``if needs_approval`` in caller code; ``run`` decides from trust + risk + policy.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Optional, Sequence, Union

from . import core, ops
from .checkpoint import (
    CheckpointHandler,
    CheckpointRequest,
    auto_checkpoint,
)
from .checks import CheckIO, CheckSpec
from .ledger import Ledger, MemoryLedger
from .policy import Policy
from .records import (
    Decision,
    Result,
    TrustState,
    Verdict,
    Warrant,
)


@dataclass(frozen=True)
class TrustDelta:
    before: TrustState
    after: TrustState

    @property
    def delta(self) -> float:
        return round(self.after.score - self.before.score, 6)

    def to_dict(self) -> dict[str, Any]:
        return {
            "before": self.before.to_dict(),
            "after": self.after.to_dict(),
            "delta": self.delta,
        }


@dataclass(frozen=True)
class RunResult:
    result: Any
    trust: TrustDelta
    warrant: Warrant
    checkpoint: Optional[Any] = None  # the Checkpoint record, or None if autonomous
    gate_decision: Optional[core.GateDecision] = None


class Recede:
    """The reference runtime. Holds a ledger, a checkpoint handler, and a pinned
    Policy; keeps live TrustState per scope (always reconstructable via
    ``replay`` — I2)."""

    def __init__(
        self,
        ledger: Optional[Ledger] = None,
        checkpoint: Optional[CheckpointHandler] = None,
        policy: Optional[Policy] = None,
    ) -> None:
        self.ledger: Ledger = ledger or MemoryLedger()
        self.checkpoint_handler: CheckpointHandler = checkpoint or auto_checkpoint()
        self.policy: Policy = policy or Policy()
        self._state: dict[tuple[str, str], TrustState] = {}

    # --- trust bookkeeping --------------------------------------------------

    def trust(self, actor: str, task_type: str) -> TrustState:
        return self._state.get((actor, task_type)) or TrustState.cold_start(actor, task_type)

    def replay(self) -> dict[tuple[str, str], TrustState]:
        """Reconstruct all trust states from the ledger's Warrants (I2)."""
        return core.replay(self.ledger.warrants(), self.policy)

    # --- the front door -----------------------------------------------------

    def run(
        self,
        fn: Callable[[], Union[Any, Awaitable[Any]]],
        *,
        actor: str,
        task_type: str,
        intent: str,
        risk: str,
        checks: Optional[Sequence[CheckSpec]] = None,
        inputs: Any = None,
        expected_effects: Optional[list[str]] = None,
        ground_truth_source: str = "inline",
    ) -> RunResult:
        """Synchronous entry point. Internally drives the async pipeline."""
        return asyncio.run(
            self.run_async(
                fn,
                actor=actor,
                task_type=task_type,
                intent=intent,
                risk=risk,
                checks=checks,
                inputs=inputs,
                expected_effects=expected_effects,
                ground_truth_source=ground_truth_source,
            )
        )

    async def run_async(
        self,
        fn: Callable[[], Union[Any, Awaitable[Any]]],
        *,
        actor: str,
        task_type: str,
        intent: str,
        risk: str,
        checks: Optional[Sequence[CheckSpec]] = None,
        inputs: Any = None,
        expected_effects: Optional[list[str]] = None,
        ground_truth_source: str = "inline",
    ) -> RunResult:
        checks = list(checks or [])
        before = self.trust(actor, task_type)

        # 1. open -> IntentRecord (head of the chain)
        intent_rec = ops.open(
            actor,
            task_type,
            proposed_action=intent,
            declared_risk=risk,
            expected_effects=expected_effects,
            inputs=str(inputs) if inputs is not None else None,
        )
        self.ledger.append(intent_rec)

        # 2. gate (PURE) — the implicit decision
        decision = core.gate(before, risk, self.policy)

        checkpoint_rec = None
        human_touched = False
        forced_result: Optional[str] = None

        # 3. checkpoint if required — BEFORE the action runs
        if not decision.autonomous:
            evidence = tuple(f"expected: {e}" for e in (expected_effects or []))
            req = CheckpointRequest(
                actor=actor,
                task_type=task_type,
                intent=intent,
                declared_risk=risk,
                altitude=decision.altitude,
                reason=decision.reason,
                presented_evidence=evidence,
                proposed_value=None,
            )
            resp = self.checkpoint_handler(req)
            human_touched = True
            checkpoint_rec = ops.checkpoint(
                warrant_ref=intent_rec.id,
                reason=decision.reason,
                presented_evidence=list(evidence),
                altitude=decision.altitude,
                decision=resp.decision,
                reviewer=resp.reviewer,
                latency=resp.latency,
            )
            self.ledger.append(checkpoint_rec)
            if resp.decision in (Decision.REJECT.value, Decision.ESCALATE.value):
                forced_result = Result.FAILURE.value

        # 4. act — run the wrapped function (unless rejected)
        result_value: Any = None
        operations = [f"call:{getattr(fn, '__name__', 'fn')}"]
        if forced_result is None:
            raw = fn()
            if inspect.isawaitable(raw):
                raw = await raw
            result_value = raw
            # A human MODIFY substitutes an edited value.
            if checkpoint_rec is not None and checkpoint_rec.decision == Decision.MODIFY.value:
                if resp.edited_value is not None:  # type: ignore[possibly-undefined]
                    result_value = resp.edited_value

        action_rec = ops.act(intent_rec, operations, result=str(result_value))
        self.ledger.append(action_rec)

        # 5. check — run the V&V specs against the IO context
        check_recs = []
        io = CheckIO(intent=intent, input=inputs, output=result_value)
        all_verify_pass = True
        for spec in checks:
            if forced_result is not None:
                break
            res = await spec.run(io)
            rec = ops.check(
                action_rec,
                kind=res.kind,
                method=res.method,
                verdict=res.verdict,
                confidence=res.confidence,
            )
            self.ledger.append(rec)
            check_recs.append(rec)
            if res.verdict != Verdict.PASS.value:
                all_verify_pass = False

        # 6. seal — resolve the outcome
        if forced_result is not None:
            result = forced_result
        elif not all_verify_pass:
            result = Result.FAILURE.value
        else:
            result = Result.SUCCESS.value
        outcome_rec = ops.seal(
            intent_rec.id,
            result=result,
            ground_truth_source=ground_truth_source,
            human_touched=human_touched,
        )
        self.ledger.append(outcome_rec)

        warrant = Warrant(
            intent=intent_rec,
            action=action_rec,
            checks=tuple(check_recs),
            outcome=outcome_rec,
            checkpoint=checkpoint_rec,
        )
        self.ledger.commit(warrant)

        # 7. update (PURE reducer) — fold the sealed warrant into trust
        after = core.update(before, warrant, self.policy)
        self._state[(actor, task_type)] = after

        return RunResult(
            result=result_value,
            trust=TrustDelta(before=before, after=after),
            warrant=warrant,
            checkpoint=checkpoint_rec,
            gate_decision=decision,
        )

    # --- deferred re-seal (SPEC §6) -----------------------------------------

    def reseal(self, warrant: Warrant, result: str, ground_truth_source: str) -> TrustState:
        """Re-seal a previously UNRESOLVED (or later-overturned) warrant with new
        ground truth and re-fold trust. This is how negative evidence only
        knowable later (e.g. a next-day fraud check) feeds back."""
        actor, task_type = warrant.scope
        new_outcome = ops.seal(
            warrant.intent.id,
            result=result,
            ground_truth_source=ground_truth_source,
            human_touched=warrant.outcome.human_touched if warrant.outcome else False,
        )
        resealed = replace(warrant, outcome=new_outcome)
        self.ledger.commit(resealed)
        before = self.trust(actor, task_type)
        after = core.update(before, resealed, self.policy)
        self._state[(actor, task_type)] = after
        return after
