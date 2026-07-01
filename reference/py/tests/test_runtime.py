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
"""Front door, content-addressing, and ledger round-trip tests."""

from __future__ import annotations

import os
import tempfile
import unittest

from recede import (
    FileLedger,
    MemoryLedger,
    Policy,
    Recede,
    Result,
    auto_checkpoint,
    check,
    core,
    ops,
)
from recede.canonical import canonical_serialize, content_id


class TestContentAddressing(unittest.TestCase):
    def test_id_is_deterministic(self):
        a = ops.open("bot", "t", "act", "read.only", ts="2026-01-01T00:00:00+00:00")
        b = ops.open("bot", "t", "act", "read.only", ts="2026-01-01T00:00:00+00:00")
        self.assertEqual(a.id, b.id)

    def test_id_changes_with_content(self):
        a = ops.open("bot", "t", "act", "read.only", ts="2026-01-01T00:00:00+00:00")
        b = ops.open("bot", "t", "act", "reversible.low", ts="2026-01-01T00:00:00+00:00")
        self.assertNotEqual(a.id, b.id)

    def test_id_omits_itself_and_sig(self):
        a = ops.open("bot", "t", "act", "read.only", ts="2026-01-01T00:00:00+00:00")
        # Recomputing the id over the body must reproduce it.
        body = {k: v for k, v in a.__dict__.items() if k not in ("id", "sig")}
        self.assertEqual(content_id(body), a.id)

    def test_canonical_sorts_and_drops_nulls(self):
        s = canonical_serialize({"b": 1, "a": None, "c": 2})
        self.assertEqual(s, '{"b":1,"c":2}')

    def test_hash_chain_prev_links(self):
        intent = ops.open("bot", "t", "act", "read.only")
        action = ops.act(intent, ["op"])
        chk = ops.check(action, "VERIFY", "m", "PASS", 1.0)
        outcome = ops.seal(intent.id, Result.SUCCESS.value, "src")
        self.assertEqual(action.prev, intent.id)
        self.assertEqual(chk.prev, action.id)
        self.assertEqual(outcome.prev, intent.id)


class TestFrontDoor(unittest.TestCase):
    def test_run_returns_shape(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        ok = check.verify("ok", lambda io: io.output == 42)
        out = r.run(lambda: 42, actor="bot", task_type="t", intent="answer", risk="read.only", checks=[ok])
        self.assertEqual(out.result, 42)
        self.assertIsNotNone(out.warrant)
        self.assertIsNotNone(out.trust.before)
        self.assertIsNotNone(out.trust.after)
        self.assertIsInstance(out.trust.delta, float)

    def test_gate_is_implicit_checkpoint_fires_at_baseline(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        out = r.run(lambda: 1, actor="bot", task_type="t", intent="i", risk="financial.reversible")
        self.assertIsNotNone(out.checkpoint)  # baseline trust -> gated

    def test_oversight_recedes_with_evidence(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        ok = check.verify("ok", lambda io: True)
        pol = check.validate("pol", lambda io: {"ok": True, "confidence": 0.9})
        gated = autonomous = 0
        for i in range(40):
            out = r.run(lambda: 1, actor="bot", task_type="t", intent="i",
                        risk="financial.reversible", checks=[ok, pol])
            if out.checkpoint:
                gated += 1
            else:
                autonomous += 1
        self.assertGreater(gated, 0)
        self.assertGreater(autonomous, 0)  # it eventually receded

    def test_reject_forces_failure_and_no_call(self):
        calls = []
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("REJECT"), policy=Policy())

        def fn():
            calls.append(1)
            return 1

        out = r.run(fn, actor="bot", task_type="t", intent="i", risk="financial.reversible")
        self.assertEqual(len(calls), 0)  # rejected before running
        self.assertEqual(out.warrant.outcome.result, Result.FAILURE.value)

    def test_verify_fail_seals_failure(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
        bad = check.verify("bad", lambda io: False)
        out = r.run(lambda: 1, actor="bot", task_type="t", intent="i", risk="read.only", checks=[bad])
        self.assertEqual(out.warrant.outcome.result, Result.FAILURE.value)

    def test_async_check_supported(self):
        r = Recede(ledger=MemoryLedger(), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())

        async def judge(io):
            return {"ok": True, "confidence": 0.7}

        v = check.validate("judge", judge)
        out = r.run(lambda: 1, actor="bot", task_type="t", intent="i", risk="read.only", checks=[v])
        self.assertEqual(out.warrant.outcome.result, Result.SUCCESS.value)


class TestFileLedger(unittest.TestCase):
    def test_roundtrip_replays_equal_state(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ledger.jsonl")
            r = Recede(ledger=FileLedger(path), checkpoint=auto_checkpoint("APPROVE"), policy=Policy())
            ok = check.verify("ok", lambda io: True)
            for i in range(15):
                r.run(lambda: i, actor="bot", task_type="t", intent="i", risk="read.only", checks=[ok])
            live = r.trust("bot", "t")

            # Reload from disk in a fresh ledger and replay.
            reloaded = FileLedger(path)
            replayed = core.replay(reloaded.warrants(), Policy())[("bot", "t")]
            self.assertEqual(replayed, live)


if __name__ == "__main__":
    unittest.main()
