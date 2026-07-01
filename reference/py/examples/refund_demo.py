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
"""The killer example (README §"story in 30 seconds"): a refund agent whose
oversight recedes as it earns trust, then snaps back on a reverted outcome.

Run:  python -m examples.refund_demo
"""

from __future__ import annotations

from recede import (
    MemoryLedger,
    Policy,
    Recede,
    Result,
    auto_checkpoint,
    check,
)


def issue_refund(order):
    # The agent does its real work here; we just echo an approved refund.
    return {"amount": order["amount"], "order_id": order["id"]}


def main() -> None:
    r = Recede(
        ledger=MemoryLedger(),
        checkpoint=auto_checkpoint(decision="APPROVE"),  # human rubber-hand for the demo
        policy=Policy(),
    )

    amount_ok = check.verify("amount", lambda io: io.output["amount"] <= io.input["order_total"])
    policy_ok = check.validate("policy", lambda io: {"ok": True, "confidence": 0.85})

    def run_one(order):
        return r.run(
            lambda: issue_refund(order),
            actor="billing-bot",
            task_type="refund.issue",
            intent=f"Refund order {order['id']} — duplicate charge",
            risk="financial.reversible",
            inputs=order,
            checks=[amount_ok, policy_ok],
        )

    print("Day 1: every refund gated (trust at baseline).")
    gated = 0
    autonomous = 0
    for i in range(60):
        order = {"id": f"o{i}", "amount": 20, "order_total": 100}
        out = run_one(order)
        if out.checkpoint is not None:
            gated += 1
        else:
            autonomous += 1
        if i in (0, 20, 40, 59):
            t = out.trust.after
            print(
                f"  run {i:>2}: tier={t.tier} score={t.score:.3f} "
                f"conf={t.confidence:.3f} n={t.sample_count} "
                f"{'CHECKPOINT' if out.checkpoint else 'autonomous'}"
            )
    print(f"  -> gated={gated} autonomous={autonomous} (oversight receded)\n")

    print("Later: an autonomous refund gets REVERTED by a next-day fraud check.")
    order = {"id": "fraud1", "amount": 20, "order_total": 100}
    out = run_one(order)
    before_revert = out.trust.after
    after = r.reseal(out.warrant, result=Result.REVERTED.value, ground_truth_source="fraud-check")
    print(
        f"  before revert: tier={before_revert.tier} score={before_revert.score:.3f}\n"
        f"  after  revert: tier={after.tier} score={after.score:.3f}  (checkpoint snaps back)\n"
    )

    print("Invariant I2 — replay reproduces the live trust state:")
    replayed = r.replay()[("billing-bot", "refund.issue")]
    live = r.trust("billing-bot", "refund.issue")
    print(f"  live    : score={live.score:.6f} tier={live.tier} n={live.sample_count}")
    print(f"  replayed: score={replayed.score:.6f} tier={replayed.tier} n={replayed.sample_count}")
    print(f"  equal   : {replayed == live}")


if __name__ == "__main__":
    main()
