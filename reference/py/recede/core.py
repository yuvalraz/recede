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
"""The PURE core: gate / update / replay (SPEC §5, §6, invariant I7).

A faithful port of the canonical TypeScript reference (``reference/ts/src/
gate.ts`` + ``trust.ts``). None of these functions touch a ledger, a clock, or
any I/O; given the same inputs they return the same outputs. This is what makes
"oversight recedes as trust is earned" a provable property rather than a vibe.

The record-emitting operations (open/act/check/checkpoint/seal) live in
``recede.ops`` — they are constructors, not the reducer.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Optional

from . import weighting
from .policy import Policy, TIERS, tier_index
from .records import Tier, TrustState, Warrant


# --- gate decision ----------------------------------------------------------

@dataclass(frozen=True)
class GateDecision:
    autonomous: bool
    reason: str
    policy_digest: str            # I6: bind the decision to the exact policy
    altitude: Optional[str] = None  # set only when a checkpoint is required


def effective_tier(state: TrustState, policy: Policy) -> Tier:
    """Resolve the tier the Gate uses: the LOWER of the score-implied tier and
    the confidence-implied cap (I5). One lucky run cannot promote past the cap.

    Ports TS ``tierFor(score, sample_count, policy)``."""
    return weighting.tier_for(state.score, state.sample_count, policy)


def gate(state: TrustState, declared_risk: str, policy: Policy) -> GateDecision:
    """PURE (I7). Decide whether the next action of ``declared_risk`` may run
    autonomously given current trust, or must pause at a human checkpoint.

    Ports TS ``gate``. Order of reasoning:
      1. If the risk is in never_recede[], gate always (I3) — the floor.
      2. Otherwise consult the (RiskClass × Tier) matrix cell for the trust tier.

    Monotone by construction: higher tier and lower risk ⇒ less oversight."""
    digest = policy.digest()

    # I3 — irreversible floor: always gated, at every tier.
    if policy.is_never_recede(declared_risk):
        return GateDecision(
            autonomous=False,
            reason=f"never_recede: '{declared_risk}' retains a checkpoint at every tier (I3)",
            policy_digest=digest,
            altitude="full",
        )

    tier = effective_tier(state, policy)
    cell = policy.matrix_cell(declared_risk, tier)
    if cell.kind == "AUTONOMOUS":
        return GateDecision(
            autonomous=True,
            reason=f"tier {tier.value} is autonomous for risk '{declared_risk}'",
            policy_digest=digest,
        )
    return GateDecision(
        autonomous=False,
        reason=f"tier {tier.value} requires checkpoint for risk '{declared_risk}'",
        policy_digest=digest,
        altitude=cell.altitude,
    )


# --- update reducer ---------------------------------------------------------

def update(
    state: TrustState,
    warrant: Warrant,
    policy: Policy,
    *,
    idle_ms: float = 0.0,
    drift: float = 0.0,
    now: Optional[str] = None,
) -> TrustState:
    """PURE reducer (I7). Fold one sealed Warrant into a TrustState, returning a
    fresh state. Optionally apply idle/drift decay first, given the elapsed idle
    time and drift since the last update. Ports TS ``update``.

    Only *closed* evidence moves trust (trust-theater guard): an UNRESOLVED or
    outcome-less warrant is a no-op on score. Trust can decrease (I4)."""
    # 1. Decay toward the current tier floor for the idle gap + drift.
    score = state.score
    if idle_ms > 0 or drift > 0:
        score = weighting.decay_score(score, Tier(state.tier), idle_ms, drift, policy)

    # 2. Fold the warrant's signal.
    s = weighting.signal_of(warrant)
    confidence = state.confidence
    sample_count = state.sample_count

    if s.counts:
        score, confidence = weighting.fold_signal(score, confidence, sample_count, s, policy)
        sample_count += 1

    # 3. Derive the tier from (score, sample_count) under the confidence cap.
    to_tier = weighting.tier_for(score, sample_count, policy)

    # 4. Forced demotion: a REVERTED outcome / VALIDATE-FAIL / human REJECT|MODIFY
    #    drops at least one tier regardless of the derived tier (SPEC §4).
    if s.force_demote:
        forced = max(0, tier_index(state.tier) - 1)
        if tier_index(to_tier) > forced:
            to_tier = Tier(TIERS[forced])

    return replace(
        state,
        tier=to_tier.value,
        score=weighting.clamp01(score),
        confidence=weighting.clamp01(confidence),
        sample_count=sample_count,
        window_ref=(warrant.outcome.id if warrant.outcome is not None else warrant.intent.id)
        or state.window_ref,
        updated=now if now is not None else state.updated,
    )


# --- replay -----------------------------------------------------------------

def replay(warrants: list[Warrant], policy: Policy) -> dict[tuple[str, str], TrustState]:
    """PURE (I7, I2). Reconstruct every ``(actor, task_type)`` TrustState by
    folding its sealed Warrants in order through ``update``. The result MUST
    equal the stored state accumulated live (invariant I2).

    Scope isolation (I1): each warrant only affects its own scope's state."""
    states: dict[tuple[str, str], TrustState] = {}
    for w in warrants:
        scope = w.scope
        state = states.get(scope) or TrustState.cold_start(*scope)
        states[scope] = update(state, w, policy)
    return states


def replay_scope(
    warrants: list[Warrant], actor: str, task_type: str, policy: Policy
) -> TrustState:
    """Replay a single scope. I1: warrants for other scopes are ignored."""
    state = TrustState.cold_start(actor, task_type)
    for w in warrants:
        if w.scope == (actor, task_type):
            state = update(state, w, policy)
    return state


# --- decay (pure, applied on demand) ----------------------------------------

def decay_score(state: TrustState, now: datetime, policy: Policy) -> TrustState:
    """PURE. Apply staleness decay toward the tier floor given an explicit
    ``now`` (never reads a clock itself). Exposed separately so callers control
    when decay is realized; the reducer stays free of wall-clock coupling.

    Delegates the arithmetic to the reference ``weighting.decay_score`` so the
    relaxation target (the tier's score floor) matches the reference profile."""
    if state.updated is None:
        return state
    try:
        last = datetime.fromisoformat(state.updated)
    except ValueError:
        return state
    idle_seconds = (now - last).total_seconds()
    if idle_seconds <= 0:
        return state
    idle_ms = idle_seconds * 1000.0
    decayed = weighting.decay_score(state.score, Tier(state.tier), idle_ms, 0.0, policy)
    return replace(state, score=weighting.clamp01(decayed))
