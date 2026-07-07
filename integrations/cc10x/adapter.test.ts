// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Phase 3: evidence_refs binding through the CC10X recorder. The v2 phase-signal
// adapter emits hash-covered evidence_refs (evRef grammar) in a DETERMINISTIC
// (sorted) order so the derived CheckRecord id is order-independent (I2), maps a
// flaky result to INCONCLUSIVE (never FAIL — a flaky high-weight FAIL must not
// crater trust), and stays backward-safe (no descriptor -> empty refs).

import { test } from "node:test";
import assert from "node:assert/strict";
// Namespace import so that during RED the not-yet-exported `phasesToChecksV2` is
// `undefined` and each call fails with a behavioral "is not a function" — a real
// RED, not a module-collection error.
import * as adapter from "./cc10x-adapter.ts";
import type { Cc10xPhaseSignalV2 } from "./cc10x-adapter.ts";
import {
  act,
  evRef,
  makeCheckRecord,
  open,
  referencePolicyV02,
} from "../../reference/ts/src/index.ts";

const ctx = { intent: "i", input: null, output: null };

test("phasesToChecksV2: emits populated evidence_refs built via evRef", async () => {
  const specs = adapter.phasesToChecksV2([
    {
      phase: "verifier",
      kind: "VERIFY",
      verdict: "PASS",
      confidence: 1,
      evidence: [
        { evClass: "integration", provTier: "L2", author: "ci", artifactDigest: "sha256:x", locator: "gh://run/1", mutation: true },
      ],
    },
  ]);
  assert.equal(specs.length, 1);
  const res = await specs[0].run(ctx);
  assert.equal(res.name, "cc10x:verifier");
  assert.equal(res.check_kind, "VERIFY");
  assert.equal(res.verdict, "PASS");
  assert.deepEqual(res.evidence_refs, [
    evRef("integration", "L2", "ci", "sha256:x", "gh://run/1", { mutation: true }),
  ]);
});

test("phasesToChecksV2: a flaky result maps to INCONCLUSIVE (never FAIL)", async () => {
  const specs = adapter.phasesToChecksV2([
    {
      phase: "verifier",
      kind: "VERIFY",
      verdict: "FAIL",
      confidence: 1,
      flaky: true,
      evidence: [
        { evClass: "e2e", provTier: "L3", author: "ci", artifactDigest: "sha256:y", locator: "loc", mutation: true },
      ],
    },
  ]);
  const res = await specs[0].run(ctx);
  assert.equal(res.verdict, "INCONCLUSIVE", "a flaky FAIL must not crater trust at full magnitude");
});

test("phasesToChecksV2: no evidence descriptor -> empty refs (backward-safe)", async () => {
  const specs = adapter.phasesToChecksV2([{ phase: "review", kind: "VALIDATE", verdict: "PASS", confidence: 0.8 }]);
  const res = await specs[0].run(ctx);
  assert.deepEqual(res.evidence_refs, [], "no descriptor supplied -> unchanged empty refs");
});

test("phasesToChecksV2: refs are emitted in SORTED order -> order-independent record id (I2)", async () => {
  const evA = { evClass: "integration", provTier: "L2", author: "ci", artifactDigest: "sha256:a", locator: "l1", mutation: true };
  const evB = { evClass: "e2e", provTier: "L3", author: "ci", artifactDigest: "sha256:b", locator: "l2", mutation: true };
  const fwd = await adapter.phasesToChecksV2([
    { phase: "v", kind: "VERIFY", verdict: "PASS", confidence: 1, evidence: [evA, evB] },
  ])[0].run(ctx);
  const rev = await adapter.phasesToChecksV2([
    { phase: "v", kind: "VERIFY", verdict: "PASS", confidence: 1, evidence: [evB, evA] },
  ])[0].run(ctx);
  assert.deepEqual(fwd.evidence_refs, rev.evidence_refs, "input order must not change ref order");
  assert.deepEqual(fwd.evidence_refs, [...fwd.evidence_refs].sort(), "refs are sorted");

  // The derived CheckRecord id is byte-identical regardless of input evidence order.
  const intent = open({ actor: "agentA", task_type: "code.fix", proposed_action: "a", declared_risk: "reversible.low", ts: "2026-01-01T00:00:00.000Z" });
  const action = act({ intent, operations: ["op"], result: { r: 1 }, ts: "2026-01-01T00:00:01.000Z" });
  const mk = (refs: string[]) =>
    makeCheckRecord({ action, check_kind: "VERIFY", method: "cc10x:v", verdict: "PASS", confidence: 1, evidence_refs: refs, ts: "2026-01-01T00:00:02.000Z" });
  assert.equal(mk(fwd.evidence_refs).id, mk(rev.evidence_refs).id, "sorted refs -> stable id regardless of input order");
});

test("Cc10xRecede.recordBuild threads v2 evidence_refs end-to-end onto the sealed CheckRecord", async () => {
  const bridge = new adapter.Cc10xRecede({
    policy: { ...referencePolicyV02({ integration: { L2: 0.5 } }), id: "recede.cc10x.coding" },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const phases: Cc10xPhaseSignalV2[] = [
    {
      phase: "verifier",
      kind: "VERIFY",
      verdict: "PASS",
      confidence: 1,
      evidence: [
        { evClass: "integration", provTier: "L2", author: "ci", artifactDigest: "sha256:x", locator: "gh://run/1", mutation: true },
      ],
    },
  ];
  const out = await bridge.recordBuild(
    { agent: "agentA", taskType: "code.fix", intent: "fix", risk: "reversible.low", phases },
    () => "patch",
  );
  const checkRec = out.warrant.checks.find((c) => c.method === "cc10x:verifier");
  assert.ok(checkRec, "the verifier check was recorded");
  assert.deepEqual(
    checkRec!.evidence_refs,
    [evRef("integration", "L2", "ci", "sha256:x", "gh://run/1", { mutation: true })],
    "the recorded warrant's check carries the hash-covered evidence_ref",
  );
});
