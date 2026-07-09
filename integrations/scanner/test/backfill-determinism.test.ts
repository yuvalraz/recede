// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.0 — determinism (provable property 2). Backfill over a FIXED fixture
 * snapshot yields a BYTE-IDENTICAL FileLedger across two independent runs: every
 * record ts is injected from history (mergedAt / revert date), content-addressed
 * ids are stable, and no `new Date()`/`Math.random` enters record or trust data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureEvidenceSource, type FixtureSet } from "../scanner.ts";
import { FileLedger } from "../../../reference/ts/src/index.ts";
import { runBackfill } from "../backfill.ts";

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/merge-history/widget.json"), "utf8"),
) as FixtureSet;
const REPO = { owner: "acme", repo: "widget" } as const;

test("runBackfill: two runs over the same fixture produce a byte-identical ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recede-backfill-det-"));
  const pathA = join(dir, "a.jsonl");
  const pathB = join(dir, "b.jsonl");

  const reportA = await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, new FileLedger(pathA));
  const reportB = await runBackfill(new FixtureEvidenceSource(FIXTURE), REPO, new FileLedger(pathB));

  const textA = readFileSync(pathA, "utf8");
  const textB = readFileSync(pathB, "utf8");
  assert.equal(textA, textB, "ledgers must be byte-identical across runs");

  // Sanity: the fixture actually exercised the engine (6 merges, 1 revert).
  assert.equal(reportA.reconstructed, 6);
  assert.equal(reportA.forwardSealed, 0);
  assert.equal(reportA.reverts, 1);
  assert.deepEqual(reportA, reportB);
});
