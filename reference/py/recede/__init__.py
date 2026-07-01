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
"""Recede — evidence-earned, risk-gated trust for human/agent work.

Python mirror of the TypeScript reference. Same protocol, idiomatic surface.

Ergonomic front door:
    from recede import Recede, MemoryLedger, console_checkpoint, Policy, check
    r = Recede(ledger=MemoryLedger(), checkpoint=console_checkpoint(), policy=Policy())
    r.run(fn, actor=..., task_type=..., intent=..., risk=..., checks=[...])

The eight ops (open/act/check/checkpoint/seal + PURE gate/update/replay) are
importable directly from ``recede.ops`` and ``recede.core``.
"""

from __future__ import annotations

from types import SimpleNamespace

from . import checks as _checks
from . import core, ops
from .checkpoint import (
    CheckpointHandler,
    CheckpointRequest,
    CheckpointResponse,
    auto_checkpoint,
    console_checkpoint,
)
from .checks import CheckIO, CheckResult, CheckSpec
from .core import GateDecision, decay_score, gate, replay, replay_scope, update
from .ledger import FileLedger, Ledger, MemoryLedger
from .ops import act, checkpoint, seal
from .policy import Decay, Policy, Weights
from .recede import Recede, RunResult, TrustDelta
from .records import (
    ActionRecord,
    CheckKind,
    CheckRecord,
    Checkpoint,
    Decision,
    IntentRecord,
    Kind,
    Outcome,
    Result,
    Tier,
    TrustState,
    Verdict,
    Warrant,
)

__version__ = "0.1.0"

# `check.verify(...)` / `check.validate(...)` — mirrors the TS `check` object.
check = SimpleNamespace(verify=_checks.verify, validate=_checks.validate)

# `open` is a builtin; expose the intent-opening op under an unshadowed name too.
open_intent = ops.open

__all__ = [
    # front door
    "Recede",
    "RunResult",
    "TrustDelta",
    "check",
    "MemoryLedger",
    "FileLedger",
    "Ledger",
    "console_checkpoint",
    "auto_checkpoint",
    "Policy",
    "Weights",
    "Decay",
    # eight ops
    "open_intent",
    "act",
    "checkpoint",
    "seal",
    "gate",
    "update",
    "replay",
    "replay_scope",
    "decay_score",
    "GateDecision",
    # records + enums
    "IntentRecord",
    "ActionRecord",
    "CheckRecord",
    "Checkpoint",
    "Outcome",
    "TrustState",
    "Warrant",
    "Tier",
    "Kind",
    "CheckKind",
    "Verdict",
    "Result",
    "Decision",
    # check plumbing
    "CheckSpec",
    "CheckIO",
    "CheckResult",
    "CheckpointRequest",
    "CheckpointResponse",
    "CheckpointHandler",
    # namespaces
    "ops",
    "core",
    "__version__",
]
