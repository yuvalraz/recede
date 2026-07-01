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
"""Cross-language conformance: replay the SHARED vector (conformance/vectors.json)
and assert this implementation reproduces the expected final TrustState (score to
1e-9), the intermediate peak, the never_recede gate, and the pinned record hash.

The TypeScript suite (reference/ts/test/conformance.test.ts) loads the same
vector and MUST reach the identical results — the demonstration required by
SPEC §9 (two implementations are cross-conformant iff, under the SAME weighting
profile, they replay the same Warrants to the same TrustState)."""

from __future__ import annotations

import json
import os
import unittest

from recede import Policy, TrustState, Warrant, core, ops
from recede.canonical import canonical_serialize, content_id

# conformance/vectors.json lives at the repo root: reference/py/tests -> repo/
_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "conformance", "vectors.json"))

with open(_VECTORS, encoding="utf-8") as _fh:
    VEC = json.load(_fh)

ACTOR = VEC["scope"]["actor"]
TASK = VEC["scope"]["task_type"]
GTS = VEC["ground_truth_source"]


def _build_warrant(e: dict) -> Warrant:
    intent = ops.open(ACTOR, TASK, "issue refund", e["risk"], ts=e["ts"])
    action = ops.act(intent, ["refund"], result="ok", ts=e["ts"])
    checks = tuple(
        ops.check(action, c["kind"], "m", c["verdict"], c["confidence"], ts=e["ts"])
        for c in e.get("checks", [])
    )
    cp = None
    if e.get("decision"):
        cp = ops.checkpoint(
            intent.id, "gate", [], "full",
            decision=e["decision"], reviewer="human", ts=e["ts"],
        )
    outcome = None
    if e.get("result"):
        outcome = ops.seal(
            intent.id, e["result"], GTS,
            human_touched=cp is not None, actor=ACTOR, ts=e["ts"],
        )
    return Warrant(intent=intent, action=action, checks=checks, outcome=outcome, checkpoint=cp)


def _replay_vector() -> tuple[TrustState, TrustState | None]:
    policy = Policy()
    peak_before = VEC.get("checkpoints", {}).get("before_index")
    state = TrustState.cold_start(ACTOR, TASK)
    peak: TrustState | None = None
    for i, e in enumerate(VEC["entries"]):
        if peak_before is not None and i == peak_before:
            peak = state
        w = _build_warrant(e)
        state = core.update(
            state, w, policy,
            idle_ms=e.get("idle_ms", 0.0),
            drift=e.get("drift", 0.0),
            now=e.get("now"),
        )
    return state, peak


class TestConformanceVector(unittest.TestCase):
    def test_final_trust_state_matches(self):
        final, _ = _replay_vector()
        exp = VEC["expected_final_trust"]
        self.assertEqual(final.tier, exp["tier"], "tier must match")
        self.assertEqual(final.sample_count, exp["sample_count"], "sample_count must match")
        self.assertAlmostEqual(final.score, exp["score"], delta=1e-9)
        self.assertAlmostEqual(final.confidence, exp["confidence"], delta=1e-9)

    def test_intermediate_peak_matches(self):
        _, peak = _replay_vector()
        self.assertIsNotNone(peak, "expected an intermediate checkpoint")
        exp = VEC["checkpoints"]["expected"]
        self.assertEqual(peak.tier, exp["tier"])
        self.assertEqual(peak.sample_count, exp["sample_count"])
        self.assertAlmostEqual(peak.score, exp["score"], delta=1e-9)

    def test_never_recede_gate(self):
        policy = Policy()
        for g in VEC["gate_checks"]:
            s = g["state"]
            state = TrustState(
                ACTOR, TASK,
                tier=s["tier"], score=s["score"],
                confidence=s["confidence"], sample_count=s["sample_count"],
            )
            d = core.gate(state, g["risk"], policy)
            self.assertEqual(d.autonomous, g["expect_autonomous"], f"gate for {g['risk']}")

    def test_pinned_record_hash_matches(self):
        rec = VEC["expected_record_hash"]["record"]
        body = {k: v for k, v in rec.items() if k not in ("id", "sig")}
        self.assertEqual(
            canonical_serialize(body),
            VEC["expected_record_hash"]["canonical"],
            "canonical form must match",
        )
        self.assertEqual(
            content_id(body),
            VEC["expected_record_hash"]["id"],
            "content id must match",
        )


if __name__ == "__main__":
    unittest.main()
