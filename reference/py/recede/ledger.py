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
"""Ledger: append-only, hash-linked storage for records + Warrants (SPEC §3).

The core requires only *append-only + hash-linked*, not global consensus. Two
reference stores ship:

  * ``MemoryLedger``  — in-memory, for tests and the killer example.
  * ``FileLedger``    — append-only JSONL, one record per line (append-only-file
                        store from the README). Zero third-party deps.

Both persist finalized Warrants and can enumerate them for ``replay()``.
"""

from __future__ import annotations

import dataclasses
import json
import os
from typing import Iterable, Optional, Protocol

from .records import (
    ActionRecord,
    CheckRecord,
    Checkpoint,
    IntentRecord,
    Outcome,
    Warrant,
)


class Ledger(Protocol):
    """The storage contract the Recede runtime depends on."""

    def append(self, record: object) -> None: ...
    def commit(self, warrant: Warrant) -> None: ...
    def warrants(self) -> list[Warrant]: ...


def _warrant_to_dicts(w: Warrant) -> list[dict]:
    rows: list[dict] = [dataclasses.asdict(w.intent)]
    if w.action is not None:
        rows.append(dataclasses.asdict(w.action))
    rows.extend(dataclasses.asdict(c) for c in w.checks)
    if w.checkpoint is not None:
        rows.append(dataclasses.asdict(w.checkpoint))
    if w.outcome is not None:
        rows.append(dataclasses.asdict(w.outcome))
    return rows


class MemoryLedger:
    """In-memory append-only store. Records are appended individually as they are
    created; ``commit`` registers the finalized Warrant for replay."""

    def __init__(self) -> None:
        self._records: list[object] = []
        self._warrants: list[Warrant] = []

    def append(self, record: object) -> None:
        self._records.append(record)

    def commit(self, warrant: Warrant) -> None:
        self._warrants.append(warrant)

    def warrants(self) -> list[Warrant]:
        return list(self._warrants)

    def records(self) -> list[object]:
        return list(self._records)


class FileLedger:
    """Append-only JSONL ledger. Each committed Warrant flattens to one line per
    record. On construction it re-reads any existing file so replay survives a
    process restart."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._warrants: list[Warrant] = []
        if os.path.exists(path):
            self._load()

    def append(self, record: object) -> None:
        # File ledger persists at commit time (one atomic warrant append); the
        # per-record append is a no-op to keep the file free of partial chains.
        pass

    def commit(self, warrant: Warrant) -> None:
        self._warrants.append(warrant)
        with open(self.path, "a", encoding="utf-8") as fh:
            for row in _warrant_to_dicts(warrant):
                fh.write(json.dumps(row, sort_keys=True, ensure_ascii=False))
                fh.write("\n")
            fh.write(json.dumps({"kind": "WARRANT_END"}) + "\n")

    def warrants(self) -> list[Warrant]:
        return list(self._warrants)

    def _load(self) -> None:
        buf: list[dict] = []
        with open(self.path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if row.get("kind") == "WARRANT_END":
                    self._warrants.append(_dicts_to_warrant(buf))
                    buf = []
                else:
                    buf.append(row)


def _dicts_to_warrant(rows: list[dict]) -> Warrant:
    intent = action = outcome = checkpoint = None
    checks: list[CheckRecord] = []
    for row in rows:
        kind = row.get("kind")
        row = {k: (tuple(v) if isinstance(v, list) else v) for k, v in row.items()}
        if kind == "INTENT":
            intent = IntentRecord(**row)
        elif kind == "ACTION":
            action = ActionRecord(**row)
        elif kind == "CHECK":
            checks.append(CheckRecord(**row))
        elif kind == "CHECKPOINT":
            checkpoint = Checkpoint(**row)
        elif kind == "OUTCOME":
            outcome = Outcome(**row)
    assert intent is not None, "warrant with no intent record"
    return Warrant(
        intent=intent,
        action=action,
        checks=tuple(checks),
        outcome=outcome,
        checkpoint=checkpoint,
    )
