// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// The v0.2 pooled noisy-OR weighting profile (SPEC §9). Reuses the byte-frozen
// v0.1 signalOf for direction/disposition and overrides ONLY Signal.confidence
// with a class-deduped noisy-OR pool over per-check declared weights. VERIFY is
// no longer pinned at 1.0 — it carries the declared policy weight. The negative
// path, forced demotion, near-miss and sample_count are inherited verbatim (I4).
//
// Namespace import: during RED the module is a stub, so `v02.<fn>` is undefined
// and each call fails with a behavioral "is not a function" (not a link error).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as v02 from "../src/weighting-v0.2.ts";
import {
  open,
  act,
  makeCheckRecord,
  seal,
  defaultPolicy,
  signalOf,
  foldSignal,
  strategyFor,
  REF_WEIGHTING_V02,
  type CheckKind,
  type Verdict,
  type OutcomeResult,
  type Policy,
  type Warrant,
} from "../src/index.ts";

// A small illustrative weight table (declared policy, NOT a prediction).
const EW: Policy["evidence_weights"] = {
  integration: { L1: 0.2, L2: 0.5, L3: 0.7 },
  e2e: { L1: 0.3, L2: 0.6, L3: 0.85 },
  unit: { L1: 0.15, L2: 0.35, L3: 0.55 },
  "llm-judge": { L1: 0.2, L2: 0.4 },
};

function policyV02(): Policy {
  return { ...defaultPolicy(), version: "0.2.0", weighting: REF_WEIGHTING_V02, evidence_weights: EW };
}

// Deterministic clock so record ids are stable across runs.
let clock = 0;
function tick(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}
beforeEach(() => {
  clock = 0;
});

interface TC {
  kind: CheckKind;
  verdict: Verdict;
  confidence: number;
  refs?: string[];
}

/** Build a Warrant with the given checks (each may carry evidence_refs). */
function warrant(checks: TC[], result?: OutcomeResult, actor = "agentA"): Warrant {
  const intent = open({
    actor,
    task_type: "code.fix",
    proposed_action: "act",
    declared_risk: "reversible.low",
    ts: tick(),
  });
  const action = act({ intent, operations: ["op"], result: { r: 1 }, ts: tick() });
  const checkRecs = checks.map((c) =>
    makeCheckRecord({
      action,
      check_kind: c.kind,
      method: "m",
      verdict: c.verdict,
      confidence: c.confidence,
      evidence_refs: c.refs ?? [],
      ts: tick(),
    }),
  );
  const outcome = result
    ? seal({ warrant_ref: intent.id, actor, result, ground_truth_source: "test", ts: tick() })
    : undefined;
  return { intent, action, checks: checkRecs, checkpoints: [], outcome };
}

// --- Slice A: evRef grammar ------------------------------------------------

test("evRef/parseEvRef round-trip", () => {
  const ref = v02.evRef("integration", "L2", "ci", "sha256:ab", "gh://run/1");
  assert.deepEqual(v02.parseEvRef(ref), {
    evClass: "integration",
    tier: "L2",
    author: "ci",
    mutation: false,
  });
  const refMut = v02.evRef("unit", "L2", "ci", "sha256:cd", "path:1", { mutation: true });
  assert.equal(v02.parseEvRef(refMut)?.mutation, true);
  assert.equal(v02.parseEvRef("garbage"), null);
});

test("descOf returns the first parseable ev1 ref (or null when none parse)", () => {
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: ["junk", v02.evRef("e2e", "L3", "ci", "sha256:x", "loc")] },
  ]);
  assert.equal(v02.descOf(w.checks[0])?.evClass, "e2e");
  const none = warrant([{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [] }]);
  assert.equal(v02.descOf(none.checks[0]), null);
});

// --- Slice B: effectiveWeight + anti-gaming gates --------------------------

test("isTestClass identifies unit/integration/e2e, rejects others", () => {
  assert.equal(v02.isTestClass("unit"), true);
  assert.equal(v02.isTestClass("integration"), true);
  assert.equal(v02.isTestClass("e2e"), true);
  assert.equal(v02.isTestClass("llm-judge"), false);
});

test("effectiveWeight: VERIFY carries the declared policy weight (no longer pinned 1.0)", () => {
  const p = policyV02();
  // integration@L2 by an independent author, with mutation evidence -> L2 stands.
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:x", "loc", { mutation: true })] },
  ]);
  assert.equal(v02.effectiveWeight(w.checks[0], w, p), 0.5);
});

test("effectiveWeight: assertion-strength gate caps a test class without ;mut=1 to L1", () => {
  const p = policyV02();
  const wUnit = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("unit", "L2", "ci", "sha256:x", "loc")] },
  ]);
  assert.equal(v02.effectiveWeight(wUnit.checks[0], wUnit, p), 0.15, "unit@L2 no-mut -> unit.L1");
  const wUnitMut = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("unit", "L2", "ci", "sha256:x", "loc", { mutation: true })] },
  ]);
  assert.equal(v02.effectiveWeight(wUnitMut.checks[0], wUnitMut, p), 0.35, "unit@L2 ;mut=1 -> unit.L2");
  // integration is also a test class -> capped without mutation evidence.
  const wInt = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:x", "loc")] },
  ]);
  assert.equal(v02.effectiveWeight(wInt.checks[0], wInt, p), 0.2, "integration@L2 no-mut -> integration.L1");
});

test("effectiveWeight: author-independence gate caps self-authored evidence to L1", () => {
  const p = policyV02();
  // author == actor "agentA": even with mutation evidence, capped to L1.
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "agentA", "sha256:x", "loc", { mutation: true })] },
  ]);
  assert.equal(v02.effectiveWeight(w.checks[0], w, p), 0.2);
});

test("effectiveWeight: no descriptor falls back to UNKNOWN_WEIGHT", () => {
  const p = policyV02();
  const w = warrant([{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [] }]);
  assert.equal(v02.effectiveWeight(w.checks[0], w, p), v02.UNKNOWN_WEIGHT);
  assert.equal(v02.UNKNOWN_WEIGHT, 0.1);
});

test("effectiveWeight: VALIDATE weight is scaled by caller confidence", () => {
  const p = policyV02();
  // llm-judge is not a test class -> L1 tier honored; 0.20 * 0.5 = 0.10.
  const w = warrant([
    { kind: "VALIDATE", verdict: "PASS", confidence: 0.5, refs: [v02.evRef("llm-judge", "L1", "judge", "sha256:x", "loc")] },
  ]);
  assert.equal(v02.effectiveWeight(w.checks[0], w, p), 0.1);
});

// --- Slice C: pooledConfidence (the core fix) ------------------------------

test("pooledConfidence: a single class equals its weight", () => {
  const p = policyV02();
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:x", "loc", { mutation: true })] },
  ]);
  assert.equal(v02.pooledConfidence(w, p), 0.7);
});

test("pooledConfidence: independent classes compound via noisy-OR", () => {
  const p = policyV02();
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] },
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("e2e", "L3", "ci", "sha256:b", "l2", { mutation: true })] },
  ]);
  // 1 - (1-0.70)(1-0.85) = 0.955
  assert.ok(Math.abs(v02.pooledConfidence(w, p) - 0.955) < 1e-9);
});

test("pooledConfidence: redundant same-class PASS checks do NOT inflate (dedup to strongest)", () => {
  const p = policyV02();
  const checks: TC[] = [];
  for (let i = 0; i < 10; i++) {
    checks.push({ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("unit", "L3", "ci", "sha256:" + i, "l" + i, { mutation: true })] });
  }
  assert.equal(v02.pooledConfidence(warrant(checks), p), 0.55, "ten unit PASS dedup to unit.L3");
});

test("pooledConfidence: only PASS corroborates; empty pools to 0", () => {
  const p = policyV02();
  const w = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] },
    { kind: "VERIFY", verdict: "FAIL", confidence: 1, refs: [v02.evRef("e2e", "L3", "ci", "sha256:b", "l2", { mutation: true })] },
  ]);
  assert.equal(v02.pooledConfidence(w, p), 0.7, "the FAIL e2e contributes nothing");
  assert.equal(v02.pooledConfidence(warrant([]), p), 0, "no PASS -> 0");
});

test("pooledConfidence property: >= max single-class weight AND monotone non-decreasing", () => {
  const p = policyV02();
  const base: TC[] = [
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:a", "l1", { mutation: true })] }, // 0.50
  ];
  const pooledBase = v02.pooledConfidence(warrant(base), p);
  assert.ok(pooledBase >= 0.5 - 1e-12, "pool >= max single-class weight");
  const more = base.concat([
    { kind: "VALIDATE", verdict: "PASS", confidence: 0.5, refs: [v02.evRef("llm-judge", "L1", "judge", "sha256:c", "l3")] }, // 0.10
  ]);
  const pooledMore = v02.pooledConfidence(warrant(more), p);
  assert.ok(pooledMore >= pooledBase, "adding a PASS check is monotone non-decreasing");
  assert.ok(pooledMore >= 0.5 - 1e-12, "still >= the strong single weight");
});

test("worked example: a weak VALIDATE ADDS to a strong VERIFY (pool >= strong weight)", () => {
  const p = policyV02();
  const strongOnly = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:a", "l1", { mutation: true })] }, // 0.50
  ]);
  const strongPlusWeak = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:a", "l1", { mutation: true })] }, // 0.50
    { kind: "VALIDATE", verdict: "PASS", confidence: 0.5, refs: [v02.evRef("llm-judge", "L1", "judge", "sha256:c", "l3")] }, // 0.10
  ]);
  assert.equal(v02.pooledConfidence(strongOnly, p), 0.5);
  assert.ok(Math.abs(v02.pooledConfidence(strongPlusWeak, p) - 0.55) < 1e-9, "1-(1-0.5)(1-0.1)=0.55");
  assert.ok(
    v02.pooledConfidence(strongPlusWeak, p) >= v02.pooledConfidence(strongOnly, p),
    "weak evidence adds, never drags below the strong weight",
  );
});

// --- Slice D: signalOfV02 + registration + I4 + A4 -------------------------

test("signalOfV02: positive path overrides ONLY confidence with the pool", () => {
  const p = policyV02();
  const w = warrant(
    [
      { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] },
      { kind: "VALIDATE", verdict: "PASS", confidence: 0.9, refs: [v02.evRef("llm-judge", "L2", "judge", "sha256:b", "l2")] },
    ],
    "SUCCESS",
  );
  const base = signalOf(w);
  const v = v02.signalOfV02(w, p);
  assert.equal(v.raw, base.raw, "raw inherited from v0.1");
  assert.equal(v.near_miss, base.near_miss);
  assert.equal(v.force_demote, base.force_demote);
  assert.equal(v.counts, base.counts);
  assert.equal(v.confidence, v02.pooledConfidence(w, p), "confidence is the pool");
  assert.notEqual(v.confidence, base.confidence, "pooled differs from the v0.1 flat mean here");
});

test("signalOfV02: REVERTED negative path is byte-identical to v0.1 field-for-field (I4)", () => {
  const p = policyV02();
  // A REVERTED warrant WITH poolable PASS checks present -> still identical: the
  // pool touches only the positive side, so the negative asymmetry is untouched.
  const w = warrant(
    [{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] }],
    "REVERTED",
  );
  assert.deepEqual(v02.signalOfV02(w, p), signalOf(w));
});

test("signalOfV02: a no-evidence warrant is unchanged (counts=false)", () => {
  const p = policyV02();
  const w = warrant([{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [] }]); // no outcome / no checkpoint
  assert.deepEqual(v02.signalOfV02(w, p), signalOf(w));
});

test("A4 edge: INCONCLUSIVE-only SUCCESS pools to 0 and flips confidence-accrual negative under v0.2", () => {
  const p = policyV02();
  const w = warrant(
    [{ kind: "VERIFY", verdict: "INCONCLUSIVE", confidence: 0.6, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] }],
    "SUCCESS",
  );
  const base = signalOf(w);
  const v = v02.signalOfV02(w, p);
  assert.equal(base.raw, 0.3, "v0.1: +0.3 for an inconclusive success");
  assert.ok(base.confidence > 0, "v0.1 mean confidence of the inconclusive check > 0");
  assert.equal(v.raw, 0.3, "raw inherited");
  assert.equal(v.confidence, 0, "no PASS check -> pool 0");
  // Fold from an identical warm state: v0.1 accrues confidence (positive branch),
  // v0.2 debits it (pool 0 -> the negative confidence branch). Intentional, pinned.
  const foldedV01 = foldSignal(0.5, 0.5, 3, base, defaultPolicy());
  const foldedV02 = foldSignal(0.5, 0.5, 3, v, p);
  assert.ok(foldedV01.confidence > 0.5, "v0.1 accrues confidence on +0.3");
  assert.ok(foldedV02.confidence < 0.5, "v0.2 debits confidence when the pool is 0");
});

// --- Slice E: anti-pathology hardening (declared-weight bounds + unspoofable marker) ---

test("weight>1: referencePolicyV02 THROWS loud on an out-of-range declared evidence weight", () => {
  // An adopter declaring w > 1 has a bug; do not silently reinterpret their policy.
  assert.throws(() => v02.referencePolicyV02({ integration: { L2: 1.5 } }), /evidence weight/i);
  assert.throws(() => v02.referencePolicyV02({ integration: { L2: -0.1 } }), /evidence weight/i);
  // In-range table still constructs fine.
  assert.equal(v02.referencePolicyV02(EW).weighting, REF_WEIGHTING_V02);
});

test("weight>1: effectiveWeight CLAMPS a declared weight above 1 so the pool stays monotone and <= 1", () => {
  // Build the policy literal directly (bypassing the referencePolicyV02 validator)
  // to prove the combiner math is safe for ANY input (belt). Two classes at >1 must
  // NOT drive the pool below a single class (the flat-mean pathology v0.2 prevents).
  const p: Policy = {
    ...defaultPolicy(),
    version: "0.2.0",
    weighting: REF_WEIGHTING_V02,
    evidence_weights: { integration: { L2: 1.5 }, e2e: { L2: 1.5 } },
  };
  const one = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:a", "l1", { mutation: true })] },
  ]);
  const two = warrant([
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L2", "ci", "sha256:a", "l1", { mutation: true })] },
    { kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("e2e", "L2", "ci", "sha256:b", "l2", { mutation: true })] },
  ]);
  assert.equal(v02.effectiveWeight(one.checks[0], one, p), 1, "declared weight >1 clamped to 1");
  const poolOne = v02.pooledConfidence(one, p);
  const poolTwo = v02.pooledConfidence(two, p);
  assert.ok(poolOne <= 1, "pool <= 1");
  assert.ok(poolTwo <= 1, "pool <= 1");
  assert.ok(poolTwo >= poolOne, "adding corroborating evidence never DECREASES the pool (monotone)");
});

test("pipe-spoof: evRef THROWS when ANY content field contains a bare '|' (fail loud, no field-shift forgery)", () => {
  // A bare '|' smuggled into any of the 5 content fields (e.g. a CI URL
  // `gh://run/123|mut=1`, or an evClass `integration|L9`) would either forge the
  // mut=1 7th field or shift every trailing field, corrupting tier+author and
  // defeating BOTH anti-gaming gates. evRef must refuse to build such a ref.
  assert.throws(() => v02.evRef("integration|L9", "L2", "ci", "sha256:x", "loc"), /\|/, "evClass with '|' throws");
  assert.throws(() => v02.evRef("integration", "L2|x", "ci", "sha256:x", "loc"), /\|/, "provTier with '|' throws");
  assert.throws(() => v02.evRef("integration", "L2", "c|i", "sha256:x", "loc"), /\|/, "author with '|' throws");
  assert.throws(() => v02.evRef("integration", "L2", "ci", "sha|256", "loc"), /\|/, "artifactDigest with '|' throws");
  assert.throws(() => v02.evRef("integration", "L2", "ci", "sha256:x", "gh://run/123|mut=1"), /\|/, "locator with '|' throws");
  // The thrown error names the offending field so an adapter author can find it.
  assert.throws(() => v02.evRef("integration", "L2", "ci", "sha256:x", "gh://run/123|mut=1"), /locator/i);
});

test("mut-spoof: a locator containing ';mut=1' (semicolon, NO pipe) yields 6 fields -> mutation false", () => {
  // The RETIRED semicolon vector: with the dedicated |mut=1 7th field, a semicolon
  // in the locator is opaque content -> 6 fields -> parseEvRef reports mutation:false.
  const spoof = v02.evRef("integration", "L2", "ci", "sha256:x", "gh://run/1;mut=1");
  assert.equal(v02.parseEvRef(spoof)?.mutation, false, "incidental ';mut=1' in the locator is not the marker");
  // The assertion-strength gate still bites: integration is a test class, so without
  // a REAL mutation marker it caps to L1 (0.20), NOT the ungated L2 (0.50).
  const p = policyV02();
  const w = warrant([{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [spoof] }]);
  assert.equal(v02.effectiveWeight(w.checks[0], w, p), 0.2, "spoofed locator gets the gated L1 weight");
  // The real structural marker still round-trips, even when the locator also contains the text.
  const real = v02.evRef("integration", "L2", "ci", "sha256:x", "gh://run/1;mut=1", { mutation: true });
  assert.equal(v02.parseEvRef(real)?.mutation, true, "the real structural marker parses to true");
});

test("mut-spoof: parseEvRef REJECTS forged field counts (only length 6, or 7-with-mut=1, are valid)", () => {
  // 8 fields (an extra field glued after a real mut=1) -> null, not mutation:true.
  assert.equal(v02.parseEvRef("ev1|c|t|a|d|loc|mut=1|x"), null, "8 fields -> null");
  // 7 fields whose 7th is NOT the exact marker -> null (no bare `p[6]===` acceptance).
  assert.equal(v02.parseEvRef("ev1|c|t|a|d|loc|notmut"), null, "7 fields, wrong marker -> null");
  // 5 fields (too short) -> null.
  assert.equal(v02.parseEvRef("ev1|c|t|a|d"), null, "5 fields -> null");
  // Wrong version tag -> null.
  assert.equal(v02.parseEvRef("ev2|c|t|a|d|loc"), null, "wrong version -> null");
  // The two VALID shapes still parse.
  assert.equal(v02.parseEvRef("ev1|c|t|a|d|loc")?.mutation, false, "6 fields -> mutation false");
  assert.equal(v02.parseEvRef("ev1|c|t|a|d|loc|mut=1")?.mutation, true, "7 fields with mut=1 -> mutation true");
});

test("round-trip property: fields with ';' and literal 'mut=1' text (but NO '|') survive parseEvRef exactly", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["integration", "L2", "ci;bot", false],
    ["e2e", "L3;x", "author;mut=1", true],
    ["unit", "L1", "mut=1", false], // author literally the marker text, but as its own field
  ];
  for (const [evClass, provTier, author, mutation] of cases) {
    const ref = v02.evRef(evClass, provTier, author, "sha256:d;mut=1", "loc;mut=1", { mutation });
    assert.deepEqual(v02.parseEvRef(ref), { evClass, tier: provTier, author, mutation }, `round-trips ${author}`);
  }
});

test("strategyFor(referencePolicyV02) returns the v0.2 strategy; unknown tag still throws", () => {
  const p = v02.referencePolicyV02(EW);
  assert.equal(p.weighting, REF_WEIGHTING_V02);
  assert.equal(p.version, "0.2.0");
  assert.equal(p.id, "recede.reference");
  const w = warrant(
    [{ kind: "VERIFY", verdict: "PASS", confidence: 1, refs: [v02.evRef("integration", "L3", "ci", "sha256:a", "l1", { mutation: true })] }],
    "SUCCESS",
  );
  assert.deepEqual(strategyFor(p).signalOf(w, p), v02.signalOfV02(w, p), "dispatch resolves to v0.2");
  assert.notEqual(strategyFor(p).signalOf(w, p).confidence, signalOf(w).confidence, "v0.2 != v0.1 confidence");
  assert.throws(() => strategyFor({ ...defaultPolicy(), weighting: "recede/nope" }), /unknown weighting strategy/);
});
