// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * fake-github — HAND-AUTHORED SYNTHETIC GitHub evidence, NOT a dump of a real
 * API response. OPSEC: placeholder owner (`acme`/`example`), fake SHAs
 * (`aaa…`/`bbb…`/`ccc…`), NO real tokens, NO PII, NO private-repo data, no auth
 * headers. It exercises the later phases:
 *   - a merged PR (#7) + two reviews;
 *   - workflow runs;
 *   - check-runs where `unit-tests` is a REQUIRED check, `lint` is optional, and
 *     `build` is a GitHub Action that ALSO appears as a same-name combined-status
 *     context (P2.2 gotcha 1), plus a legacy `legacy-ci` status with no matching
 *     check-run;
 *   - a combined status; branch protection with a required-checks list +
 *     requiresReview; a deployment; a signed attestation; a CODEOWNERS + a
 *     workflow YAML file; a security alert;
 *   - a second SHA (`bbb…`) with the same check names, to seed the P2.2 gotcha-2
 *     SHA-snapshot test (no cross-SHA merge);
 *   - a minimal ArtifactFiles fixture (full junit/coverage/mutation content is P2.4).
 */

import type { FixtureSet } from "../../scanner.ts";

// Synthetic, obviously-fake commit SHAs (40 hex chars).
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const MERGE_SHA = "c".repeat(40);

export const REPO = { owner: "acme", repo: "example" } as const;

const checkRunsAtA = [
  {
    name: "unit-tests",
    headSha: SHA_A,
    conclusion: "success",
    status: "completed",
    detailsUrl: "https://github.com/acme/example/runs/1001",
    app: "github-actions",
  },
  {
    name: "lint",
    headSha: SHA_A,
    conclusion: "success",
    status: "completed",
    detailsUrl: "https://github.com/acme/example/runs/1002",
    app: "github-actions",
  },
  {
    // A GitHub Action result IS a check run — this same name also appears as a
    // combined-status context below (gotcha 1).
    name: "build",
    headSha: SHA_A,
    conclusion: "success",
    status: "completed",
    detailsUrl: "https://github.com/acme/example/runs/1003",
    app: "github-actions",
  },
];

// Same check names at a second SHA (simulates a new push; gotcha 2).
const checkRunsAtB = checkRunsAtA.map((cr) => ({ ...cr, headSha: SHA_B }));

const combinedStatusAtA = {
  sha: SHA_A,
  state: "success",
  statuses: [
    // Same name as the `build` check-run above (the union must dedupe this).
    { context: "build", state: "success", targetUrl: "https://ci.example.test/build/1" },
    // Legacy status with NO matching check-run (the union must keep this).
    { context: "legacy-ci", state: "success", targetUrl: "https://ci.example.test/legacy/1" },
  ],
};

/** The one synthetic repo in the fixture set. */
export const fixtureSet: FixtureSet = {
  "acme/example": {
    pullRequests: [
      {
        number: 7,
        merged: true,
        mergeCommitSha: MERGE_SHA,
        headSha: SHA_A,
        author: "octo-dev",
        mergedAt: "2026-01-15T10:00:00Z",
      },
    ],
    reviews: {
      7: [
        { prNumber: 7, state: "APPROVED", author: "reviewer-one", submittedAt: "2026-01-15T09:30:00Z" },
        { prNumber: 7, state: "COMMENTED", author: "reviewer-two", submittedAt: "2026-01-15T09:45:00Z" },
      ],
    },
    workflowRuns: [
      {
        id: 5001,
        name: "CI",
        path: ".github/workflows/ci.yml",
        headSha: SHA_A,
        conclusion: "success",
        event: "pull_request",
      },
    ],
    checkRuns: {
      [SHA_A]: checkRunsAtA,
      [SHA_B]: checkRunsAtB,
    },
    combinedStatus: {
      [SHA_A]: combinedStatusAtA,
      [SHA_B]: { sha: SHA_B, state: "success", statuses: combinedStatusAtA.statuses },
    },
    branchProtection: {
      main: { branch: "main", requiredStatusChecks: ["unit-tests", "build"], requiresReview: true },
    },
    deployments: [{ id: 9001, environment: "production", sha: MERGE_SHA, state: "success" }],
    attestations: {
      "sha256:deadbeef": [
        {
          subjectDigest: "sha256:deadbeef",
          predicateType: "https://slsa.dev/provenance/v1",
          bundleUrl: "https://github.com/acme/example/attestations/1",
        },
      ],
    },
    files: {
      CODEOWNERS: {
        path: "CODEOWNERS",
        ref: "main",
        contentSha: "d".repeat(40),
        text: "* @acme/maintainers\n",
      },
      ".github/workflows/ci.yml": {
        path: ".github/workflows/ci.yml",
        ref: "main",
        contentSha: "e".repeat(40),
        text: "name: CI\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
      },
    },
    securityAlerts: [
      { id: "GHSA-xxxx-yyyy-zzzz", kind: "dependabot", state: "open", severity: "high" },
    ],
    artifacts: {
      // Minimal ArtifactFiles fixture; full junit/coverage/mutation content is P2.4.
      "5001:test-results": {
        name: "test-results",
        files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
      },
    },
  },
};
