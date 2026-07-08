// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.5 — OFFLINE collectScan orchestration test. Drives the impure `collectScan`
 * with the PURE in-memory `FixtureEvidenceSource` (no network, no subprocess), so
 * the seam-fold is proven in CI. Asserts: union checks become surfaces, an
 * approving review + CODEOWNERS + deployments are synthesized as surfaces, branch
 * protection drives `requiredChecks` (incl. review→required), every surface is
 * SHA-snapshotted (gotcha 2), `discoveredVia` is carried from the source, and
 * caller-supplied artifacts are downloaded + attached with `linkSha`. Then feeds
 * the RepoScan through the frozen `buildEvidenceMap` to prove the full pipeline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectScan,
  buildEvidenceMap,
  FixtureEvidenceSource,
  type FixtureSet,
} from "../scanner.ts";

const SNAP = "c".repeat(40); // the merge-commit SHA the checks are attached to
const REPO = { owner: "acme", repo: "example" } as const;

// Checks live at the merge-commit SHA the merged PR landed on.
const fixtures: FixtureSet = {
  "acme/example": {
    pullRequests: [
      { number: 7, merged: true, mergeCommitSha: SNAP, headSha: "a".repeat(40), author: "octo-dev", mergedAt: "2026-01-15T10:00:00Z" },
    ],
    reviews: {
      7: [{ prNumber: 7, state: "APPROVED", author: "rev-one", submittedAt: "2026-01-15T09:30:00Z" }],
    },
    workflowRuns: [],
    checkRuns: {
      [SNAP]: [
        { name: "unit-tests", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl: "https://example.test/1", app: "github-actions" },
        { name: "build", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl: "https://example.test/2", app: "github-actions" },
      ],
    },
    combinedStatus: {
      [SNAP]: {
        sha: SNAP,
        state: "success",
        statuses: [
          { context: "build", state: "success", targetUrl: "https://ci.example.test/b" }, // dedup vs check-run
          { context: "legacy-ci", state: "success", targetUrl: "https://ci.example.test/l" }, // kept
        ],
      },
    },
    branchProtection: {
      main: { branch: "main", requiredStatusChecks: ["unit-tests", "build"], requiresReview: true },
    },
    deployments: [{ id: 9001, environment: "production", sha: SNAP, state: "success" }],
    attestations: {},
    files: {
      CODEOWNERS: { path: "CODEOWNERS", ref: "main", contentSha: "d".repeat(40), text: "* @acme/maintainers\n" },
    },
    securityAlerts: [],
    artifacts: {
      "5001:test-results": {
        name: "test-results",
        files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
      },
    },
  },
};

test("collectScan: unions checks + status into SHA-snapshotted surfaces (gotcha 1 + 2)", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, { prState: "merged" });
  const byName = new Map(scan.surfaces.map((s) => [s.name, s]));
  // build appears exactly once (as the check-run), legacy-ci kept once.
  assert.equal(scan.surfaces.filter((s) => s.name === "build").length, 1);
  assert.equal(byName.get("build")!.kind, "check-run");
  assert.equal(byName.get("legacy-ci")!.kind, "status");
  // gotcha 2: every non-synthetic check surface carries the snapshot SHA.
  for (const s of ["unit-tests", "build", "legacy-ci"]) assert.equal(byName.get(s)!.sha, SNAP);
});

test("collectScan: synthesizes review + CODEOWNERS + deploy surfaces; carries discoveredVia", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, { prState: "merged" });
  const names = new Set(scan.surfaces.map((s) => s.name));
  assert.ok(names.has("code-review"), "approving review → code-review surface");
  assert.ok(names.has("CODEOWNERS"), "CODEOWNERS file → codeowners surface");
  assert.ok(names.has("deploy/production"), "deployment → deploy surface");
  assert.equal(scan.discoveredVia, "fixture");
});

test("collectScan: branch protection drives requiredChecks incl. review→required", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, { prState: "merged" });
  assert.ok(scan.requiredChecks.includes("unit-tests"));
  assert.ok(scan.requiredChecks.includes("build"));
  // requiresReview promotes the synthesized checkpoint surfaces to required.
  assert.ok(scan.requiredChecks.includes("code-review"));
  assert.ok(scan.requiredChecks.includes("CODEOWNERS"));
});

test("collectScan → buildEvidenceMap: required checks label L2, optional label L1", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, { prState: "merged" });
  const map = buildEvidenceMap([scan]);
  const entry = (name: string) => map.sources.find((s) => s.sourceKey.endsWith(name))!;
  // unit-tests is required → required-status-check / L2.
  assert.equal(entry("unit-tests").strength, "required-status-check");
  assert.equal(entry("unit-tests").provTier, "L2");
  // legacy-ci is an unrequired legacy status → self-reported / L1.
  assert.equal(entry("legacy-ci").strength, "self-reported");
  assert.equal(entry("legacy-ci").provTier, "L1");
  // CODEOWNERS (required review) → checkpoint class, required-status-check.
  assert.equal(entry("CODEOWNERS").evClass, "codeowners");
  assert.equal(entry("CODEOWNERS").strength, "required-status-check");
  // fresh adopter: nothing wired.
  assert.equal(map.counts.wiredToTrust, 0);
  assert.ok(map.sources.every((s) => s.wiredToTrust === false));
  assert.ok(map.sources.every((s) => s.discoveredVia === "fixture"));
});

test("collectScan: caller-supplied artifact is downloaded + attached with linkSha (gotcha 2)", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, {
    prState: "merged",
    artifacts: [{ runId: 5001, name: "test-results", kind: "junit", linkSurfaceName: "unit-tests", linkSha: SNAP }],
  });
  assert.ok(scan.artifacts && scan.artifacts.length === 1);
  assert.equal(scan.artifacts[0].kind, "junit");
  assert.equal(scan.artifacts[0].linkSha, SNAP);
  const map = buildEvidenceMap([scan]);
  const unit = map.sources.find((s) => s.sourceKey.endsWith("unit-tests"))!;
  assert.ok(unit.artifact, "artifact attached to the matching surface+SHA");
  assert.equal(unit.artifact.kind, "junit");
  assert.equal(unit.artifact.testCount, 3);
  assert.equal(map.counts.withArtifact, 1);
});

test("collectScan: no artifacts requested → artifact-free scan (frozen contract preserved)", async () => {
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, { prState: "merged" });
  assert.equal(scan.artifacts, undefined);
  const map = buildEvidenceMap([scan]);
  assert.equal(map.counts.withArtifact, 0);
});
