// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.4 — PURE artifact parsers. Three targeted parsers behind one dispatch:
 * `parseJUnit`, `parseCoverage`, `parseMutation`, `parseArtifact`. Every parser is
 * FAIL-SAFE: malformed/empty input returns `null`, NEVER throws. `mutationAdequate`
 * flips at `MUTATION_ADEQUATE_THRESHOLD` (boundary tested just-below + just-at).
 *
 * Namespace import so a not-yet-defined function is `undefined` during RED and
 * calling it throws behaviorally ("is not a function") — a real RED, not a
 * collection error. Expected values are independent hand-worked literals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import {
  JUNIT_SINGLE,
  JUNIT_MULTI,
  JUNIT_MALFORMED,
  LCOV,
  LCOV_ZERO_LINES,
  COVERAGE_SUMMARY_JSON,
  COVERAGE_MALFORMED,
  STRYKER_AT,
  STRYKER_BELOW,
  STRYKER_FROM_FILES,
  MUTATION_MALFORMED,
  JUNIT_ARTIFACT,
  COVERAGE_ARTIFACT,
  MUTATION_ARTIFACT,
  EMPTY_ARTIFACT,
} from "./fixtures/artifact-fixtures.ts";

// --- MUTATION_ADEQUATE_THRESHOLD constant ---------------------------------

test("MUTATION_ADEQUATE_THRESHOLD: a pinned declared-policy threshold on the 0–100 scale", () => {
  assert.equal(typeof scanner.MUTATION_ADEQUATE_THRESHOLD, "number");
  assert.ok(scanner.MUTATION_ADEQUATE_THRESHOLD >= 0 && scanner.MUTATION_ADEQUATE_THRESHOLD <= 100);
  assert.equal(scanner.MUTATION_ADEQUATE_THRESHOLD, 60, "pinned default (edit-me), 60% mutants killed");
});

// --- parseJUnit -----------------------------------------------------------

test("parseJUnit: single <testsuite> extracts the four attributes", () => {
  assert.deepEqual(scanner.parseJUnit(JUNIT_SINGLE), {
    tests: 5,
    failures: 1,
    errors: 0,
    skipped: 2,
  });
});

test("parseJUnit: <testsuites> wrapper SUMS across child <testsuite> (no double-count of the wrapper)", () => {
  assert.deepEqual(scanner.parseJUnit(JUNIT_MULTI), {
    tests: 7,
    failures: 1,
    errors: 1,
    skipped: 1,
  });
});

test("parseJUnit: malformed / empty → null (no throw)", () => {
  assert.equal(scanner.parseJUnit(JUNIT_MALFORMED), null);
  assert.equal(scanner.parseJUnit(""), null);
});

// --- parseCoverage --------------------------------------------------------

test("parseCoverage: LCOV sums LF/LH → linesPct", () => {
  assert.deepEqual(scanner.parseCoverage(LCOV), { linesPct: 75 });
});

test("parseCoverage: coverage-summary JSON reads total.lines.pct", () => {
  assert.deepEqual(scanner.parseCoverage(COVERAGE_SUMMARY_JSON), { linesPct: 88 });
});

test("parseCoverage: LF:0 (division-by-zero guard) → null", () => {
  assert.equal(scanner.parseCoverage(LCOV_ZERO_LINES), null);
});

test("parseCoverage: malformed / empty → null (no throw)", () => {
  assert.equal(scanner.parseCoverage(COVERAGE_MALFORMED), null);
  assert.equal(scanner.parseCoverage(""), null);
});

// --- parseMutation --------------------------------------------------------

test("parseMutation: top-level mutationScore AT threshold → adequate true (>= boundary)", () => {
  assert.deepEqual(scanner.parseMutation(STRYKER_AT), { mutationScore: 60, adequate: true });
});

test("parseMutation: top-level mutationScore JUST BELOW threshold → adequate false", () => {
  assert.deepEqual(scanner.parseMutation(STRYKER_BELOW), { mutationScore: 59, adequate: false });
});

test("parseMutation: compute score from files when no top-level score (3 detected / 4 valid = 75)", () => {
  assert.deepEqual(scanner.parseMutation(STRYKER_FROM_FILES), { mutationScore: 75, adequate: true });
});

test("parseMutation: malformed / empty → null (no throw)", () => {
  assert.equal(scanner.parseMutation(MUTATION_MALFORMED), null);
  assert.equal(scanner.parseMutation(""), null);
});

test("parseMutation (non-vacuous scale): adequacy gates on the REAL 0–100 percentage scale", () => {
  // A terrible suite: 4% mutation score. On the real Stryker 0–100 scale this is
  // nowhere near adequate. This is the assertion that catches a vacuous threshold:
  // under the old 0.6 threshold, 4.0 >= 0.6 wrongly read adequate:true.
  assert.deepEqual(scanner.parseMutation('{"mutationScore":4.0}'), { mutationScore: 4.0, adequate: false });
  // A strong suite: 85.3% → adequate.
  assert.deepEqual(scanner.parseMutation('{"mutationScore":85.3}'), { mutationScore: 85.3, adequate: true });
  // Computed-from-files with a low kill ratio: 1 killed / 25 valid = 4% → adequate:false.
  const survived = Array.from({ length: 24 }, () => ({ status: "Survived" }));
  const lowKill = JSON.stringify({ files: { "src/a.ts": { mutants: [{ status: "Killed" }, ...survived] } } });
  assert.deepEqual(scanner.parseMutation(lowKill), { mutationScore: 4, adequate: false });
});

// --- parseArtifact dispatch ----------------------------------------------

test("parseArtifact: junit dispatch picks the .xml file and maps to the artifact shape", () => {
  assert.deepEqual(scanner.parseArtifact("junit", JUNIT_ARTIFACT), {
    kind: "junit",
    testCount: 5,
    failures: 1,
  });
});

test("parseArtifact: coverage dispatch picks the lcov file → coveragePct", () => {
  assert.deepEqual(scanner.parseArtifact("coverage", COVERAGE_ARTIFACT), {
    kind: "coverage",
    coveragePct: 75,
  });
});

test("parseArtifact: mutation dispatch picks the mutation json → score + adequacy", () => {
  assert.deepEqual(scanner.parseArtifact("mutation", MUTATION_ARTIFACT), {
    kind: "mutation",
    mutationScore: 60,
    mutationAdequate: true,
  });
});

test("parseArtifact: no recognized file for the kind → null (fail-safe)", () => {
  assert.equal(scanner.parseArtifact("junit", EMPTY_ARTIFACT), null);
  assert.equal(scanner.parseArtifact("coverage", EMPTY_ARTIFACT), null);
  assert.equal(scanner.parseArtifact("mutation", EMPTY_ARTIFACT), null);
});
