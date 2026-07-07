// Cross-language conformance check (TypeScript / CANONICAL side).
// Prints (a) canonicalize + content-id of one identical record, and (b) the
// final TrustState after replaying a conformance vector. Its Python twin
// (xcheck.py) prints the same lines for the v0.1 vector; they MUST be
// byte-identical.
//
// Parameterized (advisory A3): the vector file is an OPTIONAL argv.
//   node xcheck.mjs                          -> conformance/vectors.json (v0.1)
//   node xcheck.mjs conformance/vectors-v0.2.json  -> the pooled v0.2 profile
// With no arg the output is byte-identical to the frozen v0.1 baseline. The
// v0.2 branch builds referencePolicyV02(evidence_weights) and turns each
// check's `ev` descriptor into a hash-covered evidence_ref via evRef(...).
import {
  coldStart, update, defaultPolicy, referencePolicyV02,
  open, act, makeCheckRecord, checkpoint, seal, canonicalize, contentId, evRef,
} from "../reference/ts/src/index.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
const vecPath = arg ? (isAbsolute(arg) ? arg : resolve(process.cwd(), arg)) : join(HERE, "vectors.json");
const vec = JSON.parse(readFileSync(vecPath, "utf8"));

// v0.2 vectors declare the pooled profile + an evidence_weights table; v0.1
// leaves both undefined and folds under the reference v0.1 mean.
const isV02 = vec.weighting_profile === "recede/ref-weighting-v0.2";
const policy = isV02 ? referencePolicyV02(vec.evidence_weights) : defaultPolicy();
const ACTOR = vec.scope.actor, TASK = vec.scope.task_type, GTS = vec.ground_truth_source;

// (a) One identical record: the pinned record from the vector.
const rec = vec.expected_record_hash.record;
const { id: _i, sig: _s, ...pre } = rec;
console.log("RECORD_CANONICAL " + canonicalize(pre));
console.log("RECORD_ID        " + contentId(rec));

// (b) Replay the vector.
function build(e) {
  const intent = open({ actor: ACTOR, task_type: TASK, proposed_action: "issue refund", declared_risk: e.risk, ts: e.ts });
  const action = act({ intent, operations: ["refund"], result: { ok: true }, ts: e.ts });
  const checks = (e.checks || []).map((c) => makeCheckRecord({
    action, check_kind: c.kind, method: "m", verdict: c.verdict, confidence: c.confidence,
    evidence_refs: c.ev ? [evRef(c.ev.evClass, c.ev.provTier, c.ev.author, c.ev.artifactDigest, c.ev.locator, { mutation: c.ev.mutation })] : [],
    ts: e.ts,
  }));
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
