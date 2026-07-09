// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.0 — pure revert detection + reseal builder. `detectReverts` maps a
 * `Revert "…"` (or `#N`-referencing) PR to the in-window warrant it reverts;
 * `buildRevertReseal` produces the superseding REVERTED OutcomeRecord (ts = revert
 * date, honesty label `backfill:revert-detected`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectReverts,
  buildRevertReseal,
  buildBackfillWarrant,
  type MergeBundle,
} from "../backfill.ts";
import type { RawPullRequest } from "../scanner.ts";

function pr(number: number, mergedAt: string): RawPullRequest {
  return {
    number,
    merged: true,
    mergeCommitSha: `${number}`.repeat(40).slice(0, 40),
    headSha: "a".repeat(40),
    author: "octo-dev",
    mergedAt,
  };
}

function bundle(number: number, title: string, mergedAt: string): MergeBundle {
  return { pr: pr(number, mergedAt), title, labels: [], reviews: [], surfaces: [] };
}

test("detectReverts: a Revert \"…\" title maps to the reverted PR by title match", () => {
  const bundles = [
    bundle(10, "Add feature X", "2026-04-01T00:00:00Z"),
    bundle(11, 'Revert "Add feature X"', "2026-04-05T00:00:00Z"),
  ];
  const reseals = detectReverts(bundles);
  assert.equal(reseals.length, 1);
  assert.equal(reseals[0].revert.revertPrNumber, 11);
  assert.equal(reseals[0].revert.targetPrNumber, 10);
  assert.equal(reseals[0].revert.revertedAt, "2026-04-05T00:00:00Z");
});

test("detectReverts: a #N reference in a revert title resolves the target", () => {
  const bundles = [
    bundle(20, "Some unrelated title", "2026-04-01T00:00:00Z"),
    bundle(21, "Revert broken change (#20)", "2026-04-06T00:00:00Z"),
  ];
  const reseals = detectReverts(bundles);
  assert.equal(reseals.length, 1);
  assert.equal(reseals[0].revert.targetPrNumber, 20);
});

test("detectReverts: a revert whose target is out of window is skipped, never crashes", () => {
  const bundles = [bundle(31, 'Revert "A PR merged before the window"', "2026-04-06T00:00:00Z")];
  const reseals = detectReverts(bundles);
  assert.equal(reseals.length, 0);
});

test("detectReverts: prose that merely mentions 'revert' + a #N ref does NOT reseal (C2)", () => {
  // "revert" appears mid-sentence, not as a revert-shaped title. The #N branch must
  // be gated on a revert-SHAPED title, else this silently demotes the wrong lane.
  const bundles = [
    bundle(40, "Add retry logic", "2026-04-01T00:00:00Z"),
    bundle(41, "Refactor to avoid revert loops (see #40)", "2026-04-05T00:00:00Z"),
  ];
  assert.equal(detectReverts(bundles).length, 0);
});

test("detectReverts: a revert-shaped 'Revert PR #40' title still reseals #40 (C2)", () => {
  const bundles = [
    bundle(40, "Add retry logic", "2026-04-01T00:00:00Z"),
    bundle(42, "Revert PR #40", "2026-04-06T00:00:00Z"),
  ];
  const reseals = detectReverts(bundles);
  assert.equal(reseals.length, 1);
  assert.equal(reseals[0].revert.targetPrNumber, 40);
});

test('detectReverts: a quoted-but-out-of-window revert falls back to its #40 ref (C2)', () => {
  // Quoted title has no in-window match, but the title is revert-SHAPED, so the
  // #N fallback is allowed to resolve #40.
  const bundles = [
    bundle(40, "Add retry logic", "2026-04-01T00:00:00Z"),
    bundle(43, 'Revert "Some title merged before the window" (#40)', "2026-04-07T00:00:00Z"),
  ];
  const reseals = detectReverts(bundles);
  assert.equal(reseals.length, 1);
  assert.equal(reseals[0].revert.targetPrNumber, 40);
});

test("detectReverts: a non-revert history yields no reseals", () => {
  const bundles = [
    bundle(1, "Add A", "2026-04-01T00:00:00Z"),
    bundle(2, "Fix B", "2026-04-02T00:00:00Z"),
  ];
  assert.equal(detectReverts(bundles).length, 0);
});

test("buildRevertReseal: produces a superseding REVERTED outcome at the revert ts", () => {
  const target = buildBackfillWarrant(bundle(10, "Add feature X", "2026-04-01T00:00:00Z"));
  const outcome = buildRevertReseal(target, {
    revertPrNumber: 11,
    targetPrNumber: 10,
    revertedAt: "2026-04-05T00:00:00Z",
  });
  assert.equal(outcome.kind, "OUTCOME");
  assert.equal(outcome.result, "REVERTED");
  assert.equal(outcome.ground_truth_source, "backfill:revert-detected");
  assert.equal(outcome.ts, "2026-04-05T00:00:00Z");
  assert.equal(outcome.warrant_ref, target.intent.id);
});
