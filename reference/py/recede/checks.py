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
"""First-class Verify/Validate checks (SPEC §3, README).

Two builders mirror the TypeScript ``check.verify`` / ``check.validate``:

    from recede import check
    amount_ok = check.verify("amount", lambda io: io.output["amount"] <= io.input["total"])
    policy_ok = check.validate("policy", lambda io: {"ok": judge(io), "confidence": 0.8})

* ``verify`` — did-it-*right*. The fn returns a boolean-ish value; PASS/FAIL.
* ``validate`` — did-the-*right-thing*. The fn returns ``{ok, confidence}``
  (sync or async); confidence flows into the CheckRecord.

Both accept sync or async callables so the same spec works in either style; the
runtime awaits when needed. A CheckSpec is a plain data holder — running it
against an IO context yields the verdict + confidence the runtime seals into a
CheckRecord.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Union

from .records import CheckKind, Verdict


@dataclass(frozen=True)
class CheckIO:
    """The context a check sees: the declared intent, the call inputs, and the
    produced output."""

    intent: str
    input: Any
    output: Any


@dataclass(frozen=True)
class CheckResult:
    verdict: str
    confidence: float
    method: str
    kind: str


@dataclass(frozen=True)
class CheckSpec:
    name: str
    kind: str  # CheckKind value
    fn: Callable[[CheckIO], Any]

    async def run(self, io: CheckIO) -> CheckResult:
        raw = self.fn(io)
        if inspect.isawaitable(raw):
            raw = await raw
        return _interpret(self.kind, self.name, raw)


def _interpret(kind: str, name: str, raw: Any) -> CheckResult:
    if kind == CheckKind.VERIFY.value:
        # boolean-ish -> PASS/FAIL, full confidence (a deterministic check).
        ok = bool(raw)
        return CheckResult(
            verdict=Verdict.PASS.value if ok else Verdict.FAIL.value,
            confidence=1.0,
            method=name,
            kind=kind,
        )
    # VALIDATE: expect {ok, confidence}; tolerate a bare bool.
    if isinstance(raw, dict):
        ok = bool(raw.get("ok"))
        conf = float(raw.get("confidence", 0.5))
    else:
        ok = bool(raw)
        conf = 0.5
    verdict = Verdict.PASS.value if ok else Verdict.FAIL.value
    return CheckResult(verdict=verdict, confidence=max(0.0, min(1.0, conf)), method=name, kind=kind)


CheckFn = Callable[[CheckIO], Union[Any, Awaitable[Any]]]


def verify(name: str, fn: CheckFn) -> CheckSpec:
    """Build a VERIFY check ("did it right"). ``fn(io) -> bool-ish``."""
    return CheckSpec(name=name, kind=CheckKind.VERIFY.value, fn=fn)


def validate(name: str, fn: CheckFn) -> CheckSpec:
    """Build a VALIDATE check ("right thing"). ``fn(io) -> {ok, confidence}``."""
    return CheckSpec(name=name, kind=CheckKind.VALIDATE.value, fn=fn)
