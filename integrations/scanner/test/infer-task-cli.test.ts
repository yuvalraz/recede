// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.2 remediation — `recede-scout infer-task`: a thin CLI over the EXISTING
 * pure `inferTaskType` (backfill.ts), so the emitted record workflow routes
 * forward records through the SAME lane inference the backfill uses (lane
 * continuity, both directions). Prints `<taskType> <risk>` (or JSON).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../cli.ts");

function run(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("infer-task: a fix-shaped title lands on code.fix at its ratified default risk", () => {
  const r = run(["infer-task", "--title", "fix: crash on empty ledger"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "code.fix reversible.low");
});

test("infer-task: labels route the lane (docs label beats a feature-shaped title)", () => {
  const r = run(["infer-task", "--title", "Add telemetry", "--labels", "docs,ci"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "docs.write reversible.low");
});

test("infer-task: a migration title lands on the never_recede-risk lane", () => {
  const r = run(["infer-task", "--title", "Migrate users table to v2"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "code.migrate irreversible.critical");
});

test("infer-task: unknown falls back to code.feature @ reversible.low (decision 3)", () => {
  const r = run(["infer-task", "--title", "zzz qqq"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "code.feature reversible.low");
});

test("infer-task: --json prints the machine shape", () => {
  const r = run(["infer-task", "--title", "fix: crash", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { taskType: "code.fix", risk: "reversible.low" });
});

test("infer-task: missing --title fails loud", () => {
  const r = run(["infer-task", "--labels", "docs"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--title/);
});
