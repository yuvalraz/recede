// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.2 gotcha 2 — check-runs are SHA-bound and disappear on a new push. Every
 * derived surface MUST carry the exact SHA it was observed at; the tool must
 * never carry-forward or merge runs across SHAs. Using fixtures A (SHA_A) and B
 * (SHA_B, same check names, simulating a new push):
 *   - every surface from A carries sha === SHA_A;
 *   - every surface from B carries sha === SHA_B;
 *   - the two scans never merge and no SHA_A surface survives into B's result.
 *
 * Namespace import so the not-yet-defined `unionChecks` is `undefined` during RED
 * and calling it throws behaviorally — a real RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import { fixtureSet, REPO, SHA_A, SHA_B } from "./fixtures/fake-github.ts";

test("unionChecks: surfaces are SHA-snapshotted from their own SHA; A and B never merge", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);

  const surfacesA = scanner.unionChecks(
    await src.getCombinedStatus(REPO, SHA_A),
    await src.listCheckRunsForRef(REPO, SHA_A),
  );
  assert.ok(surfacesA.length > 0, "fixture A must yield surfaces");
  for (const s of surfacesA) {
    assert.equal(s.sha, SHA_A, `${s.name} (${s.kind}) must be stamped at SHA_A`);
  }

  const surfacesB = scanner.unionChecks(
    await src.getCombinedStatus(REPO, SHA_B),
    await src.listCheckRunsForRef(REPO, SHA_B),
  );
  assert.ok(surfacesB.length > 0, "fixture B must yield surfaces");
  for (const s of surfacesB) {
    assert.equal(s.sha, SHA_B, `${s.name} (${s.kind}) must be stamped at SHA_B`);
  }

  // No SHA_A surface survives into B's result (no carry-forward).
  assert.ok(surfacesB.every((s) => s.sha !== SHA_A), "no aaa… surface leaks into B's scan");

  // The two scans cover the SAME names (same repo, new push) but are DISJOINT by SHA.
  assert.deepEqual(
    surfacesA.map((s) => s.name).sort(),
    surfacesB.map((s) => s.name).sort(),
    "same names at both SHAs",
  );
  assert.notDeepEqual(surfacesA, surfacesB, "surfaces differ (each carries its own SHA) — they never merge");
});
