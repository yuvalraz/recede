// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * artifact-fixtures — HAND-AUTHORED SYNTHETIC artifact CONTENTS (P2.4), NOT dumps
 * of real tool output. OPSEC: placeholder paths, invented counts, no real repo
 * data. These strings are the exact bytes the pure parsers (`parseJUnit`,
 * `parseCoverage`, `parseMutation`, `parseArtifact`) consume from an unzipped
 * `ArtifactFiles.files` map. Every expected value below is an INDEPENDENT
 * known-good literal (worked out by hand from the fixture), never recomputed by
 * the same algorithm the parser uses.
 */

import type { ArtifactFiles } from "../../scanner.ts";

// --- JUnit XML ------------------------------------------------------------

/** Single <testsuite>: tests=5, failures=1, errors=0, skipped=2. */
export const JUNIT_SINGLE =
  '<testsuite name="unit" tests="5" failures="1" errors="0" skipped="2" time="0.42">\n' +
  '  <testcase name="a"/>\n' +
  "</testsuite>\n";

/**
 * <testsuites> wrapper with TWO <testsuite> children. Summed by hand:
 *   tests = 3 + 4 = 7; failures = 1 + 0 = 1; errors = 0 + 1 = 1; skipped = 0 + 1 = 1.
 * Note the wrapper tag is `<testsuites` (plural) — the parser must NOT double-count
 * it as a suite.
 */
export const JUNIT_MULTI =
  '<testsuites name="all" tests="7" failures="1" errors="1" skipped="1">\n' +
  '  <testsuite name="alpha" tests="3" failures="1" errors="0" skipped="0"></testsuite>\n' +
  '  <testsuite name="beta" tests="4" failures="0" errors="1" skipped="1"></testsuite>\n' +
  "</testsuites>\n";

/** Malformed: no <testsuite> tag at all. */
export const JUNIT_MALFORMED = "<html><body>not junit</body></html>";

// --- Coverage -------------------------------------------------------------

/**
 * LCOV: two records. LF (lines found) = 10 + 10 = 20; LH (lines hit) = 8 + 7 = 15.
 * linesPct = 15 / 20 * 100 = 75.
 */
export const LCOV =
  "TN:\n" +
  "SF:src/a.ts\n" +
  "LF:10\n" +
  "LH:8\n" +
  "end_of_record\n" +
  "SF:src/b.ts\n" +
  "LF:10\n" +
  "LH:7\n" +
  "end_of_record\n";

/** coverage-summary JSON: total.lines.pct = 88. */
export const COVERAGE_SUMMARY_JSON = JSON.stringify({
  total: { lines: { total: 100, covered: 88, pct: 88 }, statements: { pct: 90 } },
});

/** Malformed coverage: no LF/LH and no total.lines.pct. */
export const COVERAGE_MALFORMED = "just some log text\nwith no coverage data\n";

/** LCOV with LF:0 (division-by-zero guard → null). */
export const LCOV_ZERO_LINES = "SF:src/empty.ts\nLF:0\nLH:0\nend_of_record\n";

// --- Mutation (Stryker) ---------------------------------------------------

/** Top-level mutationScore exactly AT the default threshold (60, on the 0–100 scale Stryker emits). */
export const STRYKER_AT = JSON.stringify({ mutationScore: 60 });

/** Top-level mutationScore JUST BELOW the default threshold (59). */
export const STRYKER_BELOW = JSON.stringify({ mutationScore: 59 });

/**
 * No top-level score → compute from files. Mutant statuses (worked by hand):
 *   detected  = Killed(2) + Timeout(1) = 3
 *   undetected= Survived(1) + NoCoverage(0) = 1
 *   valid = 4 → score = 3 / 4 * 100 = 75.
 */
export const STRYKER_FROM_FILES = JSON.stringify({
  files: {
    "src/a.ts": {
      mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }, { status: "Timeout" }],
    },
  },
});

/** Malformed mutation: not JSON. */
export const MUTATION_MALFORMED = "<xml>not stryker</xml>";

// --- ArtifactFiles bundles (parseArtifact dispatch inputs) ----------------

export const JUNIT_ARTIFACT: ArtifactFiles = {
  name: "test-results",
  files: { "report/junit.xml": JUNIT_SINGLE, "report/log.txt": "irrelevant" },
};

export const COVERAGE_ARTIFACT: ArtifactFiles = {
  name: "coverage",
  files: { "coverage/lcov.info": LCOV, "coverage/index.html": "<html>ignore</html>" },
};

export const MUTATION_ARTIFACT: ArtifactFiles = {
  name: "stryker",
  files: { "reports/mutation/mutation.json": STRYKER_AT, "reports/mutation/index.html": "<html>ignore</html>" },
};

/** No file the dispatch recognizes for the requested kind. */
export const EMPTY_ARTIFACT: ArtifactFiles = { name: "empty", files: { "readme.txt": "nothing here" } };
