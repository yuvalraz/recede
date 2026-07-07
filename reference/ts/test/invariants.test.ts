// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Proves invariants I1-I7 from SPEC section 7.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  act,
  coldStart,
  contentId,
  defaultPolicy,
  evRef,
  gate,
  makeCheckRecord,
  open,
  policyDigest,
  referencePolicyV02,
  replay,
  seal,
  tierIndex,
  update,
  type Policy,
  type TrustState,
  type Warrant,
} from "../src/index.ts";
import { buildWarrant, cleanSuccess, resetClock, tick } from "./helpers.ts";

const policy = defaultPolicy();

beforeEach(() => resetClock());

// ---------------------------------------------------------------------------
// I1 — Scope isolation. A score for one TaskType MUST NOT influence another.
// ---------------------------------------------------------------------------
test("I1: trust is per (actor, task_type); replay ignores foreign scopes", () => {
  const warrants = [
    cleanSuccess({ actor: "bot", task_type: "refund.issue" }),
    cleanSuccess({ actor: "bot", task_type: "email.draft" }),
    cleanSuccess({ actor: "bot", task_type: "refund.issue" }),
    cleanSuccess({ actor: "other", task_type: "refund.issue" }),
  ];
  const refund = replay("bot", "refund.issue", warrants, policy);
  const email = replay("bot", "email.draft", warrants, policy);

  assert.equal(refund.sample_count, 2, "only bot/refund warrants folded");
  assert.equal(email.sample_count, 1, "only bot/email warrant folded");
});

test("I1: update() refuses to fold cross-scope evidence (fails loud)", () => {
  const st = coldStart("bot", "refund.issue");
  const foreign = cleanSuccess({ actor: "bot", task_type: "email.draft" });
  assert.throws(() => update(st, foreign, policy), /scope violation/);
});

// ---------------------------------------------------------------------------
// I2 — Reconstructability. replay() MUST reproduce the incremental state.
// ---------------------------------------------------------------------------
test("I2: replay reproduces incrementally-folded TrustState exactly", () => {
  const warrants = Array.from({ length: 12 }, () => cleanSuccess());
  // Incremental fold (what a live system stores).
  let inc = coldStart("bot", "x");
  for (const w of warrants) inc = update(inc, w, policy).state;
  // Cold-start replay.
  const rep = replay("bot", "x", warrants, policy);
  assert.deepEqual({ ...rep, updated: undefined }, { ...inc, updated: undefined });
});

// Tamper-evidence: an evidence_ref is a hash-covered element of the CheckRecord
// pre-image, so mutating one character breaks the record id (hence the whole
// chain via `prev`), AND — under a v0.2 policy that reads the ref's declared
// tier — changes the folded TrustState so a mutated warrant no longer replays to
// the stored state. Proves BOTH directions: clean reproduces, mutated diverges.
test("I2 tamper: mutating an evidence_ref breaks the record id AND diverges replay", () => {
  const p = referencePolicyV02({ integration: { L1: 0.2, L3: 0.7 } });
  const cleanRef = evRef("integration", "L3", "ci", "sha256:x", "loc", { mutation: true });
  const mutRef = cleanRef.replace("|L3|", "|L1|"); // one weight-affecting field, one edit
  assert.notEqual(cleanRef, mutRef);

  const mkW = (ref: string): Warrant => {
    resetClock();
    const intent = open({ actor: "agentA", task_type: "code.fix", proposed_action: "a", declared_risk: "reversible.low", ts: tick() });
    const action = act({ intent, operations: ["op"], result: { r: 1 }, ts: tick() });
    const chk = makeCheckRecord({ action, check_kind: "VERIFY", method: "m", verdict: "PASS", confidence: 1, evidence_refs: [ref], ts: tick() });
    const outcome = seal({ warrant_ref: intent.id, actor: "agentA", result: "SUCCESS", ground_truth_source: "test", ts: tick() });
    return { intent, action, checks: [chk], checkpoints: [], outcome };
  };

  const cleanW = mkW(cleanRef);
  const mutW = mkW(mutRef);

  // (1) Hash binding: the ref is inside the CheckRecord pre-image.
  assert.notEqual(cleanW.checks[0].id, mutW.checks[0].id, "ref mutation must change the record id");
  assert.notEqual(contentId(cleanW.checks[0]), contentId(mutW.checks[0]));

  // (2) Unmutated reproduces: incremental fold == cold replay (I2), under v0.2.
  const inc = update(coldStart("agentA", "code.fix"), cleanW, p).state;
  const rep = replay("agentA", "code.fix", [cleanW], p);
  assert.deepEqual({ ...rep, updated: undefined }, { ...inc, updated: undefined }, "clean warrant replays to the stored state");

  // (3) Mutated diverges: the ref's declared tier is bound into trust (v0.2 pool).
  const repMut = replay("agentA", "code.fix", [mutW], p);
  assert.notEqual(repMut.score, rep.score, "mutating the ref tier changes pooled confidence -> different score");
  assert.notDeepEqual({ ...repMut, updated: undefined }, { ...rep, updated: undefined }, "a mutated warrant no longer replays to the stored state");
});

// ---------------------------------------------------------------------------
// I3 — Irreversible floor. never_recede risk gates at EVERY tier.
// ---------------------------------------------------------------------------
test("I3: irreversible.critical retains a checkpoint at every tier", () => {
  for (const tier of ["T0", "T1", "T2", "T3", "T4"] as const) {
    const st: TrustState = { ...coldStart("bot", "x"), tier, score: 1, confidence: 1, sample_count: 999 };
    const d = gate(st, "irreversible.critical", policy);
    assert.equal(d.autonomous, false, `must gate at ${tier}`);
    assert.match(d.reason, /never_recede|checkpoint/);
  }
});

test("I3: an org-defined risk added to never_recede also always gates", () => {
  const p: Policy = { ...policy, never_recede: [...policy.never_recede, "legal.filing"] };
  const st: TrustState = { ...coldStart("bot", "x"), tier: "T4", score: 1, confidence: 1, sample_count: 999 };
  assert.equal(gate(st, "legal.filing", p).autonomous, false);
});

// ---------------------------------------------------------------------------
// I4 — Trust can decrease. An accrue-only implementation is non-conformant.
// ---------------------------------------------------------------------------
test("I4: negative evidence decreases the score", () => {
  const built = replay("bot", "x", Array.from({ length: 15 }, () => cleanSuccess()), policy);
  const rev = buildWarrant({ result: "REVERTED", checks: [{ kind: "VALIDATE", verdict: "FAIL", confidence: 0.8 }] });
  const after = update(built, rev, policy).state;
  assert.ok(after.score < built.score, "REVERTED must lower score");
  assert.ok(tierIndex(after.tier) < tierIndex(built.tier), "and force a demotion");
});

// ---------------------------------------------------------------------------
// I5 — Confidence cap. Low sample => low autonomy, regardless of score.
// ---------------------------------------------------------------------------
test("I5: one lucky high-score run cannot promote past T1", () => {
  const st = update(coldStart("bot", "x"), cleanSuccess(), policy).state;
  assert.equal(st.sample_count, 1);
  assert.ok(tierIndex(st.tier) <= 1, `capped at T1, got ${st.tier}`);
});

test("I5: tier only climbs as sample_count clears the per-tier gate", () => {
  let st = coldStart("bot", "x");
  const seen: Record<string, number> = {};
  for (let i = 0; i < 70; i++) {
    st = update(st, cleanSuccess(), policy).state;
    seen[st.tier] = (seen[st.tier] ?? 0) + 1;
    // At any point the confidence-implied tier caps the score-implied tier.
    const confTierIdx = [0, 3, 10, 25, 60].filter((n) => st.sample_count >= n).length - 1;
    assert.ok(tierIndex(st.tier) <= confTierIdx, `tier ${st.tier} exceeds confidence cap at n=${st.sample_count}`);
  }
  assert.ok(tierIndex(st.tier) >= 3, "should eventually reach a high tier with enough samples");
});

// ---------------------------------------------------------------------------
// I6 — Policy replay. Every gate decision references the exact policy digest.
// ---------------------------------------------------------------------------
test("I6: gate decision carries the producing policy digest", () => {
  const st = coldStart("bot", "x");
  const d = gate(st, "read.only", policy);
  assert.equal(d.policy_digest, policyDigest(policy));
});

test("I6: changing any policy rule changes the digest", () => {
  const p2: Policy = { ...policy, weights: { ...policy.weights, positive_gain: 0.99 } };
  assert.notEqual(policyDigest(policy), policyDigest(p2));
});

// Byte-identity tripwire for the weighting-strategy seam. The default policy's
// digest is frozen: adding optional `weighting`/`evidence_weights` fields left
// undefined on defaultPolicy() must NOT move it (canonicalize drops null/
// undefined keys — hash.ts:51-53). Every pinned artifact + cross-language
// vector depends on this string. If it moves, the seam broke the default.
test("I6: default policy digest is byte-frozen (weighting-strategy seam guard)", () => {
  assert.equal(
    policyDigest(defaultPolicy()),
    "sha256:e3bbda0bde646b86cc43ee0be78370f523b04b95261bf1297cb7a0ba8b5d6234",
  );
});

// ---------------------------------------------------------------------------
// I7 — Purity. gate/update/replay are deterministic and side-effect free.
// ---------------------------------------------------------------------------
test("I7: gate is deterministic and does not mutate its inputs", () => {
  const st = Object.freeze({ ...coldStart("bot", "x"), tier: "T2" as const });
  const before = JSON.stringify(st);
  const d1 = gate(st, "reversible.low", policy);
  const d2 = gate(st, "reversible.low", policy);
  assert.deepEqual(d1, d2);
  assert.equal(JSON.stringify(st), before, "gate must not mutate state");
});

test("I7: update does not mutate prev state; same inputs => same output", () => {
  const prev = coldStart("bot", "x");
  const w = cleanSuccess();
  const snapshot = JSON.stringify(prev);
  const a = update(prev, w, policy).state;
  const b = update(prev, w, policy).state;
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(prev), snapshot, "update must not mutate prev");
});

test("I7: replay is deterministic across repeated calls", () => {
  const warrants = Array.from({ length: 8 }, () => cleanSuccess());
  const a = replay("bot", "x", warrants, policy);
  const b = replay("bot", "x", warrants, policy);
  assert.deepEqual(a, b);
});
