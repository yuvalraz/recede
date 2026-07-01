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
"""Canonical serialization + content-addressing (SPEC §3).

`id = hash(canonical_serialize(record))` where the canonical form omits the
volatile ``id`` and ``sig`` fields, sorts object keys, and drops nulls — so two
implementations that agree on the record body agree on the hash. Mirrors the
TypeScript reference's ``canonical.ts``.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Fields excluded from the hash pre-image: id is the hash itself; sig is a
# reserved, post-hoc attestation (SPEC §3, §10).
_OMIT = ("id", "sig")


def canonical_serialize(value: Any) -> str:
    """Deterministic JSON: sorted keys, no whitespace, null/omitted keys dropped."""
    return json.dumps(
        _strip(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _strip(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: _strip(v)
            for k, v in value.items()
            if k not in _OMIT and v is not None
        }
    if isinstance(value, (list, tuple)):
        return [_strip(v) for v in value]
    return value


def content_id(body: dict[str, Any]) -> str:
    """The content hash of a record body (``id``/``sig`` omitted)."""
    digest = hashlib.sha256(canonical_serialize(body).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def digest(text: str) -> str:
    """A short content digest for inputs/results (not a record id)."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
