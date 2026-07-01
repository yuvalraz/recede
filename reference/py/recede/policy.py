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
"""Policy: the versioned ``(RiskClass × Tier) → gate`` matrix + weighting/decay
params + never-recede ceiling (SPEC §3, §5).

A faithful port of the canonical TypeScript reference (``reference/ts/src/
policy.ts``). The weighting/decay parameters and the gate matrix reproduce the
named reference profile ``recede/ref-weighting-v0.1`` bit-for-bit, so identical
Warrants replay to identical TrustState across the two implementations.

The Policy carries a **digest** (I6): every gate decision references the exact
policy that produced it.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any

from .canonical import content_id
from .records import Tier


# Ordered trust tiers. Index gives the ordering the Gate relies on.
TIERS: tuple[str, ...] = ("T0", "T1", "T2", "T3", "T4")


def tier_index(t: Tier | str) -> int:
    value = t.value if isinstance(t, Tier) else t
    return TIERS.index(value)


# A gate cell: autonomous, or require a checkpoint at a named altitude.
@dataclass(frozen=True)
class GateCell:
    kind: str                 # "AUTONOMOUS" | "REQUIRE_CHECKPOINT"
    altitude: str | None = None


AUTONOMOUS = GateCell(kind="AUTONOMOUS")


def _cp(altitude: str) -> GateCell:
    return GateCell(kind="REQUIRE_CHECKPOINT", altitude=altitude)


# Reference risk taxonomy, ordered by stakes ascending.
RISK_ORDER: tuple[str, ...] = (
    "read.only",
    "reversible.low",
    "financial.reversible",
    "irreversible.critical",
)


@dataclass(frozen=True)
class Weights:
    """Reference weighting parameters (SPEC §4), matching the TS reference.

    Asymmetric by design: negatives move ``negative_multiplier``× faster than a
    fully-confident positive, so trust is earned slowly and lost fast (I4)."""

    # How much a fully-confident positive outcome raises raw score.
    positive_gain: float = 0.12
    # Penalty multiplier: negatives move score this many times faster.
    negative_multiplier: float = 3.0
    # Extra one-shot debit when an autonomous action is later overturned.
    near_miss_debit: float = 0.25
    # Confidence gained per confirmed sample (diminishing via sample_count).
    confidence_gain: float = 0.14
    # Minimum samples required per tier index (0..4) to lift the confidence cap.
    confidence_samples_per_tier: tuple[int, ...] = (0, 3, 10, 25, 60)
    # Score thresholds (lower bound) to be eligible for each tier index (0..4).
    score_tier_floor: tuple[float, ...] = (0.0, 0.35, 0.55, 0.75, 0.9)


@dataclass(frozen=True)
class Decay:
    """Staleness + drift discount (SPEC §4), matching the TS reference."""

    # Idle half-life in milliseconds; score decays toward its tier floor.
    idle_half_life_ms: float = 1000.0 * 60 * 60 * 24 * 30  # 30 days
    # Drift discount applied per unit of normalized input-distribution drift.
    drift_discount: float = 0.5


def _default_matrix() -> dict[str, dict[str, GateCell]]:
    """The reference default matrix (SPEC §4). Encodes the tier ladder:
      - T0: everything gated.
      - T1: gated except read.only.
      - T2: low-risk autonomous; high/critical gated.
      - T3: autonomous up to high (financial.reversible); critical gated.
      - T4: autonomous incl. high risk; irreversible.critical still gated (I3).
    """

    def row(cells: list[GateCell]) -> dict[str, GateCell]:
        return {"T0": cells[0], "T1": cells[1], "T2": cells[2], "T3": cells[3], "T4": cells[4]}

    return {
        # risk                    T0          T1           T2           T3      T4
        "read.only":              row([_cp("full"), AUTONOMOUS,   AUTONOMOUS,   AUTONOMOUS,   AUTONOMOUS]),
        "reversible.low":         row([_cp("full"), _cp("brief"), AUTONOMOUS,   AUTONOMOUS,   AUTONOMOUS]),
        "financial.reversible":   row([_cp("full"), _cp("full"),  _cp("brief"), AUTONOMOUS,   AUTONOMOUS]),
        "irreversible.critical":  row([_cp("full"), _cp("full"),  _cp("full"),  _cp("full"),  _cp("full")]),
    }


@dataclass(frozen=True)
class Policy:
    id: str = "recede.reference"
    version: str = "0.1.0"
    # matrix[risk][tier] -> gate cell.
    matrix: dict[str, dict[str, GateCell]] = field(default_factory=_default_matrix)
    weights: Weights = field(default_factory=Weights)
    decay: Decay = field(default_factory=Decay)
    # RiskClasses that MUST keep a checkpoint at every tier (I3).
    never_recede: tuple[str, ...] = ("irreversible.critical",)

    def is_never_recede(self, risk: str) -> bool:
        return risk in self.never_recede

    def matrix_cell(self, risk: str, tier: Tier | str) -> GateCell:
        """Look up a matrix cell, tolerating an unknown RiskClass by treating it
        as the most conservative known class (always require a checkpoint)."""
        rrow = self.matrix.get(risk)
        if rrow is None:
            return _cp("full")
        value = tier.value if isinstance(tier, Tier) else tier
        return rrow[value]

    def _digest_body(self) -> dict[str, Any]:
        """Decision-affecting fields, in a shape that mirrors the TS policy digest
        pre-image so the digest is stable and rule-sensitive (I6)."""

        def cell(c: GateCell) -> dict[str, Any]:
            d: dict[str, Any] = {"kind": c.kind}
            if c.altitude is not None:
                d["altitude"] = c.altitude
            return d

        return {
            "id": self.id,
            "version": self.version,
            "matrix": {
                risk: {tier: cell(c) for tier, c in rrow.items()}
                for risk, rrow in self.matrix.items()
            },
            "weights": {
                "positive_gain": self.weights.positive_gain,
                "negative_multiplier": self.weights.negative_multiplier,
                "near_miss_debit": self.weights.near_miss_debit,
                "confidence_gain": self.weights.confidence_gain,
                "confidence_samples_per_tier": list(self.weights.confidence_samples_per_tier),
                "score_tier_floor": list(self.weights.score_tier_floor),
            },
            "decay": {
                "idle_half_life_ms": self.decay.idle_half_life_ms,
                "drift_discount": self.decay.drift_discount,
            },
            "never_recede": list(self.never_recede),
        }

    def digest(self) -> str:
        """Content digest binding a gate decision to this exact policy (I6).

        Routed through ``content_id`` (canonical_serialize + sha256) so it is
        deterministic and rule-sensitive: any change to a matrix cell, weight,
        decay param, or never-recede entry moves the digest."""
        return content_id(self._digest_body())
