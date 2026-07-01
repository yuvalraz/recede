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
"""The record-emitting operations (SPEC § API): open, act, check, checkpoint,
seal. Each is a content-addressed constructor that hash-links to ``prev`` and
returns the finalized record with its ``id`` filled in.

These mirror the TypeScript reference's free functions of the same names. The
three PURE operations (gate/update/replay) live in ``recede.core``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .canonical import digest as _digest
from .records import (
    ActionRecord,
    CheckKind,
    CheckRecord,
    Checkpoint,
    Decision,
    IntentRecord,
    Outcome,
    Result,
    Verdict,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def open(
    actor: str,
    task_type: str,
    proposed_action: str,
    declared_risk: str,
    expected_effects: Optional[list[str]] = None,
    *,
    inputs: Optional[str] = None,
    ts: Optional[str] = None,
) -> IntentRecord:
    """Open a Warrant with an IntentRecord (SPEC §6). ``inputs`` is digested, not
    stored raw. This is the head of the hash chain (``prev`` is None)."""
    rec = IntentRecord(
        actor=actor,
        ts=ts or _now(),
        task_type=task_type,
        proposed_action=proposed_action,
        declared_risk=declared_risk,
        expected_effects=tuple(expected_effects or ()),
        inputs_digest=_digest(inputs) if inputs is not None else None,
        prev=None,
    )
    return rec.with_id()


def act(
    intent: IntentRecord,
    operations: list[str],
    result: Optional[str] = None,
    *,
    ts: Optional[str] = None,
) -> ActionRecord:
    """Record the action taken, hash-linked to its intent."""
    rec = ActionRecord(
        actor=intent.actor,
        ts=ts or _now(),
        intent_ref=intent.id,
        operations=tuple(operations),
        result_digest=_digest(result) if result is not None else None,
        prev=intent.id,
    )
    return rec.with_id()


def check(
    action: ActionRecord,
    kind: str,
    method: str,
    verdict: str,
    confidence: float,
    evidence_refs: Optional[list[str]] = None,
    *,
    actor: Optional[str] = None,
    ts: Optional[str] = None,
    prev: Optional[str] = None,
) -> CheckRecord:
    """Record a V&V step (VERIFY = did-it-right, VALIDATE = right-thing)."""
    kind = CheckKind(kind).value
    verdict = Verdict(verdict).value
    rec = CheckRecord(
        actor=actor or action.actor,
        ts=ts or _now(),
        action_ref=action.id,
        check_kind=kind,
        method=method,
        verdict=verdict,
        confidence=float(confidence),
        evidence_refs=tuple(evidence_refs or ()),
        prev=prev or action.id,
    )
    return rec.with_id()


def checkpoint(
    warrant_ref: str,
    reason: str,
    presented_evidence: list[str],
    altitude: Optional[str],
    *,
    decision: str,
    reviewer: str,
    actor: Optional[str] = None,
    latency: Optional[float] = None,
    ts: Optional[str] = None,
    prev: Optional[str] = None,
) -> Checkpoint:
    """Record a human decision point (SPEC §6). ``decision`` is the human's call:
    APPROVE / REJECT / MODIFY / ESCALATE."""
    rec = Checkpoint(
        actor=actor or reviewer,
        ts=ts or _now(),
        warrant_ref=warrant_ref,
        reason=reason,
        decision=Decision(decision).value,
        reviewer=reviewer,
        presented_evidence=tuple(presented_evidence or ()),
        altitude=altitude,
        latency=latency,
        prev=prev or warrant_ref,
    )
    return rec.with_id()


def seal(
    warrant_ref: str,
    result: str,
    ground_truth_source: str,
    *,
    deferred_until: Optional[str] = None,
    human_touched: bool = False,
    actor: str = "system",
    ts: Optional[str] = None,
    prev: Optional[str] = None,
) -> Outcome:
    """Seal a Warrant with an Outcome (SPEC §6). A chain sealed UNRESOLVED with a
    ``deferred_until`` window is re-sealable when ground truth arrives."""
    rec = Outcome(
        actor=actor,
        ts=ts or _now(),
        warrant_ref=warrant_ref,
        result=Result(result).value,
        ground_truth_source=ground_truth_source,
        deferred_until=deferred_until,
        human_touched=human_touched,
        prev=prev or warrant_ref,
    )
    return rec.with_id()
