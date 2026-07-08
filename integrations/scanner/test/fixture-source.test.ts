// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.0 — FixtureEvidenceSource seam test. Reads a fixture PR + its check-runs
 * and one downloadRunArtifact through the pure in-memory adapter, asserting the
 * typed `Raw*` / `ArtifactFiles` shapes come back. No network, no I/O.
 *
 * Namespace import so that during RED the not-yet-defined `FixtureEvidenceSource`
 * is `undefined` and construction fails behaviorally ("is not a constructor") —
 * a real RED, not a module-collection error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import { fixtureSet, REPO, SHA_A } from "./fixtures/fake-github.ts";

test("FixtureEvidenceSource: listPullRequests returns the typed merged PR", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const prs = await src.listPullRequests(REPO);
  assert.equal(prs.length, 1);
  const pr = prs[0];
  assert.equal(pr.number, 7);
  assert.equal(pr.merged, true);
  assert.equal(pr.headSha, SHA_A);
  assert.equal(pr.author, "octo-dev");
});

test("FixtureEvidenceSource: listPullRequests honors the state filter", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  assert.equal((await src.listPullRequests(REPO, { state: "merged" })).length, 1);
  assert.equal((await src.listPullRequests(REPO, { state: "open" })).length, 0);
});

test("FixtureEvidenceSource: listReviews returns the PR's reviews", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const reviews = await src.listReviews(REPO, 7);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].state, "APPROVED");
  assert.equal(reviews[0].prNumber, 7);
});

test("FixtureEvidenceSource: listCheckRunsForRef returns SHA-keyed check-runs", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const runs = await src.listCheckRunsForRef(REPO, SHA_A);
  assert.equal(runs.length, 3);
  const names = runs.map((r) => r.name).sort();
  assert.deepEqual(names, ["build", "lint", "unit-tests"]);
  assert.ok(runs.every((r) => r.headSha === SHA_A));
});

test("FixtureEvidenceSource: getCombinedStatus returns the combined status at a SHA", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const combined = await src.getCombinedStatus(REPO, SHA_A);
  assert.equal(combined.sha, SHA_A);
  const contexts = combined.statuses.map((s) => s.context).sort();
  assert.deepEqual(contexts, ["build", "legacy-ci"]);
});

test("FixtureEvidenceSource: getBranchProtection returns the required-checks list", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const bp = await src.getBranchProtection(REPO, "main");
  assert.ok(bp);
  assert.deepEqual(bp.requiredStatusChecks, ["unit-tests", "build"]);
  assert.equal(bp.requiresReview, true);
});

test("FixtureEvidenceSource: getBranchProtection returns null when absent", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  assert.equal(await src.getBranchProtection(REPO, "no-such-branch"), null);
});

test("FixtureEvidenceSource: listAttestations, deployments, files, security alerts", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  assert.equal((await src.listAttestations(REPO, "sha256:deadbeef")).length, 1);
  assert.equal((await src.listDeployments(REPO)).length, 1);
  const codeowners = await src.getFileContent(REPO, "CODEOWNERS");
  assert.ok(codeowners);
  assert.match(codeowners.text, /@acme\/maintainers/);
  assert.equal(await src.getFileContent(REPO, "missing.txt"), null);
  assert.equal((await src.listSecurityAlerts(REPO)).length, 1);
});

test("FixtureEvidenceSource: downloadRunArtifact returns in-memory ArtifactFiles or null", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const art = await src.downloadRunArtifact(REPO, 5001, "test-results");
  assert.ok(art);
  assert.equal(art.name, "test-results");
  assert.ok("junit.xml" in art.files);
  assert.equal(await src.downloadRunArtifact(REPO, 5001, "no-such-artifact"), null);
});

test("FixtureEvidenceSource: unknown repo yields empty/null (no crash)", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const other = { owner: "nobody", repo: "nothing" };
  assert.deepEqual(await src.listPullRequests(other), []);
  assert.equal(await src.getBranchProtection(other, "main"), null);
  assert.deepEqual(await src.listReviews(other, 1), []);
});
