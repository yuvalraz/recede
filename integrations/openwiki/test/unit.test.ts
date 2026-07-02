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
  emptySidecar,
  foldEvent,
  type WikiEvent,
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

// ---------------------------------------------------------------------------
// Task 1.3: event fold + sidecar
// ---------------------------------------------------------------------------

const T0 = "2026-07-02T00:00:00.000Z";
const T1 = "2026-07-02T00:01:00.000Z";
const T2 = "2026-07-02T00:02:00.000Z";
const T3 = "2026-07-02T00:03:00.000Z";

function runEvent(over: Partial<Extract<WikiEvent, { kind: "run" }>> = {}): WikiEvent {
  return {
    kind: "run",
    runId: "r1",
    gitHead: "aaa",
    gitHeadSource: "last-update",
    planSnapshot: null,
    pages: [
      { path: "openwiki/a.md", sources: ["src/parser.ts#parseAll"], contentDigest: "d1" },
      { path: "openwiki/b.md", sources: ["src/utils.ts"], contentDigest: "d2" },
      { path: "openwiki/c.md", sources: [], contentDigest: "d3" },
    ],
    removed: [],
    ...over,
  };
}

test("run event: new pages enter at epsilon/warning; removed pages pruned; cursor advances", () => {
  const s0 = emptySidecar("openwiki@test");
  const s1 = foldEvent(s0, runEvent(), "w1", T0);
  assert.equal(Object.keys(s1.pages).length, 3);
  const a = s1.pages["openwiki/a.md"];
  assert.equal(a.score, C.EPSILON);
  assert.equal(a.band, "warning");
  assert.equal(a.sealedBy, null);
  assert.equal(a.lastSample, null);
  assert.equal(a.gitHead, "aaa");
  assert.equal(a.lastWarrant, "w1");
  assert.equal(a.lastEventMs, Date.parse(T0));
  assert.equal(s1.gitHead, "aaa");
  assert.equal(s1.updated, T0);
  // second run: b removed, a untouched keeps its state, d added
  const run2 = runEvent({
    runId: "r2",
    gitHead: "bbb",
    pages: [{ path: "openwiki/d.md", sources: [], contentDigest: "d4" }],
    removed: ["openwiki/b.md"],
  });
  const s2 = foldEvent(s1, run2, "w2", T1);
  assert.equal(s2.pages["openwiki/b.md"], undefined);
  assert.equal(s2.pages["openwiki/a.md"].lastWarrant, "w1"); // untouched keeps state
  assert.equal(s2.pages["openwiki/a.md"].gitHead, "aaa");
  assert.equal(s2.pages["openwiki/d.md"].score, C.EPSILON);
  assert.equal(s2.gitHead, "bbb");
  // purity: prev objects never mutated
  assert.equal(s1.pages["openwiki/b.md"].path, "openwiki/b.md");
  assert.equal(s0.gitHead, "");
  assert.deepEqual(s0.pages, {});
});

test("decay event: pages whose sources intersect changedFiles drop multiplicatively; sourceless pages drop on ANY diff; all pages time-decay; cursor -> toHead", () => {
  const s1 = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0);
  const sealed = foldEvent(
    s1,
    { kind: "seal", runId: "r2", pages: ["openwiki/a.md", "openwiki/b.md", "openwiki/c.md"], human: "yuval" },
    "w2",
    T0, // same instant: elapsed 0 for the diff-decay assertions below
  );
  // Targeted diff at zero elapsed time: a (source file part matches) and c (sourceless) drop; b holds.
  const d1: WikiEvent = {
    kind: "decay", runId: "r3", fromHead: "aaa", toHead: "ccc",
    changedFiles: ["src/parser.ts"], nowMs: Date.parse(T0),
  };
  const s2 = foldEvent(sealed, d1, "w3", T1);
  assert.equal(s2.pages["openwiki/a.md"].score, diffDecay(sealRaise(C.EPSILON))); // 0.275 via #fragment file part
  assert.equal(s2.pages["openwiki/a.md"].band, "warning");
  assert.equal(s2.pages["openwiki/b.md"].score, sealRaise(C.EPSILON)); // untouched sources hold
  assert.equal(s2.pages["openwiki/b.md"].band, "ok");
  assert.equal(s2.pages["openwiki/c.md"].score, diffDecay(sealRaise(C.EPSILON))); // sourceless: conservative drop
  assert.equal(s2.gitHead, "ccc");
  for (const p of Object.values(s2.pages)) {
    assert.equal(p.lastEventMs, Date.parse(T0));
    assert.equal(p.lastWarrant, "w3");
  }
  // Pure time decay: empty diff, one half-life later — every page relaxes toward epsilon.
  const d2: WikiEvent = {
    kind: "decay", runId: "r4", fromHead: "ccc", toHead: "ddd",
    changedFiles: [], nowMs: Date.parse(T0) + C.TIME_HALF_LIFE_MS,
  };
  const s3 = foldEvent(s2, d2, "w4", T2);
  const b0 = sealRaise(C.EPSILON);
  assert.equal(s3.pages["openwiki/b.md"].score, C.EPSILON + (b0 - C.EPSILON) * 0.5);
  assert.equal(s3.pages["openwiki/c.md"].score, timeDecay(diffDecay(b0), C.TIME_HALF_LIFE_MS)); // no diff drop on empty changedFiles
  assert.equal(s3.gitHead, "ddd");
});

test("seal event: raises score, records sealedBy, clears lastSample, re-bands from score", () => {
  const s1 = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0);
  const sampled = foldEvent(
    s1,
    {
      kind: "sample", runId: "r2",
      results: [{ page: "openwiki/a.md", refsChecked: 2, refsBroken: 2, anyMissing: false, evidence: ["broken: src/parser.ts#parseAll"] }],
    },
    "w2",
    T1,
  );
  assert.equal(sampled.pages["openwiki/a.md"].band, "action"); // brokenRatio 1 > 0.2
  const s2 = foldEvent(sampled, { kind: "seal", runId: "r3", pages: ["openwiki/a.md"], human: "yuval" }, "w3", T2);
  const a = s2.pages["openwiki/a.md"];
  assert.equal(a.score, sealRaise(C.EPSILON)); // 0.55
  assert.equal(a.sealedBy, "yuval");
  assert.equal(a.lastSample, null);
  assert.equal(a.band, "ok"); // re-banded from score alone
  assert.equal(a.lastWarrant, "w3");
  assert.equal(a.lastEventMs, Date.parse(T2));
  assert.equal(s2.pages["openwiki/b.md"].lastWarrant, "w1"); // unnamed pages untouched
});

test("sample event: stores lastSample, band = max severity(scoreBand, sampleBand)", () => {
  const s1 = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0);
  const sealed = foldEvent(s1, { kind: "seal", runId: "r2", pages: ["openwiki/a.md", "openwiki/b.md"], human: "yuval" }, "w2", T1);
  const sm: WikiEvent = {
    kind: "sample", runId: "r3",
    results: [
      { page: "openwiki/a.md", refsChecked: 4, refsBroken: 1, anyMissing: false, evidence: ["broken: x"] }, // 0.25 > 0.2
      { page: "openwiki/b.md", refsChecked: 0, refsBroken: 0, anyMissing: false, evidence: [] },            // no refs: ratio 0
    ],
  };
  const s2 = foldEvent(sealed, sm, "w3", T2);
  const a = s2.pages["openwiki/a.md"];
  assert.deepEqual(a.lastSample, { brokenRatio: 0.25, anyMissing: false });
  assert.equal(a.band, "action");
  assert.equal(a.score, sealRaise(C.EPSILON)); // sampling never moves the score
  const b = s2.pages["openwiki/b.md"];
  assert.deepEqual(b.lastSample, { brokenRatio: 0, anyMissing: false });
  assert.equal(b.band, "ok"); // clean sample, ok score
  // mild breakage on an ok-score page: warning wins over ok
  const s3 = foldEvent(
    s2,
    { kind: "sample", runId: "r4", results: [{ page: "openwiki/b.md", refsChecked: 10, refsBroken: 1, anyMissing: false, evidence: [] }] },
    "w4",
    T3,
  );
  assert.equal(s3.pages["openwiki/b.md"].band, "warning");
});
