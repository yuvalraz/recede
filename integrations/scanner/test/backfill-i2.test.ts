// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.0 — I2 replay integrity (provable property 1) + revert honesty (property 3,
 * I4). After backfill, for EVERY lane `replay(actor, task, warrantsFor, policy)`
 * deep-equals the stored trust snapshot — under the v0.2 POOLED policy the fold
 * used (decision 6). And a detected revert reseals REVERTED and DEMOTES the lane
 * (trust does not only rise). A1 is exercised: the reverted lane is stored via a
 * full replay, never a double `update()`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureEvidenceSource, type FixtureSet } from "../scanner.ts";
import {
  FileLedger,
  replay,
  referencePolicyV02,
  type AnyRecord,
  type IntentRecord,
} from "../../../reference/ts/src/index.ts";
import { runBackfill } from "../backfill.ts";

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/merge-history/widget.json"), "utf8"),
) as FixtureSet;
const REPO = { owner: "acme", repo: "widget" } as const;

// The v0.2 policy the fold uses: ALL-EQUAL placeholder over the discovered
// classes (no authored magnitude). Passed explicitly so replay uses the same one.
const POLICY = referencePolicyV02({
  unit: { L1: 0.5 },
  lint: { L1: 0.5 },
  e2e: { L1: 0.5 },
  sast: { L1: 0.5 },
});

function lanesOf(ledger: FileLedger): { actor: string; task: string }[] {
  const seen = new Set<string>();
  const out: { actor: string; task: string }[] = [];
  for (const r of ledger.records() as AnyRecord[]) {
    if (r.kind !== "INTENT") continue;
    const i = r as IntentRecord;
    const key = `${i.actor} ${i.task_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ actor: i.actor, task: i.task_type });
  }
  return out;
}

test("I2: replay(...) deep-equals stored trust for every backfilled lane (v0.2 pooled)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-i2-"));
  const path = join(dir, "ledger.jsonl");
  const ledger = new FileLedger(path);
  await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, ledger, { policy: POLICY });

  const lanes = lanesOf(ledger);
  assert.ok(lanes.length >= 3, "fixture must produce multiple lanes");

  for (const lane of lanes) {
    const stored = ledger.getTrust(lane.actor, lane.task);
    assert.ok(stored, `lane (${lane.actor}, ${lane.task}) must have a stored snapshot`);
    const replayed = replay(lane.actor, lane.task, ledger.warrantsFor(lane.actor, lane.task), POLICY);
    // I2: incremental stored == pure replay, exactly, on tier/score/conf/n.
    assert.equal(stored!.tier, replayed.tier, `tier for (${lane.actor}, ${lane.task})`);
    assert.ok(Math.abs(stored!.score - replayed.score) < 1e-9, `score for (${lane.actor}, ${lane.task})`);
    assert.ok(
      Math.abs(stored!.confidence - replayed.confidence) < 1e-9,
      `confidence for (${lane.actor}, ${lane.task})`,
    );
    assert.equal(stored!.sample_count, replayed.sample_count, `n for (${lane.actor}, ${lane.task})`);
  }
});

test("revert demotes: the reverted lane drops below a clean lane (I4, trust does not only rise)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-i2b-"));
  const path = join(dir, "ledger.jsonl");
  const ledger = new FileLedger(path);
  const report = await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, ledger, { policy: POLICY });

  assert.equal(report.reverts, 1, "the fixture has exactly one detected revert");

  // (octo-dev, code.feature) is PR #2 "Add CSV export" — reverted by #3.
  const reverted = ledger.getTrust("octo-dev", "code.feature");
  assert.ok(reverted, "reverted lane must exist");
  assert.equal(reverted!.sample_count, 1);
  assert.equal(reverted!.tier, "T0", "a reverted lane is forced to the floor tier");

  // (dependabot[bot], code.fix) is three clean SUCCESS merges — trust rose.
  const clean = ledger.getTrust("dependabot[bot]", "code.fix");
  assert.ok(clean, "clean lane must exist");
  assert.equal(clean!.sample_count, 3, "three merges → non-zero sample_count");
  assert.ok(clean!.score > reverted!.score, "the reverted lane sits below the clean lane");
});

// ---- C1: a re-run on a non-empty ledger must fail loud, not silently double ----

test("runBackfill: a second run on a non-empty ledger fails loud (C1, no silent double)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-c1-"));
  const path = join(dir, "ledger.jsonl");
  await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, new FileLedger(path), { policy: POLICY });
  // A re-run on the SAME path (FileLedger replays it on construction) must throw,
  // not silently double records + sample_count.
  await assert.rejects(
    () => runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, new FileLedger(path), { policy: POLICY }),
    /non-empty|fresh/i,
  );
});

// ---- M1: the revert lane is verified by an INDEPENDENT demotion property ----

test("M1: report.revertedLanes exposes the demotion property (tier T0 + sample_count unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-m1-"));
  const path = join(dir, "ledger.jsonl");
  const ledger = new FileLedger(path);
  const report = await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, ledger, { policy: POLICY });

  assert.equal(report.revertedLanes.length, 1, "one revert lane exposed for independent verification");
  const rl = report.revertedLanes[0];
  assert.equal(rl.actor, "octo-dev");
  assert.equal(rl.task, "code.feature");

  const stored = ledger.getTrust(rl.actor, rl.task);
  assert.ok(stored, "revert lane must have a stored snapshot");
  // Independent property (NOT replay==stored, which is tautological for revert lanes
  // because stored IS replay()): the lane demoted to the floor AND its warrant count
  // is unchanged from the forward fold (the single warrant collapsed, not doubled).
  assert.equal(stored!.tier, "T0", "revert lane demoted to the floor tier");
  assert.equal(
    stored!.sample_count,
    rl.forwardSampleCount,
    "sample_count unchanged from the forward fold (single collapsed warrant)",
  );
});

// ---- L1: a merged PR with null mergedAt is surfaced as a dropped count -------

test("L1: a merged PR with null mergedAt is counted as dropped, not silently skipped", async () => {
  const dropSet = {
    "acme/widget": {
      pullRequests: [
        {
          number: 1,
          merged: true,
          mergeCommitSha: "1".repeat(40),
          headSha: "a".repeat(40),
          author: "octo-dev",
          mergedAt: "2026-04-01T00:00:00Z",
          title: "Add A",
          labels: [],
        },
        {
          number: 2,
          merged: true,
          mergeCommitSha: "2".repeat(40),
          headSha: "b".repeat(40),
          author: "octo-dev",
          mergedAt: null,
          title: "Merged but no date",
          labels: [],
        },
      ],
      reviews: {},
      workflowRuns: [],
      checkRuns: {},
      combinedStatus: {},
      branchProtection: {},
      deployments: [],
      attestations: {},
      files: {},
      securityAlerts: [],
      artifacts: {},
    },
  } as unknown as FixtureSet;

  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-l1-"));
  const path = join(dir, "ledger.jsonl");
  const report = await runBackfill(new FixtureEvidenceSource(dropSet), REPO, new FileLedger(path), {
    policy: POLICY,
  });
  assert.equal(report.reconstructed, 1, "only the dated merge is reconstructed");
  assert.equal(report.dropped, 1, "the null-mergedAt merge is counted, not silently dropped");
});
