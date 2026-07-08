// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.2 gotcha 1 — unionChecks UNIONS the combined commit status with the
 * check-runs list and DEDUPES on NAME match. A GitHub Action result IS itself a
 * check run, so a naive concat double-counts it; naive "check-runs only" drops a
 * legacy status that was never a check-run. Using the SHA_A fixture:
 *   - `build` appears in check-runs AND as a same-name combined-status context;
 *   - `legacy-ci` is a status context with no matching check-run.
 *
 * Namespace import so the not-yet-defined `unionChecks` is `undefined` during RED
 * and calling it throws behaviorally ("is not a function") — a real RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import { fixtureSet, REPO, SHA_A } from "./fixtures/fake-github.ts";

test("unionChecks: build appears once (check-run), legacy-ci once (status), no double-count, no dropped legacy", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const combined = await src.getCombinedStatus(REPO, SHA_A);
  const checkRuns = await src.listCheckRunsForRef(REPO, SHA_A);

  const surfaces = scanner.unionChecks(combined, checkRuns);

  // The `build` Action appears EXACTLY once, and as a check-run (not double-counted
  // via its same-name combined-status context).
  const build = surfaces.filter((s) => s.name === "build");
  assert.equal(build.length, 1, "build must appear exactly once");
  assert.equal(build[0].kind, "check-run", "build must be kept as the check-run, not the status");

  // The legacy `legacy-ci` status (no matching check-run) appears EXACTLY once, as a status.
  const legacy = surfaces.filter((s) => s.name === "legacy-ci");
  assert.equal(legacy.length, 1, "legacy-ci must appear exactly once");
  assert.equal(legacy[0].kind, "status", "legacy-ci is a legacy status, kept as kind status");

  // Total surfaces == distinct names: no double-count, no dropped legacy.
  const names = surfaces.map((s) => s.name);
  const distinct = new Set(names);
  assert.equal(surfaces.length, distinct.size, "one surface per distinct name");
  assert.deepEqual(
    [...distinct].sort(),
    ["build", "legacy-ci", "lint", "unit-tests"],
    "the union is {check-runs} ∪ {legacy statuses with no matching check-run}",
  );
});

test("unionChecks: deterministic order + inputs unchanged (copies before sort, non-mutating)", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const combined = await src.getCombinedStatus(REPO, SHA_A);
  const checkRuns = await src.listCheckRunsForRef(REPO, SHA_A);

  // Snapshot the input order BEFORE the call. The fixture returns the SAME array
  // reference on each call, so an in-place sort would corrupt it (and, via the
  // shared statuses array, corrupt SHA_B too — fake-github.ts:113).
  const checkNamesBefore = checkRuns.map((c) => c.name);
  const statusCtxBefore = combined.statuses.map((s) => s.context);

  const a = scanner.unionChecks(combined, checkRuns);
  const b = scanner.unionChecks(combined, checkRuns);
  assert.deepEqual(a, b, "same inputs → same output (deterministic)");

  // Output is in a stable, documented order (by name, then kind).
  const sorted = [...a].sort((x, y) => x.name.localeCompare(y.name) || x.kind.localeCompare(y.kind));
  assert.deepEqual(a, sorted, "output is deterministically ordered by (name, kind)");

  // Inputs are unchanged — unionChecks copied before sorting.
  assert.deepEqual(checkRuns.map((c) => c.name), checkNamesBefore, "checkRuns input not mutated");
  assert.deepEqual(combined.statuses.map((s) => s.context), statusCtxBefore, "combined.statuses not mutated");
});

test("unionChecks: non-ASCII/emoji names sort by CODE UNIT, deterministic + input-order-independent", () => {
  // localeCompare is locale/ICU-sensitive: it collates emoji BEFORE ASCII and
  // reorders case. The union must use a byte-stable CODE-UNIT comparison instead,
  // so a non-ASCII check name can never break byte-stability of the emitted map.
  const mk = (name: string): scanner.RawCheckRun => ({
    name,
    headSha: "f".repeat(40),
    conclusion: "success",
    status: "completed",
    detailsUrl: null,
    app: "github-actions",
  });
  const empty: scanner.RawCombinedStatus = { sha: "f".repeat(40), state: "success", statuses: [] };

  // Deterministic code-unit order: "Zebra" (U+005A) < "apple" (U+0061) < 🍎 (U+1F34E) < 🦊 (U+1F98A).
  // localeCompare would put the emoji FIRST and lowercase before uppercase — the wrong order.
  const CODE_UNIT_ORDER = ["Zebra", "apple", "🍎-check", "🦊-check"];

  const order1 = scanner.unionChecks(empty, [mk("🦊-check"), mk("apple"), mk("🍎-check"), mk("Zebra")]);
  assert.deepEqual(order1.map((s) => s.name), CODE_UNIT_ORDER, "emoji/ASCII sorted by code unit, not locale");

  // Input-order-independent: a different feed order yields the SAME output order.
  const order2 = scanner.unionChecks(empty, [mk("Zebra"), mk("🍎-check"), mk("🦊-check"), mk("apple")]);
  assert.deepEqual(order2.map((s) => s.name), CODE_UNIT_ORDER, "same output regardless of input order");
  assert.deepEqual(order1, order2, "byte-identical across input orders");
});
