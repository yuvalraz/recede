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
"""Black-box conformance: invariants I1-I7, gate/update/replay purity, and
replay reproducibility. stdlib ``unittest`` only — no third-party deps."""

from __future__ import annotations

import copy
import unittest
from datetime import datetime, timedelta, timezone

from recede import (
    MemoryLedger,
    Policy,
    Recede,
    Result,
    Tier,
    TrustState,
    Warrant,
    auto_checkpoint,
    check,
    core,
    ops,
)


# --- helpers ----------------------------------------------------------------

def make_warrant(
    actor: str,
    task_type: str,
    risk: str,
    *,
    result: str = Result.SUCCESS.value,
    verify_pass: bool = True,
    validate_pass: bool = True,
    decision: str | None = None,
    ts: str = "2026-01-01T00:00:00+00:00",
) -> Warrant:
    intent = ops.open(actor, task_type, "do the thing", risk, ts=ts)
    action = ops.act(intent, ["op1"], result="ok", ts=ts)
    checks = (
        ops.check(action, "VERIFY", "schema", "PASS" if verify_pass else "FAIL", 1.0, ts=ts),
        ops.check(action, "VALIDATE", "policy", "PASS" if validate_pass else "FAIL", 0.8, ts=ts),
    )
    cp = None
    if decision is not None:
        cp = ops.checkpoint(
            intent.id, "review", [], "summary", decision=decision, reviewer="h", ts=ts
        )
    outcome = ops.seal(intent.id, result, "test", ts=ts)
    return Warrant(intent=intent, action=action, checks=checks, outcome=outcome, checkpoint=cp)


def climb(state: TrustState, policy: Policy, n: int, **kw) -> TrustState:
    for _ in range(n):
        state = core.update(state, make_warrant(state.actor, state.task_type, "read.only", **kw), policy)
    return state


# --- I1: scope isolation ----------------------------------------------------

class TestI1ScopeIsolation(unittest.TestCase):
    def test_score_does_not_leak_across_task_types(self):
        policy = Policy()
        s_email = TrustState.cold_start("bot", "email.draft")
        s_refund = TrustState.cold_start("bot", "refund.issue")
        s_email = climb(s_email, policy, 30)
        # refund scope untouched by email evidence
        self.assertEqual(s_refund.sample_count, 0)
        self.assertEqual(s_refund.score, 0.0)
        self.assertEqual(s_refund.tier, Tier.T0.value)
        self.assertGreater(s_email.score, 0.5)

    def test_replay_partitions_by_scope(self):
        policy = Policy()
        warrants = [
            make_warrant("bot", "email.draft", "read.only"),
            make_warrant("bot", "refund.issue", "read.only"),
            make_warrant("bot", "email.draft", "read.only"),
        ]
        states = core.replay(warrants, policy)
        self.assertEqual(states[("bot", "email.draft")].sample_count, 2)
        self.assertEqual(states[("bot", "refund.issue")].sample_count, 1)

    def test_replay_scope_ignores_other_scopes(self):
        policy = Policy()
        warrants = [
            make_warrant("bot", "a", "read.only"),
            make_warrant("bot", "b", "read.only"),
            make_warrant("other", "a", "read.only"),
        ]
        s = core.replay_scope(warrants, "bot", "a", policy)
        self.assertEqual(s.sample_count, 1)


# --- I2: reconstructability -------------------------------------------------

class TestI2Reconstructability(unittest.TestCase):
    def test_replay_equals_live_state(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        ok = check.verify("ok", lambda io: True)
        for i in range(25):
            r.run(lambda: {"n": i}, actor="bot", task_type="t", intent="i", risk="read.only", checks=[ok])
        live = r.trust("bot", "t")
        replayed = r.replay()[("bot", "t")]
        self.assertEqual(replayed, live)

    def test_replay_after_revert_matches(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        for i in range(10):
            out = r.run(lambda: 1, actor="bot", task_type="t", intent="i", risk="read.only")
        r.reseal(out.warrant, Result.REVERTED.value, "fraud")
        live = r.trust("bot", "t")
        replayed = r.replay()[("bot", "t")]
        self.assertEqual(replayed, live)


# --- I3: irreversible floor -------------------------------------------------

class TestI3IrreversibleFloor(unittest.TestCase):
    def test_never_recede_gated_at_every_tier(self):
        policy = Policy()  # irreversible.critical is in never_recede
        for rank in range(5):
            state = TrustState("bot", "t", tier=f"T{rank}", score=1.0, confidence=1.0, sample_count=999)
            decision = core.gate(state, "irreversible.critical", policy)
            self.assertFalse(decision.autonomous, f"T{rank} must still gate irreversible")

    def test_maxed_trust_still_gates_irreversible(self):
        policy = Policy()
        state = TrustState("bot", "t", tier="T4", score=1.0, confidence=1.0, sample_count=10_000)
        self.assertFalse(core.gate(state, "irreversible.critical", policy).autonomous)


# --- I4: trust can decrease -------------------------------------------------

class TestI4TrustCanDecrease(unittest.TestCase):
    def test_failure_lowers_score(self):
        policy = Policy()
        s = climb(TrustState.cold_start("bot", "t"), policy, 20)
        high = s.score
        s2 = core.update(s, make_warrant("bot", "t", "read.only", result=Result.FAILURE.value), policy)
        self.assertLess(s2.score, high)

    def test_loss_exceeds_gain(self):
        policy = Policy()
        base = TrustState("bot", "t", score=0.5, confidence=0.5, sample_count=10)
        up = core.update(base, make_warrant("bot", "t", "read.only", result=Result.SUCCESS.value), policy)
        down = core.update(base, make_warrant("bot", "t", "read.only", result=Result.FAILURE.value), policy)
        gain = up.score - base.score
        loss = base.score - down.score
        self.assertGreater(loss, gain, "asymmetry: loss must exceed gain")

    def test_revert_forces_demotion(self):
        policy = Policy()
        s = climb(TrustState.cold_start("bot", "t"), policy, 60)
        self.assertIn(s.tier, (Tier.T3.value, Tier.T4.value))
        s2 = core.update(s, make_warrant("bot", "t", "read.only", result=Result.REVERTED.value), policy)
        self.assertLess(Tier(s2.tier).rank, Tier(s.tier).rank)


# --- I5: confidence cap -----------------------------------------------------

class TestI5ConfidenceCap(unittest.TestCase):
    def test_high_score_tiny_sample_capped_at_t1(self):
        policy = Policy()
        # One lucky run: force a high score but sample_count=1.
        state = TrustState("bot", "t", score=0.99, confidence=0.99, sample_count=1)
        tier = core.effective_tier(state, policy)
        self.assertLessEqual(tier.rank, 1, "one lucky run must not promote past T1")

    def test_cap_lifts_as_samples_grow(self):
        policy = Policy()
        ranks = []
        # Sample thresholds are the reference profile's confidence_samples_per_tier
        # ([0, 3, 10, 25, 60]); T4 requires >= 60 samples.
        for n in (1, 3, 10, 25, 60):
            state = TrustState("bot", "t", score=0.99, confidence=0.99, sample_count=n)
            ranks.append(core.effective_tier(state, policy).rank)
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(ranks[-1], 4)


# --- I6: policy replay (digest on every decision) ---------------------------

class TestI6PolicyDigest(unittest.TestCase):
    def test_every_gate_decision_carries_policy_digest(self):
        policy = Policy()
        state = TrustState.cold_start("bot", "t")
        for risk in ("read.only", "financial.reversible", "irreversible.critical"):
            d = core.gate(state, risk, policy)
            self.assertEqual(d.policy_digest, policy.digest())

    def test_digest_changes_when_policy_changes(self):
        import dataclasses

        from recede import Weights

        p1 = Policy()
        # Change any decision-affecting rule (a weight) -> the digest must move.
        p2 = Policy(weights=dataclasses.replace(Weights(), positive_gain=0.99))
        self.assertNotEqual(p1.digest(), p2.digest())

    def test_digest_stable_for_same_policy(self):
        self.assertEqual(Policy().digest(), Policy().digest())


# --- I7: purity -------------------------------------------------------------

class TestI7Purity(unittest.TestCase):
    def test_gate_deterministic(self):
        policy = Policy()
        state = TrustState("bot", "t", score=0.6, confidence=0.6, sample_count=10)
        d1 = core.gate(state, "reversible.low", policy)
        d2 = core.gate(state, "reversible.low", policy)
        self.assertEqual(d1, d2)

    def test_gate_does_not_mutate_inputs(self):
        policy = Policy()
        state = TrustState("bot", "t", score=0.6, confidence=0.6, sample_count=10)
        snap = copy.deepcopy(state)
        pdigest = policy.digest()
        core.gate(state, "reversible.low", policy)
        self.assertEqual(state, snap)
        self.assertEqual(policy.digest(), pdigest)

    def test_update_does_not_mutate_inputs(self):
        policy = Policy()
        state = TrustState("bot", "t", score=0.5, confidence=0.5, sample_count=5)
        snap = copy.deepcopy(state)
        w = make_warrant("bot", "t", "read.only")
        core.update(state, w, policy)
        self.assertEqual(state, snap)  # frozen dataclass; a fresh copy is returned

    def test_update_deterministic(self):
        policy = Policy()
        state = TrustState("bot", "t", score=0.5, confidence=0.5, sample_count=5)
        w = make_warrant("bot", "t", "read.only")
        self.assertEqual(core.update(state, w, policy), core.update(state, w, policy))

    def test_replay_deterministic(self):
        policy = Policy()
        warrants = [make_warrant("bot", "t", "read.only") for _ in range(10)]
        self.assertEqual(core.replay(warrants, policy), core.replay(warrants, policy))

    def test_replay_does_not_mutate_warrants(self):
        policy = Policy()
        warrants = [make_warrant("bot", "t", "read.only") for _ in range(5)]
        snap = copy.deepcopy(warrants)
        core.replay(warrants, policy)
        self.assertEqual(warrants, snap)


# --- reference weighting properties -----------------------------------------

class TestReferenceWeighting(unittest.TestCase):
    def test_diminishing_returns(self):
        policy = Policy()
        low = TrustState("bot", "t", score=0.1, confidence=0.5, sample_count=10)
        high = TrustState("bot", "t", score=0.8, confidence=0.5, sample_count=10)
        gain_low = core.update(low, make_warrant("bot", "t", "read.only"), policy).score - low.score
        gain_high = core.update(high, make_warrant("bot", "t", "read.only"), policy).score - high.score
        self.assertGreater(gain_low, gain_high)

    def test_near_miss_ratchet_heavier_than_plain_failure(self):
        policy = Policy()
        s = TrustState("bot", "t", score=0.8, confidence=0.8, sample_count=30)
        # Autonomous (no checkpoint) reverted run — the ratchet.
        reverted = core.update(s, make_warrant("bot", "t", "read.only", result=Result.REVERTED.value), policy)
        failed = core.update(s, make_warrant("bot", "t", "read.only", result=Result.FAILURE.value), policy)
        self.assertLess(reverted.score, failed.score)

    def test_human_modify_scored_as_validate_fail(self):
        policy = Policy()
        s = TrustState("bot", "t", score=0.6, confidence=0.6, sample_count=20)
        # SUCCESS outcome but human MODIFY on the proposal -> negative.
        w = make_warrant("bot", "t", "read.only", result=Result.SUCCESS.value, decision="MODIFY")
        after = core.update(s, w, policy)
        self.assertLess(after.score, s.score)

    def test_unresolved_moves_nothing(self):
        policy = Policy()
        s = TrustState("bot", "t", score=0.5, confidence=0.5, sample_count=10)
        w = make_warrant("bot", "t", "read.only", result=Result.UNRESOLVED.value)
        after = core.update(s, w, policy)
        self.assertEqual(after.score, s.score)
        self.assertEqual(after.confidence, s.confidence)

    def test_decay_toward_floor_not_zero(self):
        policy = Policy()
        s = climb(TrustState.cold_start("bot", "t"), policy, 40)
        s = TrustState(**{**s.to_dict(), "updated": "2026-01-01T00:00:00+00:00"})
        later = datetime(2026, 6, 1, tzinfo=timezone.utc)  # ~5 months idle
        decayed = core.decay_score(s, later, policy)
        self.assertLess(decayed.score, s.score)
        self.assertGreaterEqual(decayed.score, 0.0)


# --- trust theater guard ----------------------------------------------------

class TestTrustTheater(unittest.TestCase):
    def test_outcomeless_warrant_moves_nothing(self):
        policy = Policy()
        s = TrustState("bot", "t", score=0.5, confidence=0.5, sample_count=10)
        intent = ops.open("bot", "t", "x", "read.only")
        w = Warrant(intent=intent, outcome=None)
        after = core.update(s, w, policy)
        # Trust theater guard: no *trust* movement. (The reducer always
        # re-derives the tier from score+sample_count, so tier may normalize;
        # score/confidence/sample_count MUST NOT move on outcome-less evidence.)
        self.assertEqual(after.score, s.score)
        self.assertEqual(after.confidence, s.confidence)
        self.assertEqual(after.sample_count, s.sample_count)


if __name__ == "__main__":
    unittest.main()
