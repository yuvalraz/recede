// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.5 remediation — OFFLINE transport tests for GhApiEvidenceSource. Injects a
 * STUBBED exec (no real `gh` spawn, no network) so the subprocess boundary is
 * proven in CI:
 *   - HIGH-1 (updated P3.3): top-level-ARRAY endpoints (/pulls, /reviews,
 *     /deployments) use bare `--paginate`; object-envelope endpoints (check-runs,
 *     combined status) use `--paginate --slurp` (bare --paginate would emit
 *     concatenated JSON that crashes JSON.parse; --slurp wraps page envelopes
 *     in one array the adapter merges).
 *   - HIGH-2: an absent artifact (`gh run download` stderr "no valid artifacts
 *     found to download") returns null, not a thrown crash.
 *   - MEDIUM-2/3: gh-boundary guards (artifact name leading '-', path '..').
 * Plus the CLI reachability seam: `parseArtifactSpec` parses the --artifact flag
 * and drives the collectScan pipeline so withArtifact becomes non-zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GhApiEvidenceSource,
  FixtureEvidenceSource,
  collectScan,
  buildEvidenceMap,
  parseArtifactSpec,
  type FixtureSet,
} from "../scanner.ts";

const SNAP = "c".repeat(40);
const REPO = { owner: "acme", repo: "example" } as const;

/** A stub exec that records argv and returns a shape-appropriate stdout per path. */
function recordingExec(seen: Record<string, readonly string[]>) {
  return async (_file: string, args: readonly string[]) => {
    const path = args[1] ?? "";
    seen[path] = args;
    // Envelope endpoints are read with --paginate --slurp (P3.3): one JSON ARRAY
    // of page envelope objects.
    if (path.includes("/check-runs")) return { stdout: '[{"total_count":0,"check_runs":[]}]' };
    if (path.includes("/status")) return { stdout: '[{"sha":"x","state":"success","statuses":[]}]' };
    return { stdout: "[]" };
  };
}

test("HIGH-1: bare --paginate on array endpoints; --paginate --slurp on object-envelope endpoints", async () => {
  const seen: Record<string, readonly string[]> = {};
  const src = new GhApiEvidenceSource(recordingExec(seen) as never);
  await src.listPullRequests(REPO, { state: "all" });
  await src.listReviews(REPO, 7);
  await src.listDeployments(REPO);
  await src.listCheckRunsForRef(REPO, "a".repeat(40));
  await src.getCombinedStatus(REPO, "a".repeat(40));

  const argvFor = (frag: string): readonly string[] =>
    Object.entries(seen).find(([p]) => p.includes(frag))![1];

  assert.ok(argvFor("/pulls?").includes("--paginate"), "pulls list paginates");
  assert.equal(argvFor("/pulls?").includes("--slurp"), false, "array endpoints do not slurp");
  assert.ok(argvFor("/reviews").includes("--paginate"), "reviews paginate");
  assert.ok(argvFor("/deployments").includes("--paginate"), "deployments paginate");
  assert.ok(argvFor("/check-runs").includes("--paginate"), "check-runs fully paginate (P3.3)");
  assert.ok(argvFor("/check-runs").includes("--slurp"), "check-runs slurp page envelopes");
  assert.ok(argvFor("/status").includes("--paginate"), "combined status fully paginates (P3.3)");
  assert.ok(argvFor("/status").includes("--slurp"), "combined status slurps page envelopes");
});

test("HIGH-1: combined status requests per_page=100 (page SIZE; pagination is full via --slurp)", async () => {
  const seen: Record<string, readonly string[]> = {};
  const src = new GhApiEvidenceSource(recordingExec(seen) as never);
  await src.getCombinedStatus(REPO, "a".repeat(40));
  const statusPath = Object.keys(seen).find((p) => p.includes("/status"))!;
  assert.ok(statusPath.includes("per_page=100"), "combined status uses 100-item pages");
});

test("HIGH-1: concatenated-JSON parse failure rethrows naming the pagination cause", async () => {
  // Two top-level objects concatenated (what --paginate would emit on an envelope endpoint).
  const exec = async () => ({ stdout: '{"check_runs":[]}\n{"check_runs":[]}' });
  const src = new GhApiEvidenceSource(exec as never);
  await assert.rejects(() => src.listCheckRunsForRef(REPO, "a".repeat(40)), /pagination/i);
});

test("HIGH-2: absent artifact ('no valid artifacts found') → null, not a thrown crash", async () => {
  const exec = async () => {
    throw { stderr: "no valid artifacts found to download\n", code: 1 };
  };
  const src = new GhApiEvidenceSource(exec as never);
  const res = await src.downloadRunArtifact(REPO, 5001, "test-results");
  assert.equal(res, null);
});

test("HIGH-2: a genuine gh failure still fails LOUD (not swallowed as null)", async () => {
  const exec = async () => {
    throw { stderr: "authentication required", code: 1 };
  };
  const src = new GhApiEvidenceSource(exec as never);
  await assert.rejects(() => src.downloadRunArtifact(REPO, 5001, "test-results"), /authentication required/);
});

test("MEDIUM-2: downloadRunArtifact rejects an artifactName starting with '-'", async () => {
  const exec = async () => ({ stdout: "" });
  const src = new GhApiEvidenceSource(exec as never);
  await assert.rejects(() => src.downloadRunArtifact(REPO, 1, "-n"), /unsafe artifactName/i);
});

test("MEDIUM-3: getFileContent rejects a '..' path segment (traversal)", async () => {
  const exec = async () => ({ stdout: "{}" });
  const src = new GhApiEvidenceSource(exec as never);
  await assert.rejects(() => src.getFileContent(REPO, "../../etc/passwd"), /\.\./);
});

test("reachability: parseArtifactSpec parses runId:name:kind:surface:sha", () => {
  const req = parseArtifactSpec(`5001:test-results:junit:unit-tests:${SNAP}`);
  assert.deepEqual(req, {
    runId: 5001,
    name: "test-results",
    kind: "junit",
    linkSurfaceName: "unit-tests",
    linkSha: SNAP,
  });
});

test("reachability: parseArtifactSpec rejects a bad kind and wrong arity", () => {
  assert.throws(() => parseArtifactSpec(`5001:x:bogus:s:${SNAP}`), /kind/i);
  assert.throws(() => parseArtifactSpec("too:few:parts"), /runId:name:kind/i);
});

const fixtures: FixtureSet = {
  "acme/example": {
    pullRequests: [
      { number: 7, merged: true, mergeCommitSha: SNAP, headSha: "a".repeat(40), author: "octo-dev", mergedAt: "2026-01-15T10:00:00Z" },
    ],
    reviews: {},
    workflowRuns: [],
    checkRuns: {
      [SNAP]: [
        { name: "unit-tests", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl: null, app: "github-actions" },
      ],
    },
    combinedStatus: {},
    branchProtection: {},
    deployments: [],
    attestations: {},
    files: {},
    securityAlerts: [],
    artifacts: {
      "5001:test-results": {
        name: "test-results",
        files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
      },
    },
  },
};

test("reachability: a parsed --artifact spec drives collectScan → withArtifact non-zero", async () => {
  const req = parseArtifactSpec(`5001:test-results:junit:unit-tests:${SNAP}`);
  const scan = await collectScan(new FixtureEvidenceSource(fixtures), REPO, {
    prState: "merged",
    artifacts: [req],
  });
  const map = buildEvidenceMap([scan]);
  assert.equal(map.counts.withArtifact, 1);
});
