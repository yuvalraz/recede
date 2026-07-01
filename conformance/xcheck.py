# Cross-language conformance check (Python / MIRROR side).
# Prints (a) canonicalize + content-id of one identical record, and (b) the
# final TrustState after replaying conformance/vectors.json. Its TS twin
# (xcheck.mjs) prints the same lines; they MUST be byte-identical.
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reference", "py"))

from recede import Policy, TrustState, Warrant, core, ops  # noqa: E402
from recede.canonical import canonical_serialize, content_id  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "vectors.json"), encoding="utf-8") as fh:
    VEC = json.load(fh)

ACTOR = VEC["scope"]["actor"]
TASK = VEC["scope"]["task_type"]
GTS = VEC["ground_truth_source"]

# (a) One identical record: the pinned OUTCOME from the vector.
rec = VEC["expected_record_hash"]["record"]
body = {k: v for k, v in rec.items() if k not in ("id", "sig")}
print("RECORD_CANONICAL " + canonical_serialize(body))
print("RECORD_ID        " + content_id(body))


# (b) Replay the shared vector.
def build(e):
    intent = ops.open(ACTOR, TASK, "issue refund", e["risk"], ts=e["ts"])
    action = ops.act(intent, ["refund"], result="ok", ts=e["ts"])
    checks = tuple(ops.check(action, c["kind"], "m", c["verdict"], c["confidence"], ts=e["ts"]) for c in e.get("checks", []))
    cp = ops.checkpoint(intent.id, "gate", [], "full", decision=e["decision"], reviewer="human", ts=e["ts"]) if e.get("decision") else None
    outcome = ops.seal(intent.id, e["result"], GTS, human_touched=cp is not None, actor=ACTOR, ts=e["ts"]) if e.get("result") else None
    return Warrant(intent=intent, action=action, checks=checks, outcome=outcome, checkpoint=cp)


policy = Policy()
st = TrustState.cold_start(ACTOR, TASK)
for e in VEC["entries"]:
    st = core.update(st, build(e), policy, idle_ms=e.get("idle_ms", 0.0), drift=e.get("drift", 0.0), now=e.get("now"))
print("FINAL_TIER       " + st.tier)
print("FINAL_SCORE      " + format(st.score, ".15f"))
print("FINAL_CONFIDENCE " + format(st.confidence, ".15f"))
print("FINAL_SAMPLES    " + str(st.sample_count))
