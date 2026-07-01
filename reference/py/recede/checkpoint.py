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
"""Checkpoint surfaces — the one CLI review surface (SPEC §10 defers UIs).

A CheckpointHandler is called when the Gate requires a human decision. It is
shown a CheckpointRequest (intent, evidence, altitude) and returns a
CheckpointResponse (decision + optional edited value). The protocol defines
``altitude`` + ``presented_evidence``; rendering is out of scope, so this is
deliberately thin.

``console_checkpoint()`` is the reference CLI surface. ``auto_checkpoint()`` is a
non-interactive handler for tests and headless runs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from .records import Decision


@dataclass(frozen=True)
class CheckpointRequest:
    actor: str
    task_type: str
    intent: str
    declared_risk: str
    altitude: Optional[str]
    reason: str
    presented_evidence: tuple[str, ...]
    proposed_value: Any = None


@dataclass(frozen=True)
class CheckpointResponse:
    decision: str                 # Decision value
    reviewer: str
    edited_value: Any = None      # set when decision == MODIFY
    latency: Optional[float] = None


# A handler maps a request to a decision. Sync; the runtime calls it inline.
CheckpointHandler = Callable[[CheckpointRequest], CheckpointResponse]


def console_checkpoint(reviewer: str = "console") -> CheckpointHandler:
    """The reference CLI checkpoint. Prints the presented evidence and prompts
    for a decision on stdin. Falls back to APPROVE on non-interactive input
    (EOF) so scripted demos don't hang."""

    def handler(req: CheckpointRequest) -> CheckpointResponse:
        print("\n=== RECEDE CHECKPOINT ===")
        print(f"  actor      : {req.actor}")
        print(f"  task_type  : {req.task_type}")
        print(f"  risk       : {req.declared_risk}")
        print(f"  altitude   : {req.altitude}")
        print(f"  intent     : {req.intent}")
        print(f"  reason     : {req.reason}")
        if req.presented_evidence:
            print("  evidence   :")
            for e in req.presented_evidence:
                print(f"    - {e}")
        if req.proposed_value is not None:
            print(f"  proposed   : {req.proposed_value!r}")
        print("  decision? [A]pprove / [R]eject / [M]odify / [E]scalate (default A)")
        try:
            raw = input("  > ").strip().lower()
        except EOFError:
            raw = ""
        mapping = {
            "a": Decision.APPROVE.value,
            "r": Decision.REJECT.value,
            "m": Decision.MODIFY.value,
            "e": Decision.ESCALATE.value,
            "": Decision.APPROVE.value,
        }
        decision = mapping.get(raw[:1], Decision.APPROVE.value)
        edited = None
        if decision == Decision.MODIFY.value:
            try:
                edited = input("  edited value: ")
            except EOFError:
                edited = req.proposed_value
        return CheckpointResponse(decision=decision, reviewer=reviewer, edited_value=edited)

    return handler


def auto_checkpoint(
    decision: str = Decision.APPROVE.value,
    reviewer: str = "auto",
    edited_value: Any = None,
) -> CheckpointHandler:
    """Non-interactive handler: always returns the same decision. For tests and
    headless pipelines."""

    def handler(req: CheckpointRequest) -> CheckpointResponse:
        return CheckpointResponse(
            decision=Decision(decision).value,
            reviewer=reviewer,
            edited_value=edited_value,
        )

    return handler
