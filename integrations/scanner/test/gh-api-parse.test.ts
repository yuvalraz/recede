// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.5 — OFFLINE gh-api parse tests. Feeds RECORDED, SCRUBBED `gh` JSON strings
 * (hand-authored synthetic; placeholder owners `acme`/`example`, fake 40-char
 * SHAs, no tokens, no PII) to the PARSE functions the `GhApiEvidenceSource`
 * factors out from its subprocess calls. This is how gh-api parsing is proven
 * without any network or `gh` spawn.
 *
 * The parsing is deliberately factored OUT of the `execFile('gh', ...)` call so
 * the mapping (`gh` JSON → `Raw*`) is a pure, unit-testable function. The
 * adapter methods are then a thin `execFile → JSON.parse → parseFoo` seam.
 *
 * Namespace import so a not-yet-defined parser is `undefined` during RED and the
 * call fails behaviorally ("is not a function") — a real RED, not a collection error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("parsePullRequests: maps closed pulls, merged = merged_at present", () => {
  const json = JSON.stringify([
    {
      number: 7,
      merged_at: "2026-01-02T00:00:00Z",
      merge_commit_sha: SHA_B,
      head: { sha: SHA_A },
      user: { login: "octo-dev" },
    },
    {
      number: 8,
      merged_at: null,
      merge_commit_sha: null,
      head: { sha: SHA_A },
      user: { login: "octo-dev" },
    },
  ]);
  const prs = scanner.parsePullRequests(JSON.parse(json));
  assert.equal(prs.length, 2);
  assert.equal(prs[0].number, 7);
  assert.equal(prs[0].merged, true);
  assert.equal(prs[0].mergeCommitSha, SHA_B);
  assert.equal(prs[0].headSha, SHA_A);
  assert.equal(prs[0].author, "octo-dev");
  assert.equal(prs[0].mergedAt, "2026-01-02T00:00:00Z");
  assert.equal(prs[1].merged, false);
  assert.equal(prs[1].mergeCommitSha, null);
});

test("parseReviews: maps state + author + submitted_at, stamps prNumber", () => {
  const json = JSON.stringify([
    { state: "APPROVED", user: { login: "rev-one" }, submitted_at: "2026-01-01T00:00:00Z" },
    { state: "COMMENTED", user: { login: "rev-two" }, submitted_at: null },
  ]);
  const reviews = scanner.parseReviews(JSON.parse(json), 7);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].prNumber, 7);
  assert.equal(reviews[0].state, "APPROVED");
  assert.equal(reviews[0].author, "rev-one");
  assert.equal(reviews[1].submittedAt, null);
});

test("parseCheckRuns: reads the check_runs envelope + app.slug", () => {
  const json = JSON.stringify({
    total_count: 2,
    check_runs: [
      {
        name: "unit-tests",
        head_sha: SHA_A,
        conclusion: "success",
        status: "completed",
        details_url: "https://example.test/run/1",
        app: { slug: "github-actions" },
      },
      {
        name: "codeql",
        head_sha: SHA_A,
        conclusion: null,
        status: "in_progress",
        details_url: null,
        app: null,
      },
    ],
  });
  const runs = scanner.parseCheckRuns(JSON.parse(json));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].name, "unit-tests");
  assert.equal(runs[0].headSha, SHA_A);
  assert.equal(runs[0].conclusion, "success");
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].detailsUrl, "https://example.test/run/1");
  assert.equal(runs[0].app, "github-actions");
  assert.equal(runs[1].conclusion, null);
  assert.equal(runs[1].app, null);
});

test("parseCombinedStatus: reads sha + state + contexts", () => {
  const json = JSON.stringify({
    sha: SHA_A,
    state: "success",
    statuses: [
      { context: "legacy-ci", state: "success", target_url: "https://example.test/ci" },
      { context: "unit-tests", state: "success", target_url: null },
    ],
  });
  const combined = scanner.parseCombinedStatus(JSON.parse(json));
  assert.equal(combined.sha, SHA_A);
  assert.equal(combined.state, "success");
  assert.equal(combined.statuses.length, 2);
  assert.equal(combined.statuses[0].context, "legacy-ci");
  assert.equal(combined.statuses[0].targetUrl, "https://example.test/ci");
  assert.equal(combined.statuses[1].targetUrl, null);
});

test("parseBranchProtection: reads required contexts + review requirement", () => {
  const json = JSON.stringify({
    required_status_checks: { strict: true, contexts: ["unit-tests", "build"] },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  });
  const bp = scanner.parseBranchProtection(JSON.parse(json), "main");
  assert.equal(bp.branch, "main");
  assert.deepEqual(bp.requiredStatusChecks, ["unit-tests", "build"]);
  assert.equal(bp.requiresReview, true);
});

test("parseBranchProtection: no review block + no contexts → empty + false", () => {
  const bp = scanner.parseBranchProtection(JSON.parse("{}"), "main");
  assert.deepEqual(bp.requiredStatusChecks, []);
  assert.equal(bp.requiresReview, false);
});

test("parseWorkflowRuns: reads the workflow_runs envelope", () => {
  const json = JSON.stringify({
    total_count: 1,
    workflow_runs: [
      {
        id: 5001,
        name: "CI",
        path: ".github/workflows/ci.yml",
        head_sha: SHA_A,
        conclusion: "success",
        event: "push",
      },
    ],
  });
  const runs = scanner.parseWorkflowRuns(JSON.parse(json));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 5001);
  assert.equal(runs[0].name, "CI");
  assert.equal(runs[0].path, ".github/workflows/ci.yml");
  assert.equal(runs[0].headSha, SHA_A);
  assert.equal(runs[0].event, "push");
});

test("parseDeployments: maps id + environment + sha", () => {
  const json = JSON.stringify([
    { id: 42, environment: "production", sha: SHA_B, statuses_url: "https://example.test/s" },
  ]);
  const deps = scanner.parseDeployments(JSON.parse(json));
  assert.equal(deps.length, 1);
  assert.equal(deps[0].id, 42);
  assert.equal(deps[0].environment, "production");
  assert.equal(deps[0].sha, SHA_B);
});

test("parseFileContent: base64-decodes the contents response to text", () => {
  const text = "* @acme/maintainers\n";
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const json = JSON.stringify({ path: "CODEOWNERS", sha: "filesha123", content: encoded, encoding: "base64" });
  const file = scanner.parseFileContent(JSON.parse(json), "CODEOWNERS", "main");
  assert.ok(file);
  assert.equal(file.path, "CODEOWNERS");
  assert.equal(file.ref, "main");
  assert.equal(file.contentSha, "filesha123");
  assert.equal(file.text, text);
});

test("parseSecurityAlerts: maps id + state + severity", () => {
  const json = JSON.stringify([
    {
      number: 3,
      state: "open",
      rule: { severity: "high" },
    },
  ]);
  const alerts = scanner.parseSecurityAlerts(JSON.parse(json), "code-scanning");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, "3");
  assert.equal(alerts[0].kind, "code-scanning");
  assert.equal(alerts[0].state, "open");
  assert.equal(alerts[0].severity, "high");
});

test("parseAttestations: maps predicate type + bundle url", () => {
  const json = JSON.stringify({
    attestations: [
      {
        bundle: { dsseEnvelope: {} },
        predicate_type: "https://slsa.dev/provenance/v1",
        bundle_url: "https://example.test/att/1",
      },
    ],
  });
  const atts = scanner.parseAttestations(JSON.parse(json), "sha256:deadbeef");
  assert.equal(atts.length, 1);
  assert.equal(atts[0].subjectDigest, "sha256:deadbeef");
  assert.equal(atts[0].predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(atts[0].bundleUrl, "https://example.test/att/1");
});

test("parse functions are fail-loud on a non-array/non-object where a shape is required", () => {
  // A garbled gh payload must not silently read as an empty inventory.
  assert.throws(() => scanner.parsePullRequests("not-an-array" as unknown), /expected an array/i);
  assert.throws(() => scanner.parseCheckRuns(42 as unknown), /expected/i);
});
