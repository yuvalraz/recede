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
"""The reference weighting profile ``recede/ref-weighting-v0.1`` (SPEC §4, §9).

A faithful port of the canonical TypeScript reference (``reference/ts/src/
weighting.ts``). SPEC §9 marks the weighting a *named reference profile*, not
normative core — but two implementations are cross-conformant iff, under the
SAME profile, they replay the same Warrants to the same TrustState. This module
reproduces the TS profile bit-for-bit so that holds.

The shape mirrors the TS reference exactly:

  * ``signal_of(warrant)``  → the signed, confidence-weighted signal of one Warrant
  * ``fold_signal(...)``    → the asymmetric (slow-earn / fast-lose) accrual
  * ``decay_score(...)``    → idle + drift relaxation toward the tier floor
  * ``tier_for(...)``       → score-implied tier capped by the confidence-implied tier (I5)

All functions here are PURE (I7): no I/O, no clock — time is always passed in.
"""

from __future__ import annotations

from dataclasses import dataclass

from .policy import Policy, tier_index, TIERS
from .records import CheckKind, Decision, Result, Tier, Verdict, Warrant


def clamp01(x: float) -> float:
    """Clamp to [0,1]."""
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def _clamp_signed(x: float) -> float:
    return -1.0 if x < -1 else 1.0 if x > 1 else x


@dataclass(frozen=True)
class Signal:
    """The signed, magnitude-weighted signal a sealed Warrant contributes.

    Mirrors the TS ``Signal`` interface. A Warrant with no closed Outcome and no
    decisive Checkpoint contributes nothing (trust-theater guard, SPEC §8)."""

    raw: float          # direction/magnitude in roughly [-1, +1] before scaling
    confidence: float   # mean check confidence; drives accrual + the I5 cap
    near_miss: bool     # an autonomous action was later overturned (ratchet)
    force_demote: bool  # a REVERTED / VALIDATE-FAIL / human REJECT|MODIFY forces demotion
    counts: bool        # whether this Warrant carries closed evidence at all


def _mean_confidence(warrant: Warrant) -> float:
    checks = warrant.checks
    if not checks:
        return 0.0
    return sum(c.confidence for c in checks) / len(checks)


def _checkpoints(warrant: Warrant) -> tuple:
    """The Warrant's checkpoint list (0 or 1 in this data model)."""
    return (warrant.checkpoint,) if warrant.checkpoint is not None else ()


def signal_of(warrant: Warrant) -> Signal:
    """Extract the trust signal from one Warrant. PURE. Ports TS ``signalOf``."""
    checks = warrant.checks
    conf = _mean_confidence(warrant)
    validate_fail = any(
        c.check_kind == CheckKind.VALIDATE.value and c.verdict == Verdict.FAIL.value
        for c in checks
    )
    any_fail = any(c.verdict == Verdict.FAIL.value for c in checks)
    any_inconclusive = any(c.verdict == Verdict.INCONCLUSIVE.value for c in checks)

    cps = _checkpoints(warrant)
    last_cp = cps[-1] if cps else None
    # Ran autonomously iff no gating checkpoint fired for it.
    ran_autonomously = len(cps) == 0

    out = warrant.outcome

    # No closed evidence at all -> moves nothing.
    if out is None and last_cp is None:
        return Signal(raw=0.0, confidence=conf, near_miss=False, force_demote=False, counts=False)

    # UNRESOLVED deferred outcomes are held out until re-sealed (SPEC §6).
    if out is not None and out.result == Result.UNRESOLVED.value:
        return Signal(raw=0.0, confidence=conf, near_miss=False, force_demote=False, counts=False)

    # --- Human decision contribution ---
    cp_raw = 0.0
    cp_force_demote = False
    if last_cp is not None:
        decision = last_cp.decision
        if decision == Decision.APPROVE.value:
            cp_raw = 1.0
        elif decision == Decision.MODIFY.value:
            cp_raw = -1.0
            cp_force_demote = True
        elif decision == Decision.REJECT.value:
            cp_raw = -1.0
            cp_force_demote = True
        elif decision == Decision.ESCALATE.value:
            cp_raw = 0.0  # deferred to a higher authority; no signal yet.

    # --- Outcome contribution ---
    out_raw = 0.0
    out_force_demote = False
    near_miss = False
    if out is not None:
        result = out.result
        if result == Result.SUCCESS.value:
            # Clean success only counts positively if checks did not contradict it.
            out_raw = -0.5 if (validate_fail or any_fail) else (0.3 if any_inconclusive else 1.0)
        elif result == Result.FAILURE.value:
            out_raw = -1.0
            out_force_demote = validate_fail
        elif result == Result.REVERTED.value:
            out_raw = -1.0
            out_force_demote = True
            # A reverted action that had run autonomously trips the ratchet.
            near_miss = ran_autonomously
    elif validate_fail or any_fail:
        # Checkpoint-only warrant but the checks already contradict the proposal.
        out_raw = -0.5

    # Combine: a contradicting human decision dominates a nominal success.
    if cp_raw != 0.0 and _sign(cp_raw) != _sign(out_raw):
        raw = cp_raw  # human overrides the machine's self-report
    else:
        raw = _clamp_signed(cp_raw + out_raw)

    return Signal(
        raw=raw,
        confidence=conf,
        near_miss=near_miss,
        force_demote=cp_force_demote or out_force_demote,
        counts=True,
    )


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def fold_signal(
    score: float,
    confidence: float,
    sample_count: int,
    s: Signal,
    policy: Policy,
) -> tuple[float, float]:
    """Fold one signal into a running (score, confidence) pair — the asymmetric
    accrual. Ports TS ``foldSignal``. Returns ``(score, confidence)``."""
    if not s.counts:
        return (score, confidence)

    w = policy.weights
    if s.raw >= 0:
        # Diminishing returns: closer to 1 => smaller step. Weight by confidence.
        step = w.positive_gain * s.raw * s.confidence * (1.0 - score)
        next_score = score + step
    else:
        # Asymmetric: negatives move faster. Not damped by (1 - score).
        step = w.positive_gain * s.raw * w.negative_multiplier
        next_score = score + step  # s.raw is negative -> subtracts

    if s.near_miss:
        next_score -= w.near_miss_debit

    # Confidence accrues with diminishing returns; nudged down by low-confidence
    # or negative evidence.
    conf_step = w.confidence_gain * (1.0 - confidence)
    if s.raw >= 0 and s.confidence > 0:
        next_conf = confidence + conf_step * s.confidence
    else:
        next_conf = confidence - conf_step * 0.5

    return (clamp01(next_score), clamp01(next_conf))


def decay_score(
    score: float,
    tier: Tier,
    idle_ms: float,
    drift: float,
    policy: Policy,
) -> float:
    """Time + drift decay. Ports TS ``decayScore``. Score relaxes toward the
    current tier's score floor over an idle window (exponential, half-life from
    policy), then is discounted by input-distribution drift in [0,1]."""
    floors = policy.weights.score_tier_floor
    idx = tier_index(tier)
    floor = floors[idx] if 0 <= idx < len(floors) else 0.0
    half_life = policy.decay.idle_half_life_ms
    factor = (0.5 ** (max(0.0, idle_ms) / half_life)) if half_life > 0 else 1.0
    # Relax toward floor by (1 - factor).
    decayed = floor + (score - floor) * factor
    # Drift discount: pull further toward floor proportional to drift.
    d = clamp01(drift) * policy.decay.drift_discount
    decayed = decayed - (decayed - floor) * d
    return clamp01(decayed)


def tier_for(score: float, sample_count: int, policy: Policy) -> Tier:
    """The tier for a (score, sample_count) pair. Ports TS ``tierFor``. This is
    where the confidence cap (I5) lives: the tier is the LOWER of the
    score-implied tier and the confidence/sample-implied tier."""
    w = policy.weights

    score_tier = 0
    for i in range(len(TIERS) - 1, -1, -1):
        if score >= w.score_tier_floor[i]:
            score_tier = i
            break

    conf_tier = 0
    for i in range(len(TIERS) - 1, -1, -1):
        if sample_count >= w.confidence_samples_per_tier[i]:
            conf_tier = i
            break

    # I5: the confidence-implied tier caps the score-implied tier.
    return Tier.from_rank(min(score_tier, conf_tier))
