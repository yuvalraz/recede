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
# Parameterized (advisory A3): the vector file is an OPTIONAL argv. With no arg
# it defaults to conformance/vectors.json (the v0.1 baseline) and the output is
# byte-identical to its TS twin.
_arg = sys.argv[1] if len(sys.argv) > 1 else None
_vec_path = _arg if (_arg and os.path.isabs(_arg)) else os.path.join(os.getcwd(), _arg) if _arg else os.path.join(HERE, "vectors.json")
with open(_vec_path, encoding="utf-8") as fh:
    VEC = json.load(fh)

# Profile-skip guard: the Python mirror only supports the v0.1 reference profile.
# The pooled v0.2 profile is a declared fast-follow (FF1) — print an explicit
# UNSUPPORTED line and skip its replay rather than folding it under v0.1 to a
# silently-wrong state.
_profile = VEC.get("weighting_profile", "recede/ref-weighting-v0.1")
if _profile != "recede/ref-weighting-v0.1":
    print("PROFILE " + _profile + " UNSUPPORTED (py fast-follow)")
    sys.exit(0)

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
