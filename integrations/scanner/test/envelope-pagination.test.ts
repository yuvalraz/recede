// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.3 item 3 — FULL pagination of OBJECT-envelope endpoints. The `per_page=100`
 * single-page cap is replaced by `gh api --paginate --slurp`: gh wraps each page's
 * envelope object in one JSON ARRAY, and the adapter flat-merges the nested arrays
 * (`.check_runs`/`.statuses`/`.workflow_runs`/`.artifacts`/`.attestations`) across
 * page envelopes. A wrong slurp shape (not an array of envelopes) fails LOUD
 * naming pagination. Offline: exec is a stub — no gh spawn, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GhApiEvidenceSource, mergeSlurpPages } from "../scanner.ts";

const REPO = { owner: "acme", repo: "example" } as const;
const SHA = "a".repeat(40);

/** Build a two-page check-runs slurp: 100 runs on page 1, 5 on page 2. */
function twoPageCheckRuns(): string {
  const run = (i: number) => ({
    name: `shard-${i}`,
    head_sha: SHA,
    conclusion: "success",
    status: "completed",
    details_url: null,
    app: { slug: "github-actions" },
  });
  const page1 = { total_count: 105, check_runs: Array.from({ length: 100 }, (_, i) => run(i)) };
  const page2 = { total_count: 105, check_runs: Array.from({ length: 5 }, (_, i) => run(100 + i)) };
  return JSON.stringify([page1, page2]);
}

function stubExec(stdoutByFragment: Record<string, string>, seen?: Record<string, readonly string[]>) {
  return async (_file: string, args: readonly string[]) => {
    const path = args[1] ?? "";
    if (seen) seen[path] = args;
    for (const [frag, stdout] of Object.entries(stdoutByFragment)) {
      if (path.includes(frag)) return { stdout };
    }
    return { stdout: "[]" };
  };
}

test("pagination: a >100-check-run two-page slurp merges FULLY (105 surfaces, no truncation)", async () => {
  const src = new GhApiEvidenceSource(stubExec({ "/check-runs": twoPageCheckRuns() }) as never);
  const runs = await src.listCheckRunsForRef(REPO, SHA);
  assert.equal(runs.length, 105, "both pages merged — the 100-item cap is gone");
  assert.equal(runs[0].name, "shard-0");
  assert.equal(runs[104].name, "shard-104");
});

test("pagination: every OBJECT-envelope endpoint sends --paginate AND --slurp", async () => {
  const seen: Record<string, readonly string[]> = {};
  const src = new GhApiEvidenceSource(
    stubExec(
      {
        "/check-runs": '[{"total_count":0,"check_runs":[]}]',
        "/status": '[{"sha":"x","state":"success","statuses":[]}]',
        "/artifacts": '[{"total_count":0,"artifacts":[]}]',
        "/attestations/": '[{"attestations":[]}]',
        "actions/runs": '[{"total_count":0,"workflow_runs":[]}]',
      },
      seen,
    ) as never,
  );
  await src.listCheckRunsForRef(REPO, SHA);
  await src.getCombinedStatus(REPO, SHA);
  await src.listWorkflowRuns(REPO);
  await src.listRunArtifacts(REPO, 4242);
  await src.listAttestations(REPO, "sha256:" + "d".repeat(64));

  for (const frag of ["/check-runs", "/status", "actions/runs", "/artifacts", "/attestations/"]) {
    const argv = Object.entries(seen).find(([p]) => p.includes(frag))?.[1];
    assert.ok(argv, `saw a call for ${frag}`);
    assert.ok(argv.includes("--paginate"), `${frag} paginates`);
    assert.ok(argv.includes("--slurp"), `${frag} slurps page envelopes into one array`);
  }
});

test("pagination: combined status merges statuses across pages, keeps sha/state from page 1", async () => {
  const page1 = { sha: SHA, state: "success", statuses: [{ context: "ci-a", state: "success", target_url: null }] };
  const page2 = { sha: SHA, state: "success", statuses: [{ context: "ci-b", state: "failure", target_url: null }] };
  const src = new GhApiEvidenceSource(stubExec({ "/status": JSON.stringify([page1, page2]) }) as never);
  const combined = await src.getCombinedStatus(REPO, SHA);
  assert.equal(combined.sha, SHA);
  assert.equal(combined.state, "success");
  assert.deepEqual(
    combined.statuses.map((s) => s.context),
    ["ci-a", "ci-b"],
    "statuses flat-merged across page envelopes",
  );
});

test("pagination: workflow runs and run artifacts merge across page envelopes", async () => {
  const runPages = [
    { total_count: 2, workflow_runs: [{ id: 1, name: "ci", path: "w.yml", head_sha: SHA, conclusion: "success", event: "push" }] },
    { total_count: 2, workflow_runs: [{ id: 2, name: "ci", path: "w.yml", head_sha: SHA, conclusion: "success", event: "push" }] },
  ];
  const artPages = [
    { total_count: 2, artifacts: [{ id: 1, name: "test-results", size_in_bytes: 10, expired: false }] },
    { total_count: 2, artifacts: [{ id: 2, name: "coverage", size_in_bytes: 20, expired: true, digest: "sha256:" + "e".repeat(64) }] },
  ];
  const src = new GhApiEvidenceSource(
    stubExec({ "/artifacts": JSON.stringify(artPages), "actions/runs": JSON.stringify(runPages) }) as never,
  );
  const runs = await src.listWorkflowRuns(REPO);
  assert.deepEqual(runs.map((r) => r.id), [1, 2]);
  const arts = await src.listRunArtifacts(REPO, 4242);
  assert.deepEqual(arts.map((a) => a.id), [1, 2]);
  assert.equal(arts[1].expired, true);
  assert.equal(arts[1].digest, "sha256:" + "e".repeat(64));
  assert.equal(arts[0].digest, undefined, "no digest field → undefined, never fabricated");
});

test("pagination: a malformed slurp shape (bare envelope, not an array of envelopes) fails LOUD", async () => {
  const src = new GhApiEvidenceSource(stubExec({ "/check-runs": '{"total_count":0,"check_runs":[]}' }) as never);
  await assert.rejects(() => src.listCheckRunsForRef(REPO, SHA), /pagination|slurp/i);
});

test("pagination: concatenated non-JSON output still rethrows naming the pagination cause", async () => {
  const src = new GhApiEvidenceSource(stubExec({ "/check-runs": '{"check_runs":[]}\n{"check_runs":[]}' }) as never);
  await assert.rejects(() => src.listCheckRunsForRef(REPO, SHA), /pagination/i);
});

test("mergeSlurpPages: a page envelope MISSING the key fails LOUD naming pagination + the key", () => {
  // A renamed/missing envelope key must never read as an empty inventory.
  assert.throws(
    () => mergeSlurpPages([{ total_count: 0 }], "check_runs", "check runs"),
    /pagination.*check_runs|check_runs.*pagination/is,
  );
});

test("mergeSlurpPages: a null envelope key also fails LOUD (fail-loud posture, no silent empty)", () => {
  assert.throws(
    () => mergeSlurpPages([{ total_count: 0, check_runs: null }], "check_runs", "check runs"),
    /pagination.*check_runs|check_runs.*pagination/is,
  );
});

test("mergeSlurpPages: page-boundary duplicates (same id across pages) dedupe first-occurrence-wins", async () => {
  const artPages = [
    { total_count: 3, artifacts: [{ id: 1, name: "a", size_in_bytes: 1, expired: false }, { id: 2, name: "b-page1", size_in_bytes: 2, expired: false }] },
    { total_count: 3, artifacts: [{ id: 2, name: "b-page2", size_in_bytes: 2, expired: false }, { id: 3, name: "c", size_in_bytes: 3, expired: false }] },
  ];
  const src = new GhApiEvidenceSource(stubExec({ "/artifacts": JSON.stringify(artPages) }) as never);
  const arts = await src.listRunArtifacts(REPO, 4242);
  assert.deepEqual(arts.map((a) => a.id), [1, 2, 3], "the page-boundary duplicate collapses to one");
  assert.equal(arts[1].name, "b-page1", "first occurrence wins");
});

test("mergeSlurpPages: items WITHOUT an id are never deduped (statuses may legitimately repeat shape)", () => {
  const merged = mergeSlurpPages(
    [
      { sha: SHA, state: "success", statuses: [{ context: "ci-a", state: "success" }] },
      { sha: SHA, state: "success", statuses: [{ context: "ci-a", state: "success" }] },
    ],
    "statuses",
    "combined status",
  );
  assert.equal((merged.statuses as unknown[]).length, 2, "id-less items pass through untouched");
});
