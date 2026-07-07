// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Cross-language conformance: replay the SHARED vector (conformance/vectors.json)
// and assert this implementation reproduces the expected final TrustState (score
// to 1e-9), the intermediate peak, the never_recede gate, and the pinned record
// hash. The Python suite (reference/py/tests/test_conformance.py) loads the same
// vector and MUST reach the identical results — the demonstration required by
// SPEC §9.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  coldStart,
  update,
  gate,
  defaultPolicy,
  contentId,
  canonicalize,
  open,
  act,
  makeCheckRecord,
  checkpoint,
  seal,
  evRef,
  effectiveWeight,
  pooledConfidence,
  referencePolicyV02,
  type Policy,
  type TrustState,
  type Warrant,
} from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(HERE, "..", "..", "..", "conformance", "vectors.json");
const vec = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

const policy = defaultPolicy();
const ACTOR = vec.scope.actor as string;
const TASK = vec.scope.task_type as string;
const GTS = vec.ground_truth_source as string;

interface Entry {
  ts: string;
  risk: string;
  checks?: { kind: "VERIFY" | "VALIDATE"; verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; confidence: number }[];
  result?: "SUCCESS" | "FAILURE" | "REVERTED" | "UNRESOLVED";
  decision?: "APPROVE" | "REJECT" | "MODIFY" | "ESCALATE";
  idle_ms?: number;
  drift?: number;
  now?: string;
}

function buildWarrant(e: Entry): Warrant {
  const intent = open({
    actor: ACTOR,
    task_type: TASK,
    proposed_action: "issue refund",
    declared_risk: e.risk,
    ts: e.ts,
  });
  const action = act({ intent, operations: ["refund"], result: { ok: true }, ts: e.ts });
  const checks = (e.checks ?? []).map((c) =>
    makeCheckRecord({
      action,
      check_kind: c.kind,
      method: "m",
      verdict: c.verdict,
      confidence: c.confidence,
      ts: e.ts,
    }),
  );
  const checkpoints = e.decision
    ? [
        checkpoint({
          warrant_ref: intent.id,
          actor: ACTOR,
          reason: "gate",
          altitude: "full",
          decision: e.decision,
          reviewer: "human",
          ts: e.ts,
        }),
      ]
    : [];
  const outcome = e.result
    ? seal({
        warrant_ref: intent.id,
        actor: ACTOR,
        result: e.result,
        ground_truth_source: GTS,
        human_touched: checkpoints.length > 0,
        ts: e.ts,
      })
    : undefined;
  return { intent, action, checks, checkpoints, outcome };
}

function replayVector(): { final: TrustState; peak: TrustState | null } {
  const entries = vec.entries as Entry[];
  const peakBefore = vec.checkpoints?.before_index as number | undefined;
  let st = coldStart(ACTOR, TASK);
  let peak: TrustState | null = null;
  entries.forEach((e, i) => {
    if (peakBefore !== undefined && i === peakBefore) peak = { ...st };
    const w = buildWarrant(e);
    st = update(st, w, policy, { idle_ms: e.idle_ms ?? 0, drift: e.drift ?? 0, now: e.now }).state;
  });
  return { final: st, peak };
}

test("conformance: replaying the shared vector reproduces the expected final TrustState", () => {
  const { final } = replayVector();
  const exp = vec.expected_final_trust;
  assert.equal(final.tier, exp.tier, "tier must match");
  assert.equal(final.sample_count, exp.sample_count, "sample_count must match");
  assert.ok(Math.abs(final.score - exp.score) < 1e-9, `score ${final.score} != ${exp.score}`);
  assert.ok(
    Math.abs(final.confidence - exp.confidence) < 1e-9,
    `confidence ${final.confidence} != ${exp.confidence}`,
  );
});

test("conformance: the intermediate peak (before recede) matches", () => {
  const { peak } = replayVector();
  assert.ok(peak, "expected an intermediate checkpoint");
  const exp = vec.checkpoints.expected;
  assert.equal(peak!.tier, exp.tier);
  assert.equal(peak!.sample_count, exp.sample_count);
  assert.ok(Math.abs(peak!.score - exp.score) < 1e-9, `peak score ${peak!.score} != ${exp.score}`);
});

test("conformance: never_recede gate stays gated even at maximal trust (I3)", () => {
  for (const g of vec.gate_checks) {
    const st: TrustState = { ...coldStart(ACTOR, TASK), ...g.state };
    const d = gate(st, g.risk, policy);
    assert.equal(d.autonomous, g.expect_autonomous, `gate for ${g.risk}`);
  }
});

test("conformance: the pinned record hash matches the shared vector", () => {
  const rec = vec.expected_record_hash.record;
  // Canonical form and id are recomputed from the record body.
  const { id: _id, sig: _sig, ...pre } = rec;
  assert.equal(canonicalize(pre), vec.expected_record_hash.canonical, "canonical form must match");
  assert.equal(contentId(rec), vec.expected_record_hash.id, "content id must match");
});

// ---------------------------------------------------------------------------
// v0.2 pooled-weighting profile (recede/ref-weighting-v0.2)
// ---------------------------------------------------------------------------

const V2_PATH = join(HERE, "..", "..", "..", "conformance", "vectors-v0.2.json");
const vec2 = JSON.parse(readFileSync(V2_PATH, "utf8"));
const v2policy: Policy = referencePolicyV02(vec2.evidence_weights);
const A2 = vec2.scope.actor as string;
const T2K = vec2.scope.task_type as string;
const G2 = vec2.ground_truth_source as string;

interface EvDescJSON {
  evClass: string;
  provTier: string;
  author: string;
  artifactDigest: string;
  locator: string;
  mutation: boolean;
}
interface EntryV2 {
  ts: string;
  risk: string;
  checks?: {
    kind: "VERIFY" | "VALIDATE";
    verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
    confidence: number;
    ev?: EvDescJSON;
  }[];
  result?: "SUCCESS" | "FAILURE" | "REVERTED" | "UNRESOLVED";
  idle_ms?: number;
  drift?: number;
  now?: string;
}

// Build a v0.2 Warrant: each check's `ev` descriptor becomes a hash-covered
// evidence_ref via evRef(...) (the `|`-guarded grammar). Shared shape with the
// xcheck.mjs harness so the in-suite replay and the CLI agree.
function buildWarrantV2(e: EntryV2): Warrant {
  const intent = open({
    actor: A2,
    task_type: T2K,
    proposed_action: "issue refund",
    declared_risk: e.risk,
    ts: e.ts,
  });
  const action = act({ intent, operations: ["refund"], result: { ok: true }, ts: e.ts });
  const checks = (e.checks ?? []).map((c) =>
    makeCheckRecord({
      action,
      check_kind: c.kind,
      method: "m",
      verdict: c.verdict,
      confidence: c.confidence,
      evidence_refs: c.ev
        ? [evRef(c.ev.evClass, c.ev.provTier, c.ev.author, c.ev.artifactDigest, c.ev.locator, { mutation: c.ev.mutation })]
        : [],
      ts: e.ts,
    }),
  );
  const outcome = e.result
    ? seal({
        warrant_ref: intent.id,
        actor: A2,
        result: e.result,
        ground_truth_source: G2,
        human_touched: false,
        ts: e.ts,
      })
    : undefined;
  return { intent, action, checks, checkpoints: [], outcome };
}

function replayVectorV2(): TrustState {
  let st = coldStart(A2, T2K);
  for (const e of vec2.entries as EntryV2[]) {
    st = update(st, buildWarrantV2(e), v2policy, {
      idle_ms: e.idle_ms ?? 0,
      drift: e.drift ?? 0,
      now: e.now,
    }).state;
  }
  return st;
}

test("conformance v0.2: replaying vectors-v0.2.json under the pooled policy reproduces the frozen final TrustState", () => {
  const final = replayVectorV2();
  const exp = vec2.expected_final_trust;
  assert.equal(final.tier, exp.tier, "tier must match");
  assert.equal(final.sample_count, exp.sample_count, "sample_count must match");
  assert.ok(Math.abs(final.score - exp.score) < 1e-9, `score ${final.score} != ${exp.score}`);
  assert.ok(
    Math.abs(final.confidence - exp.confidence) < 1e-9,
    `confidence ${final.confidence} != ${exp.confidence}`,
  );
});

test("conformance v0.2: the pinned evidence_refs-carrying record hash matches", () => {
  const rec = vec2.expected_record_hash.record;
  const { id: _id, sig: _sig, ...pre } = rec;
  assert.equal(canonicalize(pre), vec2.expected_record_hash.canonical, "canonical form must match");
  assert.equal(contentId(rec), vec2.expected_record_hash.id, "content id must match");
});

test("conformance v0.2: the vector genuinely exercises the pool + both anti-gaming gates (not tautological)", () => {
  const w = vec2.pool_witnesses;
  // (A) strong cross-class pool: entry 0 pools independent integration L3 + e2e L3.
  const strong = buildWarrantV2((vec2.entries as EntryV2[])[0]);
  assert.ok(
    Math.abs(pooledConfidence(strong, v2policy) - w.strong_cross_class) < 1e-12,
    `strong pool ${pooledConfidence(strong, v2policy)} != ${w.strong_cross_class}`,
  );
  // (B) assertion-strength gate: a test-class check WITHOUT mut=1 is demoted to L1.
  const gatedEntry = (vec2.entries as EntryV2[]).find((e) => e.checks?.[0]?.ev?.mutation === false)!;
  const gated = buildWarrantV2(gatedEntry);
  assert.ok(
    Math.abs(effectiveWeight(gated.checks[0], gated, v2policy) - w.assertion_strength_gated) < 1e-12,
    "assertion-strength gate must demote to L1",
  );
  assert.ok(
    Math.abs(pooledConfidence(gated, v2policy) - w.assertion_strength_gated) < 1e-12,
    "assertion-strength gated pool must equal the L1 weight",
  );
  // (C) author-independence gate: a self-authored (author == actor) ref is floored to L1.
  const selfEntry = (vec2.entries as EntryV2[]).find((e) => e.checks?.[0]?.ev?.author === A2)!;
  const self = buildWarrantV2(selfEntry);
  assert.ok(
    Math.abs(effectiveWeight(self.checks[0], self, v2policy) - w.author_independence_gated) < 1e-12,
    "author-independence gate must floor a self-authored ref to L1",
  );
  // (D) class-dedup: two same-class checks keep the max, they do not compound.
  const dedupEntry = (vec2.entries as EntryV2[]).find((e) => (e.checks?.length ?? 0) === 2 && e.checks![0].ev?.evClass === e.checks![1].ev?.evClass)!;
  const dedup = buildWarrantV2(dedupEntry);
  assert.ok(
    Math.abs(pooledConfidence(dedup, v2policy) - w.class_dedup) < 1e-12,
    `class-dedup pool ${pooledConfidence(dedup, v2policy)} != ${w.class_dedup}`,
  );
});
