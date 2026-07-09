// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.0 — pure warrant builders: `inferTaskType` (keyword heuristic over the
 * ratified DEFAULT_TASK_RISK lanes, unknown → code.feature @ reversible.low) and
 * `buildBackfillWarrant` (one merge → open/act/check[]/seal, ts injected from
 * mergedAt, evidence_refs populated per surface, honesty label carried).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferTaskType,
  buildBackfillWarrant,
  type MergeBundle,
} from "../backfill.ts";
import type { RawPullRequest, CheckSurface } from "../scanner.ts";
import { parseEvRef } from "../../../reference/ts/src/index.ts";

const SNAP = "c".repeat(40);
const MERGED_AT = "2026-04-10T12:00:00Z";

function pr(over: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 42,
    merged: true,
    mergeCommitSha: SNAP,
    headSha: "a".repeat(40),
    author: "octo-dev",
    mergedAt: MERGED_AT,
    ...over,
  };
}

function bundle(over: Partial<MergeBundle> = {}): MergeBundle {
  return {
    pr: pr(),
    title: "Add dark mode toggle",
    labels: [],
    reviews: [],
    surfaces: [],
    ...over,
  };
}

// ---- inferTaskType --------------------------------------------------------

test("inferTaskType: a fix title maps to code.fix @ reversible.low", () => {
  assert.deepEqual(inferTaskType("Fix null pointer in parser", []), {
    taskType: "code.fix",
    risk: "reversible.low",
  });
});

test("inferTaskType: a migration maps to code.migrate @ irreversible.critical", () => {
  assert.deepEqual(inferTaskType("Migrate users table to new schema", []), {
    taskType: "code.migrate",
    risk: "irreversible.critical",
  });
});

test("inferTaskType: a release maps to release.publish @ irreversible.critical", () => {
  assert.deepEqual(inferTaskType("Release v2.0.0", []), {
    taskType: "release.publish",
    risk: "irreversible.critical",
  });
});

test("inferTaskType: a docs title maps to docs.write @ reversible.low", () => {
  assert.deepEqual(inferTaskType("Update README documentation", []), {
    taskType: "docs.write",
    risk: "reversible.low",
  });
});

test("inferTaskType: an unrecognized title falls back to code.feature @ reversible.low", () => {
  assert.deepEqual(inferTaskType("Tweak the widget colors", []), {
    taskType: "code.feature",
    risk: "reversible.low",
  });
});

test("inferTaskType: a label can drive the lane when the title is neutral", () => {
  assert.deepEqual(inferTaskType("Weekly dependency bump", ["bug"]), {
    taskType: "code.fix",
    risk: "reversible.low",
  });
});

// ---- buildBackfillWarrant -------------------------------------------------

test("buildBackfillWarrant: intent carries the author, inferred lane, and injected ts", () => {
  const w = buildBackfillWarrant(bundle({ title: "Fix crash on empty input" }));
  assert.equal(w.intent.actor, "octo-dev");
  assert.equal(w.intent.task_type, "code.fix");
  assert.equal(w.intent.declared_risk, "reversible.low");
  assert.equal(w.intent.ts, MERGED_AT); // ts INJECTED from history, not the clock
  assert.equal(w.intent.kind, "INTENT");
});

test("buildBackfillWarrant: seals SUCCESS with the reconstructed honesty label at merge ts", () => {
  const w = buildBackfillWarrant(bundle());
  assert.ok(w.outcome, "warrant must be sealed");
  assert.equal(w.outcome!.result, "SUCCESS");
  assert.equal(w.outcome!.ground_truth_source, "backfill:reconstructed");
  assert.equal(w.outcome!.ts, MERGED_AT);
});

test("buildBackfillWarrant: one check per surface, verdicts mapped, refs populated", () => {
  const surfaces: CheckSurface[] = [
    { name: "unit-tests", sha: SNAP, conclusion: "success", kind: "check-run", detailsUrl: "https://ci/1" },
    { name: "eslint", sha: SNAP, conclusion: "failure", kind: "check-run", detailsUrl: null },
    { name: "flaky-e2e", sha: SNAP, conclusion: "neutral", kind: "check-run", detailsUrl: null },
  ];
  const w = buildBackfillWarrant(bundle({ surfaces }));
  assert.equal(w.checks.length, 3);

  const byMethod = Object.fromEntries(w.checks.map((c) => [c.method, c]));
  assert.equal(byMethod["unit-tests"].verdict, "PASS");
  assert.equal(byMethod["eslint"].verdict, "FAIL");
  assert.equal(byMethod["flaky-e2e"].verdict, "INCONCLUSIVE"); // flaky → INCONCLUSIVE (rule 6)

  // Every check carries a parseable ev1 evidence_ref so the v0.2 pooled combiner
  // has real per-class evidence to pool.
  for (const c of w.checks) {
    assert.ok(c.evidence_refs.length >= 1, `${c.method} must carry an evidence_ref`);
    assert.ok(parseEvRef(c.evidence_refs[0]), `${c.method} ref must be a valid ev1 ref`);
  }
});

// ---- H1: a '|' in a check NAME must not crash the ref build ---------------

test("buildBackfillWarrant: a '|' in a check name does not throw; produces a valid ref (H1)", () => {
  // Legal GitHub matrix names carry '|' (e.g. "build | test"). evRef forbids '|'
  // in any field, so the synthetic fallback locator must sanitize the name too.
  const surfaces: CheckSurface[] = [
    { name: "build | test", sha: SNAP, conclusion: "success", kind: "check-run", detailsUrl: null },
  ];
  const w = buildBackfillWarrant(bundle({ surfaces }));
  assert.equal(w.checks.length, 1);
  const ref = w.checks[0].evidence_refs[0];
  assert.ok(parseEvRef(ref), "ref must be a valid ev1 ref despite '|' in the check name");
});

// ---- RawReview folding: reviews become review-class check surfaces --------

test("buildBackfillWarrant: an APPROVED review folds into a VALIDATE review-class check", () => {
  const reviews = [{ prNumber: 42, state: "APPROVED", author: "rev-one", submittedAt: MERGED_AT }];
  const w = buildBackfillWarrant(bundle({ reviews }));
  const reviewChecks = w.checks.filter((c) => parseEvRef(c.evidence_refs[0] ?? "")?.evClass === "review");
  assert.equal(reviewChecks.length, 1, "the APPROVED review must produce one review-class check");
  assert.equal(reviewChecks[0].check_kind, "VALIDATE");
  assert.equal(reviewChecks[0].verdict, "PASS");
});

test("buildBackfillWarrant: a CHANGES_REQUESTED review folds INCONCLUSIVE, never FAIL (rule 6)", () => {
  const reviews = [{ prNumber: 42, state: "CHANGES_REQUESTED", author: "rev-two", submittedAt: MERGED_AT }];
  const w = buildBackfillWarrant(bundle({ reviews }));
  const reviewChecks = w.checks.filter((c) => parseEvRef(c.evidence_refs[0] ?? "")?.evClass === "review");
  assert.equal(reviewChecks.length, 1);
  assert.equal(reviewChecks[0].verdict, "INCONCLUSIVE");
});

test("buildBackfillWarrant: a COMMENTED review is not folded (no reseal-worthy state)", () => {
  const reviews = [{ prNumber: 42, state: "COMMENTED", author: "rev-three", submittedAt: MERGED_AT }];
  const w = buildBackfillWarrant(bundle({ reviews }));
  const reviewChecks = w.checks.filter((c) => parseEvRef(c.evidence_refs[0] ?? "")?.evClass === "review");
  assert.equal(reviewChecks.length, 0, "a COMMENTED review carries no verdict signal and is skipped");
});
