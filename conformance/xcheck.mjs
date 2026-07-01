// Cross-language conformance check (TypeScript / CANONICAL side).
// Prints (a) canonicalize + content-id of one identical record, and (b) the
// final TrustState after replaying conformance/vectors.json. Its Python twin
// (xcheck.py) prints the same lines; they MUST be byte-identical.
import {
  coldStart, update, defaultPolicy,
  open, act, makeCheckRecord, checkpoint, seal, canonicalize, contentId,
} from "../reference/ts/src/index.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(readFileSync(join(HERE, "vectors.json"), "utf8"));
const policy = defaultPolicy();
const ACTOR = vec.scope.actor, TASK = vec.scope.task_type, GTS = vec.ground_truth_source;

// (a) One identical record: the pinned OUTCOME from the vector.
const rec = vec.expected_record_hash.record;
const { id: _i, sig: _s, ...pre } = rec;
console.log("RECORD_CANONICAL " + canonicalize(pre));
console.log("RECORD_ID        " + contentId(rec));

// (b) Replay the shared vector.
function build(e) {
  const intent = open({ actor: ACTOR, task_type: TASK, proposed_action: "issue refund", declared_risk: e.risk, ts: e.ts });
  const action = act({ intent, operations: ["refund"], result: { ok: true }, ts: e.ts });
  const checks = (e.checks || []).map((c) => makeCheckRecord({ action, check_kind: c.kind, method: "m", verdict: c.verdict, confidence: c.confidence, ts: e.ts }));
  const cps = e.decision ? [checkpoint({ warrant_ref: intent.id, actor: ACTOR, reason: "gate", altitude: "full", decision: e.decision, reviewer: "human", ts: e.ts })] : [];
  const outcome = e.result ? seal({ warrant_ref: intent.id, actor: ACTOR, result: e.result, ground_truth_source: GTS, human_touched: cps.length > 0, ts: e.ts }) : undefined;
  return { intent, action, checks, checkpoints: cps, outcome };
}
let st = coldStart(ACTOR, TASK);
for (const e of vec.entries) {
  st = update(st, build(e), policy, { idle_ms: e.idle_ms ?? 0, drift: e.drift ?? 0, now: e.now }).state;
}
console.log("FINAL_TIER       " + st.tier);
console.log("FINAL_SCORE      " + st.score.toFixed(15));
console.log("FINAL_CONFIDENCE " + st.confidence.toFixed(15));
console.log("FINAL_SAMPLES    " + st.sample_count);
