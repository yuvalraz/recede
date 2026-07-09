// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.3 item 1 — artifact AUTO-discovery. The `listRunArtifacts` seam method, the
 * pure `inferArtifactKind` name→kind heuristic, and the `collectScan` wiring that
 * builds `ArtifactRequest`s automatically when the caller supplies none:
 *   - heuristic priority (mutation → coverage → junit, first match wins) +
 *     case-insensitivity + null on no match,
 *   - expired and null-kind artifacts are skipped,
 *   - auto-built requests carry linkSha from the run's headSha (gotcha 2) and
 *     linkSurfaceName from the run name,
 *   - an EXPLICIT `--artifact` request fully overrides (no auto when supplied),
 *   - the fixture + MCP adapters honor the new seam method.
 *
 * Namespace import so a not-yet-defined export fails behaviorally during RED
 * ("scanner.inferArtifactKind is not a function") — a real RED, not a load error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";

const SNAP = "c".repeat(40); // the merge-commit SHA the checks + run live at
const REPO = { owner: "acme", repo: "example" } as const;

/** A fixture whose workflow run 4242 (at SNAP) exposes three listable artifacts:
 * one live junit (auto-attachable), one EXPIRED coverage, one kind-less log. */
function fixturesWith(runArtifacts: scanner.RepoFixture["runArtifacts"]): scanner.FixtureSet {
  return {
    "acme/example": {
      pullRequests: [
        { number: 7, merged: true, mergeCommitSha: SNAP, headSha: "a".repeat(40), author: "octo-dev", mergedAt: "2026-01-15T10:00:00Z" },
      ],
      reviews: {},
      workflowRuns: [
        { id: 4242, name: "unit-tests", path: ".github/workflows/ci.yml", headSha: SNAP, conclusion: "success", event: "push" },
      ],
      checkRuns: {
        [SNAP]: [
          { name: "unit-tests", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl: "https://example.test/1", app: "github-actions" },
        ],
      },
      combinedStatus: {},
      branchProtection: {},
      deployments: [],
      attestations: {},
      files: {},
      securityAlerts: [],
      artifacts: {
        "4242:test-results": {
          name: "test-results",
          files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
        },
        "5001:manual-junit": {
          name: "manual-junit",
          files: { "junit.xml": '<testsuite tests="9" failures="1" errors="0" skipped="0"></testsuite>' },
        },
      },
      runArtifacts,
    },
  };
}

const THREE_ARTIFACTS: scanner.RepoFixture["runArtifacts"] = {
  4242: [
    { id: 1, name: "test-results", sizeBytes: 2048, expired: false },
    { id: 2, name: "coverage-report", sizeBytes: 1024, expired: true }, // expired → skipped
    { id: 3, name: "build-logs", sizeBytes: 512, expired: false }, // null kind → skipped
  ],
};

test("inferArtifactKind: keyword heuristic, first-match priority mutation → coverage → junit", () => {
  // junit family
  assert.equal(scanner.inferArtifactKind("junit-report"), "junit");
  assert.equal(scanner.inferArtifactKind("test-results"), "junit");
  assert.equal(scanner.inferArtifactKind("surefire-reports"), "junit");
  // coverage family
  assert.equal(scanner.inferArtifactKind("coverage-report"), "coverage");
  assert.equal(scanner.inferArtifactKind("lcov"), "coverage");
  assert.equal(scanner.inferArtifactKind("codecov-upload"), "coverage");
  // mutation family
  assert.equal(scanner.inferArtifactKind("mutation-report"), "mutation");
  assert.equal(scanner.inferArtifactKind("stryker-output"), "mutation");
  assert.equal(scanner.inferArtifactKind("pitest-out"), "mutation");
  // priority: mutation beats the broad "test-results" junit keyword; coverage beats junit.
  assert.equal(scanner.inferArtifactKind("mutation-test-results"), "mutation");
  assert.equal(scanner.inferArtifactKind("codecov-junit"), "coverage");
  // case-insensitive
  assert.equal(scanner.inferArtifactKind("JUnit-Results"), "junit");
  // no keyword → null
  assert.equal(scanner.inferArtifactKind("build-logs"), null);
  assert.equal(scanner.inferArtifactKind(""), null);
});

test("auto-discovery: no --artifact supplied → requests built from run artifacts (expired + null-kind skipped)", async () => {
  const source = new scanner.FixtureEvidenceSource(fixturesWith(THREE_ARTIFACTS));
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  // Only the live junit artifact attaches: expired coverage + kind-less log skipped.
  assert.ok(scan.artifacts, "auto-discovered artifacts present on the scan");
  assert.equal(scan.artifacts.length, 1);
  assert.equal(scan.artifacts[0].kind, "junit");
  assert.equal(scan.artifacts[0].linkSha, SNAP, "linkSha comes from the run's headSha (gotcha 2)");
  assert.equal(scan.artifacts[0].linkSurfaceName, "unit-tests", "linkSurfaceName comes from the run name");
  assert.deepEqual(scan.autoDiscovery, { found: 3, attached: 1 });
  // Through the frozen map: the junit attaches to the unit-tests entry.
  const map = scanner.buildEvidenceMap([scan]);
  assert.equal(map.counts.withArtifact, 1);
  const unit = map.sources.find((s) => s.sourceKey.endsWith("unit-tests"))!;
  assert.deepEqual(unit.artifact, { kind: "junit", testCount: 3, failures: 0 });
  assert.equal(map.schemaVersion, "recede-evidence-map/1", "schema stays frozen");
});

test("auto-discovery: an explicit --artifact request OVERRIDES (no auto when supplied)", async () => {
  const source = new scanner.FixtureEvidenceSource(fixturesWith(THREE_ARTIFACTS));
  const scan = await scanner.collectScan(source, REPO, {
    prState: "merged",
    artifacts: [{ runId: 5001, name: "manual-junit", kind: "junit", linkSurfaceName: "unit-tests", linkSha: SNAP }],
  });
  assert.equal(scan.autoDiscovery, undefined, "auto-discovery does not run when --artifact is supplied");
  assert.equal(scan.artifacts?.length, 1);
  assert.equal(scan.artifacts![0].files.name, "manual-junit", "only the explicit request is downloaded");
});

test("auto-discovery: a run with NO listable artifacts leaves the scan artifact-free (frozen contract)", async () => {
  const source = new scanner.FixtureEvidenceSource(fixturesWith(undefined));
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.equal(scan.artifacts, undefined, "no artifacts key when nothing was discovered");
  assert.deepEqual(scan.autoDiscovery, { found: 0, attached: 0 });
});

test("seam: FixtureEvidenceSource.listRunArtifacts returns fixture rows; absent → []", async () => {
  const source = new scanner.FixtureEvidenceSource(fixturesWith(THREE_ARTIFACTS));
  const rows = await source.listRunArtifacts(REPO, 4242);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: 1, name: "test-results", sizeBytes: 2048, expired: false });
  assert.deepEqual(await source.listRunArtifacts(REPO, 9999), []);
});

test("seam: McpEvidenceSource.listRunArtifacts throws NotConnectedError", () => {
  const mcp = new scanner.McpEvidenceSource();
  assert.throws(() => mcp.listRunArtifacts(), scanner.NotConnectedError);
});

// ---------------------------------------------------------------------------
// Remediation (reviewer HIGH + hunter HIGH): the attach join on REAL repos.
// A workflow run's `name` is the WORKFLOW name ("CI"); check-run surfaces carry
// JOB names ("unit-tests"). The join must derive the surface name from the
// check-run whose Actions detailsUrl embeds the run id
// (https://github.com/{o}/{r}/actions/runs/{runId}/job/{jobId}).
// ---------------------------------------------------------------------------

/** Real-repo shape: workflow named "CI", job/check-run named "unit-tests", the
 * check-run's detailsUrl carrying the run id. */
function realShapeFixtures(detailsUrl: string | null): scanner.FixtureSet {
  return {
    "acme/example": {
      pullRequests: [
        { number: 7, merged: true, mergeCommitSha: SNAP, headSha: "a".repeat(40), author: "octo-dev", mergedAt: "2026-01-15T10:00:00Z" },
      ],
      reviews: {},
      workflowRuns: [
        { id: 4242, name: "CI", path: ".github/workflows/ci.yml", headSha: SNAP, conclusion: "success", event: "push" },
      ],
      checkRuns: {
        [SNAP]: [
          { name: "unit-tests", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl, app: "github-actions" },
        ],
      },
      combinedStatus: {},
      branchProtection: {},
      deployments: [],
      attestations: {},
      files: {},
      securityAlerts: [],
      artifacts: {
        "4242:test-results": {
          name: "test-results",
          files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
        },
      },
      runArtifacts: { 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: false }] },
    },
  };
}

test("attach join: workflow name != job name — detailsUrl run-id match derives linkSurfaceName", async () => {
  const source = new scanner.FixtureEvidenceSource(
    realShapeFixtures("https://github.com/acme/example/actions/runs/4242/job/777"),
  );
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.ok(scan.artifacts, "artifact attached despite workflow name 'CI' != job name 'unit-tests'");
  assert.equal(scan.artifacts.length, 1);
  assert.equal(scan.artifacts[0].linkSurfaceName, "unit-tests", "surface name derived from the detailsUrl run-id join");
  assert.deepEqual(scan.autoDiscovery, { found: 1, attached: 1 });
  const map = scanner.buildEvidenceMap([scan]);
  assert.equal(map.counts.withArtifact, 1);
  const unit = map.sources.find((s) => s.sourceKey.includes("unit-tests"))!;
  assert.deepEqual(unit.artifact, { kind: "junit", testCount: 3, failures: 0 });
});

test("attach join: zero surface match (no run-id in detailsUrl, run name matches nothing) → skipped, found>attached", async () => {
  const source = new scanner.FixtureEvidenceSource(realShapeFixtures(null));
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.equal(scan.artifacts, undefined, "an unattachable artifact is never downloaded");
  assert.deepEqual(scan.autoDiscovery, { found: 1, attached: 0 }, "the skip stays visible as found>attached");
});

test("attach join: bounded walk — listWorkflowRuns is called per snapshot SHA, never unfiltered (HIGH-3)", async () => {
  const calls: Array<{ headSha?: string } | undefined> = [];
  class RecordingSource extends scanner.FixtureEvidenceSource {
    override listWorkflowRuns(repo: scanner.RepoRef, opts?: { headSha?: string }) {
      calls.push(opts);
      return super.listWorkflowRuns(repo, opts);
    }
  }
  const source = new RecordingSource(fixturesWith(THREE_ARTIFACTS));
  await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.equal(calls.length, 1, "exactly one call per snapshot SHA");
  assert.deepEqual(calls[0], { headSha: SNAP }, "the walk is head_sha-filtered — never a full run-history slurp");
});
