// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Unit tests for the OpenWiki adapter core (Phase 1): trust math + banding,
 * source-ref extraction, sidecar event fold, warrant sealing, and the
 * fold-vs-replay equality property. Pure seam — no mocks, real temp dirs only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRUST_CONSTANTS as C,
  sealRaise,
  diffDecay,
  timeDecay,
  bandFor,
  extractSources,
} from "../openwiki-adapter.ts";

// Fixture tree for extraction tests: real files, no mocks.
const tmpRoot = mkdtempSync(join(tmpdir(), "openwiki-adapter-test-"));
mkdirSync(join(tmpRoot, "src"), { recursive: true });
writeFileSync(join(tmpRoot, "src", "parser.ts"), "export function parseAll() {}\n");
writeFileSync(join(tmpRoot, "src", "utils.ts"), "export function helperFn() {}\n");

// ---------------------------------------------------------------------------
// Task 1.1: trust math + banding
// ---------------------------------------------------------------------------

test("epsilon page seals into ok territory", () => {
  assert.equal(sealRaise(C.EPSILON), C.EPSILON + C.SEAL_GAIN * (1 - C.EPSILON)); // 0.55
  assert.equal(bandFor(sealRaise(C.EPSILON)), "ok");
});

test("diff decay is multiplicative with a floor at epsilon", () => {
  assert.equal(diffDecay(0.55), 0.275);
  assert.equal(diffDecay(C.EPSILON), C.EPSILON); // never below the floor
});

test("time decay relaxes toward epsilon with a 30d half-life", () => {
  assert.equal(timeDecay(0.55, 0), 0.55);
  assert.equal(timeDecay(0.55, C.TIME_HALF_LIFE_MS), C.EPSILON + (0.55 - C.EPSILON) * 0.5);
  assert.equal(timeDecay(C.EPSILON, 1e15), C.EPSILON);
});

test("banding: score drives ok|warning; only samples reach action", () => {
  assert.equal(bandFor(C.EPSILON), "warning");           // fresh e-page: verify-against-sources grade
  assert.equal(bandFor(0.35), "ok");
  assert.equal(bandFor(0.9, { brokenRatio: 0, anyMissing: false }), "ok");     // clean sample never demotes
  assert.equal(bandFor(0.9, { brokenRatio: 0.2, anyMissing: false }), "warning"); // 20% boundary: warning
  assert.equal(bandFor(0.9, { brokenRatio: 0.21, anyMissing: false }), "action"); // 21%: action
  assert.equal(bandFor(0.9, { brokenRatio: 0, anyMissing: true }), "action");     // any cited file missing
});

// ---------------------------------------------------------------------------
// Task 1.2: source-ref extraction
// ---------------------------------------------------------------------------

test("extractSources keeps only tree-existing path-like tokens, preserves #symbol fragments", () => {
  const md = "See `src/parser.ts` and [utils](src/utils.ts#helperFn).\nGhost: src/gone.ts. Not-a-path: foo.bar sentence.";
  assert.deepEqual(extractSources(md, tmpRoot), ["src/parser.ts", "src/utils.ts#helperFn"]);
});

test("extractSources returns [] for prose without refs", () => {
  assert.deepEqual(extractSources("just words, no paths here", tmpRoot), []);
});

test("extractSources dedupes preserving order, rejects absolute paths and URLs", () => {
  const md = [
    "First `src/parser.ts`, again src/parser.ts.",
    "Absolute: /src/parser.ts must not count.",
    "URL: https://example.com/src/parser.ts must not count either.",
  ].join("\n");
  assert.deepEqual(extractSources(md, tmpRoot), ["src/parser.ts"]);
});
