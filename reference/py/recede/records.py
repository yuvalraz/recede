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
"""The wire-agnostic data model (SPEC §3-§4).

Records are frozen dataclasses — immutable, hashable-by-content. Each one knows
how to render its canonical body and derive its own content ``id``. Enums are
plain ``str`` subclasses so a serialized record round-trips through JSON without
custom encoders, matching the TypeScript reference's string-union types.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .canonical import content_id


# --- enums (string-valued, JSON-transparent) --------------------------------

class Kind(str, Enum):
    INTENT = "INTENT"
    ACTION = "ACTION"
    CHECK = "CHECK"
    OUTCOME = "OUTCOME"
    CHECKPOINT = "CHECKPOINT"


class CheckKind(str, Enum):
    VERIFY = "VERIFY"       # did it right (schema, tests)
    VALIDATE = "VALIDATE"   # right thing (intent, policy)


class Verdict(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    INCONCLUSIVE = "INCONCLUSIVE"


class Result(str, Enum):
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    REVERTED = "REVERTED"
    UNRESOLVED = "UNRESOLVED"


class Decision(str, Enum):
    APPROVE = "APPROVE"
    REJECT = "REJECT"
    MODIFY = "MODIFY"
    ESCALATE = "ESCALATE"


class Tier(str, Enum):
    T0 = "T0"  # UNTRUSTED
    T1 = "T1"  # OBSERVED
    T2 = "T2"  # SUPERVISED
    T3 = "T3"  # TRUSTED
    T4 = "T4"  # RELIED-UPON

    @property
    def rank(self) -> int:
        return int(self.value[1:])

    @classmethod
    def from_rank(cls, r: int) -> "Tier":
        r = max(0, min(4, r))
        return cls(f"T{r}")


# --- records ----------------------------------------------------------------

def _body(rec: Any) -> dict[str, Any]:
    """The canonical body of a record: all fields, with the id/sig omission and
    null-dropping handled downstream by canonical_serialize."""
    return dataclasses.asdict(rec)


@dataclass(frozen=True)
class IntentRecord:
    actor: str
    ts: str
    task_type: str
    proposed_action: str
    declared_risk: str
    expected_effects: tuple[str, ...] = ()
    inputs_digest: Optional[str] = None
    prev: Optional[str] = None
    sig: Optional[str] = None
    kind: str = Kind.INTENT.value
    id: str = ""

    def with_id(self) -> "IntentRecord":
        return dataclasses.replace(self, id=content_id(_body(dataclasses.replace(self, id=""))))


@dataclass(frozen=True)
class ActionRecord:
    actor: str
    ts: str
    intent_ref: str
    operations: tuple[str, ...] = ()
    result_digest: Optional[str] = None
    prev: Optional[str] = None
    sig: Optional[str] = None
    kind: str = Kind.ACTION.value
    id: str = ""

    def with_id(self) -> "ActionRecord":
        return dataclasses.replace(self, id=content_id(_body(dataclasses.replace(self, id=""))))


@dataclass(frozen=True)
class CheckRecord:
    actor: str
    ts: str
    action_ref: str
    check_kind: str
    verdict: str
    confidence: float
    method: Optional[str] = None
    evidence_refs: tuple[str, ...] = ()
    prev: Optional[str] = None
    sig: Optional[str] = None
    kind: str = Kind.CHECK.value
    id: str = ""

    def with_id(self) -> "CheckRecord":
        return dataclasses.replace(self, id=content_id(_body(dataclasses.replace(self, id=""))))


@dataclass(frozen=True)
class Outcome:
    actor: str
    ts: str
    warrant_ref: str
    result: str
    ground_truth_source: Optional[str] = None
    deferred_until: Optional[str] = None
    human_touched: bool = False
    prev: Optional[str] = None
    sig: Optional[str] = None
    kind: str = Kind.OUTCOME.value
    id: str = ""

    def with_id(self) -> "Outcome":
        return dataclasses.replace(self, id=content_id(_body(dataclasses.replace(self, id=""))))


@dataclass(frozen=True)
class Checkpoint:
    actor: str
    ts: str
    warrant_ref: str
    reason: str
    decision: str
    reviewer: str
    presented_evidence: tuple[str, ...] = ()
    altitude: Optional[str] = None
    latency: Optional[float] = None
    prev: Optional[str] = None
    sig: Optional[str] = None
    kind: str = Kind.CHECKPOINT.value
    id: str = ""

    def with_id(self) -> "Checkpoint":
        return dataclasses.replace(self, id=content_id(_body(dataclasses.replace(self, id=""))))


# --- trust state ------------------------------------------------------------

@dataclass(frozen=True)
class TrustState:
    """Standing for one ``(actor, task_type)`` scope. Reconstructable via
    ``replay()`` (I2). Immutable — the pure reducer returns a fresh copy."""

    actor: str
    task_type: str
    tier: str = Tier.T0.value
    score: float = 0.0
    confidence: float = 0.0
    sample_count: int = 0
    window_ref: Optional[str] = None
    updated: Optional[str] = None

    @staticmethod
    def cold_start(actor: str, task_type: str) -> "TrustState":
        """No history ⇒ conservative neutral prior at T0 (SPEC §4 cold start)."""
        return TrustState(actor=actor, task_type=task_type)

    @property
    def scope(self) -> tuple[str, str]:
        return (self.actor, self.task_type)

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


# A completed unit of work: the ordered, hash-linked record sequence plus the
# resolved outcome and any human checkpoint. This is what update()/replay() fold.
@dataclass(frozen=True)
class Warrant:
    intent: IntentRecord
    action: Optional[ActionRecord] = None
    checks: tuple[CheckRecord, ...] = ()
    outcome: Optional[Outcome] = None
    checkpoint: Optional[Checkpoint] = None

    @property
    def scope(self) -> tuple[str, str]:
        return (self.intent.actor, self.intent.task_type)

    @property
    def records(self) -> tuple[Any, ...]:
        seq: list[Any] = [self.intent]
        if self.action is not None:
            seq.append(self.action)
        seq.extend(self.checks)
        if self.checkpoint is not None:
            seq.append(self.checkpoint)
        if self.outcome is not None:
            seq.append(self.outcome)
        return tuple(seq)
