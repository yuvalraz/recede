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
import { randomUUID } from "node:crypto";
import {
  TRUST_CONSTANTS as C,
  DOC_MAP_TASK,
  DOC_MAP_RISK,
  EVENT_PREFIX,
  sealRaise,
  diffDecay,
  timeDecay,
  bandFor,
  extractSources,
  emptySidecar,
  foldEvent,
  eventOf,
  foldWarrants,
  docPolicy,
  runChecks,
  decayChecks,
  sampleChecks,
  sealChecks,
  sealEventWarrant,
  FENCE_BEGIN,
  FENCE_END,
  overallBand,
  renderTrustMd,
  renderFenceBlock,
  spliceFence,
  renderTrustDelta,
  type Band,
  type PageState,
  type SampleResult,
  type Sidecar,
  type WikiEvent,
} from "../openwiki-adapter.ts";
import { MemoryLedger, coldStart, open, type Warrant } from "../../../reference/ts/src/index.ts";
import { MechanicalVerifier, samplePages, verifyPage, type ClaimVerifier } from "../sampler.ts";
import { mulberry32, planFileName } from "../cli.ts";

// Fixture tree for extraction tests: real files, no mocks.
const tmpRoot = mkdtempSync(join(tmpdir(), "openwiki-adapter-test-"));
mkdirSync(join(tmpRoot, "src"), { recursive: true });
writeFileSync(join(tmpRoot, "src", "parser.ts"), "export function parseAll() {}\n");
writeFileSync(join(tmpRoot, "src", "utils.ts"), "export function helperFn() {}\n");
writeFileSync(join(tmpRoot, "src", "a..b.ts"), "export const dotted = true;\n");

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

test("extractSources keeps hyphenated #fragments intact", () => {
  assert.deepEqual(extractSources("grep src/parser.ts#my-symbol", tmpRoot), ["src/parser.ts#my-symbol"]);
});

test("extractSources rejects '..' segments (tree escape; phantom refs silently under-decay)", () => {
  const inner = join(tmpRoot, "inner");
  mkdirSync(inner, { recursive: true });
  // Both resolve to tmpRoot/src/parser.ts — real files OUTSIDE the repo root.
  const md = "escape ../src/parser.ts and nested src/../../src/parser.ts";
  assert.deepEqual(extractSources(md, inner), []);
});

test("extractSources: #fragment never absorbs trailing sentence punctuation; interior '.'/'-' stay whole", () => {
  // Sentence-final '.' after a fragment is prose, not part of the symbol.
  assert.deepEqual(extractSources("see src/parser.ts#note. Next sentence.", tmpRoot), ["src/parser.ts#note"]);
  assert.deepEqual(extractSources("dangling src/parser.ts#sym- end", tmpRoot), ["src/parser.ts#sym"]);
  assert.deepEqual(extractSources("whole src/parser.ts#my-symbol here", tmpRoot), ["src/parser.ts#my-symbol"]);
});

test("extractSources rejects denormalized-but-equivalent refs ('.' and '' segments) that bypass decay matching", () => {
  // All three resolve to src/parser.ts on disk (join() normalizes) but are
  // kept verbatim and never match git's canonical paths in changedFiles —
  // the same silent-under-decay class as the '..' escape.
  const md = "See src/./parser.ts then ./src/parser.ts then src//parser.ts here.";
  assert.deepEqual(extractSources(md, tmpRoot), []);
  // Exact-segment semantics preserved: '..' INSIDE a filename is not a segment.
  assert.deepEqual(extractSources("kept: src/a..b.ts", tmpRoot), ["src/a..b.ts"]);
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

// ---------------------------------------------------------------------------
// Task 1.4: warrant sealing + ledger round-trip + the replay property
// ---------------------------------------------------------------------------

/** Deterministic injected clock (cc10x demo pattern). */
function makeClock(startIso = "2026-07-02T09:00:00.000Z"): () => string {
  let t = Date.parse(startIso);
  return () => new Date((t += 1000)).toISOString();
}

const cleanRunChecks = () =>
  runChecks({ childExit: 0, pageCount: 1, gitHeadSource: "last-update", planSnapshot: "captured" });

test("sealEventWarrant seals a doc.map warrant whose expected_effects[0] round-trips the event", async () => {
  const ledger = new MemoryLedger();
  const ev: WikiEvent = { kind: "run", runId: "r1", gitHead: "abc", gitHeadSource: "last-update",
    planSnapshot: "openwiki/.trust/plans/t0.md", pages: [{ path: "openwiki/a.md", sources: [], contentDigest: "d" }], removed: [] };
  const { warrant, after } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: ev, intent: "wiki run", checks: cleanRunChecks(), groundTruth: "openwiki-artifacts" });
  assert.deepEqual(eventOf(warrant), ev);
  assert.equal(warrant.outcome?.result, "SUCCESS");
  assert.equal(after.sample_count, 1);
  assert.equal(warrant.intent.task_type, DOC_MAP_TASK);
  assert.equal(warrant.intent.declared_risk, DOC_MAP_RISK);
});

test("plan-snapshot: absent seals SUCCESS with an INCONCLUSIVE check (honest gap, reduced signal)", async () => {
  const ledger = new MemoryLedger();
  const ev: WikiEvent = { kind: "run", runId: "r1", gitHead: "abc", gitHeadSource: "last-update",
    planSnapshot: null, pages: [{ path: "openwiki/a.md", sources: [], contentDigest: "d" }], removed: [] };
  const { warrant } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: ev, intent: "wiki run",
    checks: runChecks({ childExit: 0, pageCount: 1, gitHeadSource: "degraded-head", planSnapshot: "absent" }),
    groundTruth: "openwiki-artifacts" });
  assert.equal(warrant.outcome?.result, "SUCCESS"); // evidence gap is NOT failure
  const snap = warrant.checks.find((c) => c.method === "openwiki:plan-snapshot");
  assert.equal(snap?.verdict, "INCONCLUSIVE");
  assert.equal(snap?.confidence, 0);
  const head = warrant.checks.find((c) => c.method === "openwiki:githead-binding");
  assert.equal(head?.verdict, "INCONCLUSIVE"); // degraded head: same honest-gap rule
});

test("a sample with action-band findings seals FAILURE and costs lane trust", async () => {
  const ledger = new MemoryLedger();
  const runEv: WikiEvent = { kind: "run", runId: "r1", gitHead: "abc", gitHeadSource: "last-update",
    planSnapshot: null, pages: [{ path: "openwiki/a.md", sources: ["src/x.ts"], contentDigest: "d" }], removed: [] };
  await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: runEv, intent: "wiki run", checks: cleanRunChecks(), groundTruth: "openwiki-artifacts" });
  const results: SampleResult[] = [
    { page: "openwiki/a.md", refsChecked: 1, refsBroken: 1, anyMissing: true, evidence: ["missing: src/x.ts"] },
  ];
  const { warrant, before, after } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: { kind: "sample", runId: "r2", results }, intent: "wiki sample",
    checks: sampleChecks(results), groundTruth: "mechanical-sample" });
  assert.equal(warrant.outcome?.result, "FAILURE");
  assert.ok(before.score > 0, "lane must have trust to lose");
  assert.ok(after.score < before.score, "FAILURE must cost lane trust");
});

test("TrustState.updated is a string after a seal->update cycle (survives JSON round-trip)", async () => {
  // Gap-review advisory: passing the now FUNCTION to update() type-strips
  // silently and corrupts TrustState.updated on JSON serialization.
  const ledger = new MemoryLedger();
  const ev: WikiEvent = { kind: "run", runId: "r1", gitHead: "abc", gitHeadSource: "last-update",
    planSnapshot: null, pages: [{ path: "openwiki/a.md", sources: [], contentDigest: "d" }], removed: [] };
  const { after } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: ev, intent: "wiki run", checks: cleanRunChecks(), groundTruth: "openwiki-artifacts",
    now: makeClock() });
  assert.equal(typeof after.updated, "string");
  assert.ok(!Number.isNaN(Date.parse(after.updated as string)), "updated must be a parseable timestamp");
  const thawed = JSON.parse(JSON.stringify(after));
  assert.equal(thawed.updated, after.updated); // a function here would vanish on serialization
});

test("PROPERTY: foldWarrants over the ledger == incremental foldEvent chain (deep-equal INCLUDING updated)", async () => {
  const ledger = new MemoryLedger();
  const now = makeClock();
  const gen = "openwiki@test";
  const nowMs = Date.parse("2026-07-02T10:00:00.000Z");
  const results: SampleResult[] = [
    { page: "openwiki/b.md", refsChecked: 2, refsBroken: 0, anyMissing: false, evidence: [] },
  ];
  const events: WikiEvent[] = [
    { kind: "run", runId: "p1", gitHead: "h1", gitHeadSource: "last-update", planSnapshot: null,
      pages: [
        { path: "openwiki/a.md", sources: ["src/parser.ts"], contentDigest: "d1" },
        { path: "openwiki/b.md", sources: ["src/utils.ts"], contentDigest: "d2" },
        { path: "openwiki/c.md", sources: [], contentDigest: "d3" },
      ], removed: [] },
    { kind: "decay", runId: "p2", fromHead: "h1", toHead: "h2", changedFiles: ["src/parser.ts"], nowMs },
    { kind: "seal", runId: "p3", pages: ["openwiki/a.md"], human: "yuval" },
    { kind: "sample", runId: "p4", results },
  ];
  const checksFor = (ev: WikiEvent) =>
    ev.kind === "run" ? cleanRunChecks()
      : ev.kind === "decay" ? decayChecks({ changedFiles: 1, affectedPages: 2 })
      : ev.kind === "seal" ? sealChecks("yuval")
      : sampleChecks(ev.results);
  let incremental = emptySidecar(gen);
  for (const ev of events) {
    const { warrant } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: gen,
      event: ev, intent: `wiki ${ev.kind}`, checks: checksFor(ev), groundTruth: "test",
      humanTouched: ev.kind === "seal", now });
    // Round-trip through EVENT_PREFIX + JSON.stringify / eventOf before
    // folding: serialization artifacts (e.g. NaN -> null) must surface here.
    const recovered = eventOf(warrant);
    assert.ok(recovered, "event must round-trip through expected_effects[0]");
    incremental = foldEvent(incremental, recovered, warrant.intent.id, warrant.intent.ts);
  }
  const replayed = foldWarrants(gen, ledger.warrantsFor(gen, DOC_MAP_TASK));
  assert.deepEqual(replayed, incremental);
  // Byte-identical, exceeding the design's "equal except timestamps" floor:
  assert.equal(JSON.stringify(replayed, null, 2), JSON.stringify(incremental, null, 2));
});

test("PROPERTY: scores stay within [EPSILON, 1] across arbitrary event sequences", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
  let s = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w0", T0);
  let ms = Date.parse(T0);
  for (let i = 0; i < 50; i++) {
    ms += Math.floor(rnd() * C.TIME_HALF_LIFE_MS);
    const paths = Object.keys(s.pages);
    const path = paths[Math.floor(rnd() * paths.length)];
    const pick = rnd();
    let ev: WikiEvent;
    if (pick < 0.3) {
      ev = { kind: "seal", runId: `s${i}`, pages: [path], human: "h" };
    } else if (pick < 0.6) {
      ev = { kind: "decay", runId: `d${i}`, fromHead: "x", toHead: "y",
        changedFiles: rnd() < 0.5 ? ["src/parser.ts"] : [], nowMs: ms };
    } else if (pick < 0.8) {
      ev = { kind: "sample", runId: `m${i}`,
        results: [{ page: path, refsChecked: 3, refsBroken: Math.floor(rnd() * 4), anyMissing: rnd() < 0.3, evidence: [] }] };
    } else {
      ev = runEvent({ runId: `r${i}`, gitHead: `h${i}` });
    }
    s = foldEvent(s, ev, `w${i}`, new Date(ms).toISOString());
    for (const p of Object.values(s.pages)) {
      assert.ok(p.score >= C.EPSILON && p.score <= 1, `score ${p.score} out of [EPSILON, 1] at event ${i}`);
    }
  }
});

test("foldWarrants skips dangling outcome-less intents but still folds FAILURE-sealed warrants", async () => {
  const ledger = new MemoryLedger();
  const gen = "openwiki@test";
  const { warrant: runW } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: gen,
    event: runEvent(), intent: "wiki run", checks: cleanRunChecks(), groundTruth: "t" });
  // A seal whose process crashed between the intent append and the outcome
  // append: the intent line exists, the event never happened incrementally.
  const danglingSeal: WikiEvent = { kind: "seal", runId: "r9", pages: ["openwiki/a.md"], human: "yuval" };
  const danglingIntent = open({ actor: gen, task_type: DOC_MAP_TASK, proposed_action: "wiki seal",
    declared_risk: DOC_MAP_RISK, expected_effects: [EVENT_PREFIX + JSON.stringify(danglingSeal)], ts: T1 });
  const dangling: Warrant = { intent: danglingIntent, checks: [], checkpoints: [] };
  const replayed = foldWarrants(gen, [runW, dangling]);
  assert.equal(replayed.pages["openwiki/a.md"].score, C.EPSILON); // 0.25: the dangling seal never happened
  // FAILURE-sealed warrants DO fold — a failed sample's findings are real evidence.
  const results: SampleResult[] = [
    { page: "openwiki/a.md", refsChecked: 1, refsBroken: 1, anyMissing: true, evidence: ["missing: src/parser.ts"] },
  ];
  const { warrant: failW } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: gen,
    event: { kind: "sample", runId: "r10", results }, intent: "wiki sample",
    checks: sampleChecks(results), groundTruth: "t" });
  assert.equal(failW.outcome?.result, "FAILURE");
  const withFail = foldWarrants(gen, [runW, failW]);
  assert.equal(withFail.pages["openwiki/a.md"].band, "action");
});

test("foldWarrants dedups duplicated ledger lines by intent id (no double-fold)", async () => {
  const ledger = new MemoryLedger();
  const gen = "openwiki@test";
  const { warrant: runW } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: gen,
    event: runEvent(), intent: "wiki run", checks: cleanRunChecks(), groundTruth: "t" });
  const { warrant: sealW } = await sealEventWarrant({ ledger, policy: docPolicy(), generator: gen,
    event: { kind: "seal", runId: "r2", pages: ["openwiki/a.md"], human: "yuval" }, intent: "wiki seal",
    checks: sealChecks("yuval"), groundTruth: "human-seal", humanTouched: true });
  const replayed = foldWarrants(gen, [runW, sealW, sealW]); // duplicated line
  assert.equal(replayed.pages["openwiki/a.md"].score, sealRaise(C.EPSILON)); // 0.55 once, not 0.73 twice
});

test("sealEventWarrant rejects a decay event with non-finite nowMs before it reaches the ledger", async () => {
  const ledger = new MemoryLedger();
  const mk = (nowMs: number): WikiEvent => ({
    kind: "decay", runId: "r1", fromHead: "a", toHead: "b", changedFiles: [], nowMs,
  });
  for (const bad of [Number.NaN, Infinity, -Infinity, undefined as unknown as number]) {
    await assert.rejects(
      sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
        event: mk(bad), intent: "wiki decay",
        checks: decayChecks({ changedFiles: 0, affectedPages: 0 }), groundTruth: "git-diff" }),
      /nowMs must be finite/,
    );
  }
  // The guard fires BEFORE the intent append: nothing corrupt ever hits the ledger.
  assert.equal(ledger.warrantsFor("openwiki@test", DOC_MAP_TASK).length, 0);
});

test("sealEventWarrant rejects sample results with non-finite or inconsistent counts before they reach the ledger", async () => {
  const ledger = new MemoryLedger();
  // NaN is incomparable (NaN > 0.2 === false): an unguarded NaN refsBroken
  // seals SUCCESS, serializes to null, and replays as a CLEAN sample.
  const cases: [number, number][] = [
    [1, Number.NaN], [1, Infinity], [Number.NaN, 0], [1, -1], [-1, 0], [1, 2],
  ];
  for (const [refsChecked, refsBroken] of cases) {
    const results: SampleResult[] = [
      { page: "openwiki/a.md", refsChecked, refsBroken, anyMissing: false, evidence: [] },
    ];
    await assert.rejects(
      sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
        event: { kind: "sample", runId: "r1", results }, intent: "wiki sample",
        checks: sampleChecks(results), groundTruth: "mechanical-sample" }),
      /sample event r1: .*invalid counts/,
    );
  }
  // The guard fires BEFORE the intent append: nothing corrupt ever hits the ledger.
  assert.equal(ledger.warrantsFor("openwiki@test", DOC_MAP_TASK).length, 0);
});

test("foldEvent guards the decay nowMs FIELD: null, missing, and numeric-string corrupt-ledger shapes all throw", () => {
  const s1 = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0);
  // Hand-built ledger JSON (stringify can never produce the string shape;
  // null is what NaN/±Infinity serialize to; a missing key is what an
  // undefined-valued key becomes). A derived-elapsed guard misses ALL of
  // these: `null - number` and `"123" - number` coerce to finite values.
  const corrupt = [
    '{"kind":"decay","runId":"rY","fromHead":"aaa","toHead":"bbb","changedFiles":[],"nowMs":null}',
    '{"kind":"decay","runId":"rZ","fromHead":"aaa","toHead":"bbb","changedFiles":[]}',
    '{"kind":"decay","runId":"rW","fromHead":"aaa","toHead":"bbb","changedFiles":[],"nowMs":"123"}',
  ];
  for (const line of corrupt) {
    assert.throws(
      () => foldEvent(s1, JSON.parse(line) as WikiEvent, "wBad", T1),
      /non-finite decay nowMs in warrant wBad/,
    );
  }
  const nan: WikiEvent = { kind: "decay", runId: "rX", fromHead: "aaa", toHead: "bbb",
    changedFiles: [], nowMs: Number.NaN };
  assert.throws(() => foldEvent(s1, nan, "wBad2", T1), /non-finite decay nowMs in warrant wBad2/);
});

test("foldEvent throws on a corrupt intent ts, naming the CURRENT warrant (not the next decay's)", () => {
  // Unguarded, a corrupt ts writes NaN into lastEventMs silently and only
  // surfaces at the NEXT decay fold — blaming the wrong warrant.
  assert.throws(
    () => foldEvent(emptySidecar("openwiki@test"), runEvent(), "wTs", "not-a-timestamp"),
    /non-finite intent ts in warrant wTs/,
  );
});

test("negative decay dt (clock skew) never raises a score", () => {
  const s1 = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0);
  const sealed = foldEvent(s1, { kind: "seal", runId: "r2", pages: ["openwiki/a.md"], human: "yuval" }, "w2", T1);
  const skew: WikiEvent = { kind: "decay", runId: "r3", fromHead: "aaa", toHead: "bbb",
    changedFiles: [], nowMs: Date.parse(T1) - C.TIME_HALF_LIFE_MS }; // clock went backwards
  const s2 = foldEvent(sealed, skew, "w3", T2);
  assert.equal(s2.pages["openwiki/a.md"].score, sealRaise(C.EPSILON)); // 0.55 stays 0.55 — no unearned rise
});

test("eventOf throws naming the warrant id on a malformed payload", () => {
  const intent = open({ actor: "openwiki@test", task_type: DOC_MAP_TASK, proposed_action: "x",
    declared_risk: DOC_MAP_RISK, expected_effects: [EVENT_PREFIX + "{not json"], ts: T0 });
  const w: Warrant = { intent, checks: [], checkpoints: [] };
  assert.throws(() => eventOf(w), new RegExp(intent.id));
});

test("eventOf returns undefined for non-openwiki warrants", () => {
  const intent = open({ actor: "someone@else", task_type: "other.task", proposed_action: "x",
    declared_risk: "read.only", ts: T0 });
  assert.equal(eventOf({ intent, checks: [], checkpoints: [] }), undefined);
});

test("distinct events yield distinct warrant ids (runId uniqueness)", async () => {
  const ledger = new MemoryLedger();
  const frozen = () => "2026-07-02T09:00:00.000Z"; // identical clock: only runId differs
  const mk = (runId: string): WikiEvent => ({ kind: "run", runId, gitHead: "abc",
    gitHeadSource: "last-update", planSnapshot: null,
    pages: [{ path: "openwiki/a.md", sources: [], contentDigest: "d" }], removed: [] });
  const one = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: mk(randomUUID()), intent: "wiki run", checks: cleanRunChecks(), groundTruth: "t", now: frozen });
  const two = await sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
    event: mk(randomUUID()), intent: "wiki run", checks: cleanRunChecks(), groundTruth: "t", now: frozen });
  assert.notEqual(one.warrant.intent.id, two.warrant.intent.id);
});

// ---------------------------------------------------------------------------
// Task 2.1: mechanical sampler (Phase 2)
// ---------------------------------------------------------------------------

/** Minimal PageState fixture for sampler tests (fold-produced shapes in real use). */
function pageState(over: Partial<PageState> & { path: string }): PageState {
  return {
    sources: [], gitHead: "aaa", contentDigest: "d", score: C.EPSILON,
    band: "warning", lastWarrant: "w0", sealedBy: null, lastSample: null,
    lastEventMs: 0, ...over,
  };
}

function sidecarWith(pages: PageState[]): Sidecar {
  const sc = emptySidecar("openwiki@test");
  for (const p of pages) sc.pages[p.path] = p;
  return sc;
}

test("MechanicalVerifier: bare path ref checks existence; #symbol ref greps the file", async () => {
  const v = new MechanicalVerifier(tmpRoot);
  assert.equal((await v.verify("openwiki/a.md", "src/parser.ts")).ok, true);
  const missing = await v.verify("openwiki/a.md", "src/gone.ts");
  assert.equal(missing.ok, false);
  assert.equal(missing.evidence, "missing: src/gone.ts");
  assert.equal((await v.verify("openwiki/a.md", "src/parser.ts#parseAll")).ok, true);
  const broken = await v.verify("openwiki/a.md", "src/parser.ts#ghostSymbol");
  assert.equal(broken.ok, false);
  assert.match(broken.evidence, /ghostSymbol/);
  // Symbol fragment on a MISSING file: the missing file wins, evidence names the file part.
  const missSym = await v.verify("openwiki/a.md", "src/gone.ts#anything");
  assert.equal(missSym.ok, false);
  assert.equal(missSym.evidence, "missing: src/gone.ts");
});

test("verifyPage aggregates refs; banding boundaries from aggregates: 0% ok, 20% warning, >20% action, missing file action", async () => {
  const bandOf = (r: { refsChecked: number; refsBroken: number; anyMissing: boolean }) =>
    bandFor(1, { brokenRatio: r.refsChecked ? r.refsBroken / r.refsChecked : 0, anyMissing: r.anyMissing });
  // 0% broken: clean page.
  const clean = await verifyPage(tmpRoot, pageState({ path: "openwiki/clean.md",
    sources: ["src/parser.ts", "src/utils.ts#helperFn"] }));
  assert.equal(clean.page, "openwiki/clean.md");
  assert.equal(clean.refsChecked, 2);
  assert.equal(clean.refsBroken, 0);
  assert.equal(clean.anyMissing, false);
  assert.equal(clean.evidence.length, 2);
  assert.equal(bandOf(clean), "ok");
  // Exactly 20% broken (1/5, ghost symbol on an existing file): warning, not action.
  const fifth = await verifyPage(tmpRoot, pageState({ path: "openwiki/fifth.md",
    sources: ["src/parser.ts", "src/utils.ts", "src/parser.ts#parseAll", "src/utils.ts#helperFn", "src/parser.ts#ghost"] }));
  assert.equal(fifth.refsChecked, 5);
  assert.equal(fifth.refsBroken, 1);
  assert.equal(fifth.anyMissing, false);
  assert.equal(bandOf(fifth), "warning");
  // >20% broken (1/4): action.
  const quarter = await verifyPage(tmpRoot, pageState({ path: "openwiki/quarter.md",
    sources: ["src/parser.ts", "src/utils.ts", "src/utils.ts#helperFn", "src/parser.ts#ghost"] }));
  assert.equal(quarter.refsBroken, 1);
  assert.equal(bandOf(quarter), "action");
  // Missing cited FILE at ratio 0.2: the missing flag alone reaches action.
  const missing = await verifyPage(tmpRoot, pageState({ path: "openwiki/missing.md",
    sources: ["src/gone.ts", "src/parser.ts", "src/utils.ts", "src/parser.ts#parseAll", "src/utils.ts#helperFn"] }));
  assert.equal(missing.refsChecked, 5);
  assert.equal(missing.refsBroken, 1);
  assert.equal(missing.anyMissing, true);
  assert.equal(bandOf(missing), "action");
  assert.match(missing.evidence.join("\n"), /missing: src\/gone\.ts/);
  // Sourceless page: zero refs, clean result, ratio guard avoids 0/0.
  const none = await verifyPage(tmpRoot, pageState({ path: "openwiki/none.md", sources: [] }));
  assert.deepEqual(none, { page: "openwiki/none.md", refsChecked: 0, refsBroken: 0, anyMissing: false, evidence: [] });
});

test("verifyPage accepts a custom ClaimVerifier (stub) — the pluggable seam", async () => {
  const calls: string[] = [];
  const stub: ClaimVerifier = {
    verify(pagePath, ref) {
      calls.push(`${pagePath}:${ref}`);
      return Promise.resolve({ ok: ref.endsWith("#helperFn"), evidence: `stub: ${ref}` });
    },
  };
  const res = await verifyPage(tmpRoot, pageState({ path: "openwiki/a.md",
    sources: ["src/parser.ts", "src/utils.ts#helperFn"] }), stub);
  assert.equal(res.refsBroken, 1); // the stub's verdicts, not the mechanical ones
  assert.deepEqual(res.evidence, ["stub: src/parser.ts", "stub: src/utils.ts#helperFn"]);
  assert.deepEqual(calls, ["openwiki/a.md:src/parser.ts", "openwiki/a.md:src/utils.ts#helperFn"]);
  // anyMissing stays MECHANICAL (file-part existence at HEAD) even under a custom verifier:
  // the seam upgrades claim verification, never the missing-file ground truth.
  const res2 = await verifyPage(tmpRoot, pageState({ path: "openwiki/a.md", sources: ["src/gone.ts"] }),
    { verify: () => ({ ok: true, evidence: "stub says fine" }) });
  assert.equal(res2.anyMissing, true);
  assert.equal(res2.refsBroken, 0);
});

test("samplePages weights by staleness and is deterministic under an injected rand", () => {
  const nowMs = Date.parse(T3);
  const sc = sidecarWith([
    pageState({ path: "openwiki/stale.md", lastEventMs: nowMs - 999 }), // weight 1000
    pageState({ path: "openwiki/fresh.md", lastEventMs: nowMs }),       // weight 1
    pageState({ path: "openwiki/mid.md", lastEventMs: nowMs - 99 }),    // weight 100
  ]);
  // With rand 0.5 the stalest page holds a majority of the total weight -> always drawn first.
  const picks = samplePages(sc, 2, nowMs, () => 0.5);
  assert.deepEqual(picks, ["openwiki/stale.md", "openwiki/mid.md"]);
  // Deterministic: identical rand sequence, identical draw.
  assert.deepEqual(samplePages(sc, 2, nowMs, () => 0.5), picks);
  // Full draw is a permutation: every page exactly once.
  const all = samplePages(sc, 3, nowMs, () => 0.5);
  assert.deepEqual([...all].sort(), ["openwiki/fresh.md", "openwiki/mid.md", "openwiki/stale.md"]);
  // Clock skew (lastEventMs in the future) must not produce negative weights:
  // sampling stays a total function, no duplicate/undefined picks.
  const skewed = sidecarWith([
    ...Object.values(sc.pages),
    pageState({ path: "openwiki/future.md", lastEventMs: nowMs + 1e6 }),
  ]);
  const four = samplePages(skewed, 4, nowMs, () => 0.5);
  assert.equal(new Set(four).size, 4);
});

test("samplePages caps at page count and returns [] for an empty sidecar", () => {
  const nowMs = Date.parse(T0);
  assert.deepEqual(samplePages(emptySidecar("openwiki@test"), 3, nowMs), []);
  const sc = sidecarWith([
    pageState({ path: "openwiki/a.md", lastEventMs: nowMs - 10 }),
    pageState({ path: "openwiki/b.md", lastEventMs: nowMs - 20 }),
  ]);
  const picks = samplePages(sc, 10, nowMs, () => 0.1);
  assert.equal(picks.length, 2); // capped at page count
  assert.equal(new Set(picks).size, 2); // without replacement
  assert.deepEqual(samplePages(sc, 0, nowMs, () => 0.1), []);
});

// ---------------------------------------------------------------------------
// Task 2.2: renderers + fence splice (Phase 2)
// ---------------------------------------------------------------------------

// Fold-produced fixtures: real shapes, one per overall band.
const scWarning = foldEvent(emptySidecar("openwiki@test"), runEvent(), "w1", T0); // all pages at epsilon
const scOk = foldEvent(
  scWarning,
  { kind: "seal", runId: "r2", pages: ["openwiki/a.md", "openwiki/b.md", "openwiki/c.md"], human: "yuval" },
  "w2",
  T1,
);
const scAction = foldEvent(
  scOk,
  {
    kind: "sample", runId: "r3",
    results: [{ page: "openwiki/b.md", refsChecked: 1, refsBroken: 1, anyMissing: true, evidence: ["missing: src/utils.ts"] }],
  },
  "w3",
  T2,
);

test("overallBand: worst band present; ok when no pages", () => {
  assert.equal(overallBand(emptySidecar("openwiki@test")), "ok");
  assert.equal(overallBand(scWarning), "warning");
  assert.equal(overallBand(scOk), "ok");
  assert.equal(overallBand(scAction), "action");
});

test("renderTrustMd: one row per page (path, score, band, sealedBy, head) + band legend", () => {
  const md = renderTrustMd(scOk);
  const rows = md.split("\n").filter((l) => l.startsWith("| openwiki/"));
  assert.equal(rows.length, 3);
  const aRow = rows.find((r) => r.includes("openwiki/a.md"));
  assert.ok(aRow, "row for openwiki/a.md");
  assert.match(aRow, /0\.550/);
  assert.match(aRow, /\bok\b/);
  assert.match(aRow, /yuval/);
  assert.match(aRow, /aaa/); // head
  // Legend names all three bands.
  assert.match(md, /\*\*ok\*\*/);
  assert.match(md, /\*\*warning\*\*/);
  assert.match(md, /\*\*action\*\*/);
  // Unsealed pages render without a fabricated sealer.
  const freshRow = renderTrustMd(scWarning).split("\n").find((l) => l.startsWith("| openwiki/a.md"));
  assert.ok(freshRow && !freshRow.includes("yuval"));
});

test("fence block language downgrades by overall band (ok/warning/action variants)", () => {
  for (const sc of [scOk, scWarning, scAction]) {
    const block = renderFenceBlock(sc);
    assert.ok(block.startsWith(FENCE_BEGIN), "block includes the begin marker");
    assert.ok(block.endsWith(FENCE_END), "block includes the end marker");
  }
  assert.match(renderFenceBlock(scOk),
    /Wiki trust is healthy\. Consult the wiki and `TRUST\.md` for per-page standing\./);
  const warning = renderFenceBlock(scWarning);
  assert.match(warning,
    /Some wiki pages have degraded trust\. Verify flagged pages \(see `TRUST\.md`\) against their cited sources before relying on them\./);
  assert.match(warning, /- openwiki\/a\.md \(warning, 0\.250\)/); // non-ok pages listed
  const action = renderFenceBlock(scAction);
  assert.match(action,
    /Do NOT treat this wiki as ground truth\. Pages listed in `TRUST\.md` failed mechanical re-verification or decayed to floor; consult the source files directly\./);
  assert.match(action, /- openwiki\/b\.md \(action, 0\.550\)/);
  assert.ok(!action.includes("- openwiki/a.md"), "ok pages stay off the flagged list");
  // Empty wiki: healthy variant.
  assert.match(renderFenceBlock(emptySidecar("openwiki@test")), /Wiki trust is healthy/);
});

test("spliceFence replaces ONLY between markers; bytes outside are untouched", () => {
  const prefix = "# Agents\n\nintro text the wrap must never touch\n\n";
  const suffix = "\n\ntrailing text, also untouchable\n";
  const existing = prefix + FENCE_BEGIN + "\nstale body\n" + FENCE_END + suffix;
  const block = renderFenceBlock(scWarning);
  const out = spliceFence(existing, block);
  assert.equal(out, prefix + block + suffix);
});

test("spliceFence is idempotent: splice(splice(x, b), b) === splice(x, b)", () => {
  const existing = "before\n" + FENCE_BEGIN + "\nold\n" + FENCE_END + "\nafter\n";
  const block = renderFenceBlock(scAction);
  const once = spliceFence(existing, block);
  assert.ok(once);
  assert.equal(spliceFence(once, block), once);
});

test("spliceFence returns null when no fence exists", () => {
  assert.equal(spliceFence("# Agents\n\nno fence anywhere\n", renderFenceBlock(scOk)), null);
});

test("spliceFence throws on corrupt markers (begin-only, end-only, end-before-begin, duplicates)", () => {
  const block = renderFenceBlock(scOk);
  const corrupt = [
    `x\n${FENCE_BEGIN}\nno end marker`,
    `no begin marker\n${FENCE_END}\ny`,
    `${FENCE_END}\nbody\n${FENCE_BEGIN}`,
    `${FENCE_BEGIN}\n${FENCE_BEGIN}\nbody\n${FENCE_END}`,
    `${FENCE_BEGIN}\nbody\n${FENCE_END}\n${FENCE_END}`,
  ];
  for (const existing of corrupt) {
    assert.throws(() => spliceFence(existing, block), /corrupt openwiki-trust fence markers/);
  }
});

test("renderTrustDelta lists score/band transitions, added and removed pages; unchanged pages omitted", () => {
  const delta = renderTrustDelta(scWarning, scOk);
  assert.match(delta, /openwiki\/a\.md: 0\.250 -> 0\.550 \(warning -> ok\)/);
  // Band-only change (score untouched by a sample) still listed.
  const sampleDelta = renderTrustDelta(scOk, scAction);
  assert.match(sampleDelta, /openwiki\/b\.md: 0\.550 -> 0\.550 \(ok -> action\)/);
  assert.ok(!sampleDelta.includes("openwiki/a.md"), "unchanged pages omitted");
  // Added + removed pages.
  const run2 = foldEvent(
    scOk,
    { kind: "run", runId: "r9", gitHead: "bbb", gitHeadSource: "last-update", planSnapshot: null,
      pages: [{ path: "openwiki/d.md", sources: [], contentDigest: "d4" }], removed: ["openwiki/b.md"] },
    "w9",
    T3,
  );
  const runDelta = renderTrustDelta(scOk, run2);
  assert.match(runDelta, /openwiki\/d\.md: added at 0\.250 \(warning\)/);
  assert.match(runDelta, /openwiki\/b\.md: removed/);
  // Identical states: an explicit no-change line, not an empty string.
  assert.equal(renderTrustDelta(scOk, scOk), "No wiki trust changes.\n");
});

// ---------------------------------------------------------------------------
// Phase-2 remediation: adversarial hunter/reviewer findings
// ---------------------------------------------------------------------------

test("CR-1: zero-ref sample check is INCONCLUSIVE conf 0 — SUCCESS seal, but less lane signal than a verified-clean sample", async () => {
  // Measured bug: {refsChecked:0} passed at PASS@1, inflating the lane
  // 0.000 -> 0.472 over 5 events with nothing examined.
  const zeroRef: SampleResult[] = [
    { page: "openwiki/none.md", refsChecked: 0, refsBroken: 0, anyMissing: false, evidence: [] },
  ];
  const zeroLedger = new MemoryLedger();
  const zeroBefore = coldStart("openwiki@test", DOC_MAP_TASK);
  const { warrant: zeroW, after: zeroAfter } = await sealEventWarrant({
    ledger: zeroLedger, policy: docPolicy(), generator: "openwiki@test",
    event: { kind: "sample", runId: "r1", results: zeroRef }, intent: "wiki sample",
    checks: sampleChecks(zeroRef), groundTruth: "mechanical-sample" });
  assert.equal(zeroW.outcome?.result, "SUCCESS"); // evidence gap is NOT failure
  assert.equal(zeroW.checks[0]?.verdict, "INCONCLUSIVE");
  assert.equal(zeroW.checks[0]?.confidence, 0);
  // The corrected posture claim (doc note): an ALL-INCONCLUSIVE SUCCESS seal
  // moves the lane by EXACTLY 0.000 — the +0.3 raw signal is nulled because
  // the reference weights it by mean check confidence (0 here). The +0.3 only
  // shows up in a MIXED seal with a co-passing check.
  assert.equal(zeroAfter.score, zeroBefore.score, "all-INCONCLUSIVE seal is a 0.000 lane move, not +0.3");
  // The honest signal: a sample that examined nothing earns strictly less
  // lane trust than one that verified a real ref.
  const cleanRef: SampleResult[] = [
    { page: "openwiki/a.md", refsChecked: 1, refsBroken: 0, anyMissing: false, evidence: ["ok: src/x.ts"] },
  ];
  const cleanLedger = new MemoryLedger();
  const { after: cleanAfter } = await sealEventWarrant({
    ledger: cleanLedger, policy: docPolicy(), generator: "openwiki@test",
    event: { kind: "sample", runId: "r1", results: cleanRef }, intent: "wiki sample",
    checks: sampleChecks(cleanRef), groundTruth: "mechanical-sample" });
  assert.ok(zeroAfter.score < cleanAfter.score, "zero-evidence sample must not earn full VERIFY signal");
});

test("H-1: overallBand fails CLOSED on an unknown band string; all three valid bands still render", () => {
  // Measured bug: BAND_SEVERITY["ACTION"] is undefined; undefined > 0 is
  // false -> a corrupt band read as the HEALTHIEST state (ok fence copy).
  const corrupt = structuredClone(scAction);
  corrupt.pages["openwiki/b.md"].band = "ACTION" as Band;
  assert.throws(() => overallBand(corrupt), /unknown band "ACTION" for openwiki\/b\.md/);
  // Valid bands unaffected: worst-band semantics and fence rendering hold.
  assert.equal(overallBand(scOk), "ok");
  assert.equal(overallBand(scWarning), "warning");
  assert.equal(overallBand(scAction), "action");
  for (const sc of [scOk, scWarning, scAction]) assert.ok(renderFenceBlock(sc).startsWith(FENCE_BEGIN));
});

test("M-1: dir-as-file and empty-file-part refs count as broken (no raw EISDIR); the page sample completes", async () => {
  // Measured bug: existsSync passes for directories; readFileSync then threw
  // raw EISDIR and killed the whole page sample. An empty file part ('#sym')
  // joins to the repo root itself — also a directory.
  mkdirSync(join(tmpRoot, "src", "dir.ts"), { recursive: true });
  const v = new MechanicalVerifier(tmpRoot);
  const bareDir = await v.verify("openwiki/a.md", "src/dir.ts");
  assert.equal(bareDir.ok, false);
  assert.equal(bareDir.evidence, "broken: src/dir.ts (not a regular file)");
  const dirSym = await v.verify("openwiki/a.md", "src/dir.ts#sym");
  assert.equal(dirSym.ok, false);
  assert.equal(dirSym.evidence, "broken: src/dir.ts#sym (not a regular file)");
  const emptyPart = await v.verify("openwiki/a.md", "#sym");
  assert.equal(emptyPart.ok, false);
  // Sample completes: the aggregate carries the broken refs instead of crashing.
  const res = await verifyPage(tmpRoot, pageState({ path: "openwiki/dir.md",
    sources: ["src/dir.ts#sym", "#sym", "src/parser.ts"] }));
  assert.equal(res.refsChecked, 3);
  assert.equal(res.refsBroken, 2);
  assert.equal(res.anyMissing, false); // present-but-not-a-file is broken, not missing
});

test("M-2: denormalized refs ('./x', '../x', 'x//y') are broken, never resolved against the fs — no reads outside repoRoot", async () => {
  // Measured bug: join() normalizes './' and '../', so '../outside#symbol'
  // verified ok:true by READING A FILE OUTSIDE THE REPO ROOT.
  const outer = mkdtempSync(join(tmpdir(), "openwiki-m2-"));
  const inner = join(outer, "repo");
  mkdirSync(join(inner, "src"), { recursive: true });
  writeFileSync(join(outer, "outside.ts"), "export const leakedSymbol = 1;\n");
  writeFileSync(join(inner, "src", "in.ts"), "export const inSymbol = 1;\n");
  const v = new MechanicalVerifier(inner);
  // The probe: the outside file EXISTS and CONTAINS the symbol — only a
  // no-fs-access reject can report it broken.
  const escape = await v.verify("p.md", "../outside.ts#leakedSymbol");
  assert.equal(escape.ok, false);
  assert.equal(escape.evidence, "broken: denormalized ref ../outside.ts#leakedSymbol");
  for (const ref of ["./src/in.ts", "src/./in.ts", "src//in.ts"]) {
    const res = await v.verify("p.md", ref);
    assert.equal(res.ok, false, `${ref} must be broken`);
    assert.match(res.evidence, /denormalized ref/);
  }
  // Normalized ref to the same tree still verifies clean (exact-segment rule).
  assert.equal((await v.verify("p.md", "src/in.ts#inSymbol")).ok, true);
  // verifyPage: denormalized refs are broken-not-missing and skip the
  // mechanical existence probe too (no fs access outside the root).
  const res = await verifyPage(inner, pageState({ path: "openwiki/esc.md",
    sources: ["../outside.ts#leakedSymbol", "../definitely-gone.ts", "src/in.ts"] }));
  assert.equal(res.refsChecked, 3);
  assert.equal(res.refsBroken, 2);
  assert.equal(res.anyMissing, false);
});

test("M-3/M-4: samplePages throws on non-finite nowMs (silent weight-stripping) and non-finite n (silent empty sample)", () => {
  // Measured: NaN nowMs -> NaN weights -> insertion-order picks (staleness
  // weighting silently gone); NaN n -> silent [] (an empty sample downstream).
  const sc = sidecarWith([
    pageState({ path: "openwiki/a.md", lastEventMs: 0 }),
    pageState({ path: "openwiki/b.md", lastEventMs: 10 }),
  ]);
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => samplePages(sc, 1, bad, () => 0.5), /nowMs must be finite/);
    assert.throws(() => samplePages(sc, bad, 0, () => 0.5), /n must be finite/);
  }
});

test("M-4: sealEventWarrant rejects an empty-results sample before it reaches the ledger", async () => {
  // Measured: results [] sealed SUCCESS with ZERO checks — lane credit for a
  // sample that examined nothing.
  const ledger = new MemoryLedger();
  await assert.rejects(
    sealEventWarrant({ ledger, policy: docPolicy(), generator: "openwiki@test",
      event: { kind: "sample", runId: "r1", results: [] }, intent: "wiki sample",
      checks: sampleChecks([]), groundTruth: "mechanical-sample" }),
    /sample event r1: empty results/,
  );
  // The guard fires BEFORE the intent append: nothing hits the ledger.
  assert.equal(ledger.warrantsFor("openwiki@test", DOC_MAP_TASK).length, 0);
});

test("L-1: renderers throw on non-finite scores instead of printing 'NaN'/'Infinity' into TRUST.md and the fence", () => {
  // Measured: toFixed renders NaN verbatim -> "| x.md | NaN | ... |".
  const corrupt = structuredClone(scOk);
  corrupt.pages["openwiki/a.md"].score = Number.NaN;
  assert.throws(() => renderTrustMd(corrupt), /non-finite score/);
  assert.throws(() => renderTrustDelta(scOk, corrupt), /non-finite score/);
  const inf = structuredClone(scWarning);
  inf.pages["openwiki/a.md"].score = Infinity;
  assert.throws(() => renderFenceBlock(inf), /non-finite score/);
});

test("L-2: renderTrustMd escapes '|' and flattens newlines in the path cell — one row, five cells", () => {
  // Measured: a '|' in the path adds a phantom table column; a newline splits
  // the row across two lines.
  const weird = structuredClone(scOk);
  const pipePath = "openwiki/a|b.md";
  const nlPath = "openwiki/x\ny.md";
  weird.pages[pipePath] = { ...weird.pages["openwiki/a.md"], path: pipePath };
  weird.pages[nlPath] = { ...weird.pages["openwiki/a.md"], path: nlPath };
  const md = renderTrustMd(weird);
  const pipeRow = md.split("\n").find((l) => l.includes("a\\|b.md"));
  assert.ok(pipeRow, "pipe must be escaped as \\| in the path cell");
  // Exactly 6 unescaped '|' delimiters = 5 cells.
  assert.equal(pipeRow.split("|").length - 1 - (pipeRow.match(/\\\|/g) ?? []).length, 6);
  const nlRow = md.split("\n").find((l) => l.includes("x y.md"));
  assert.ok(nlRow && nlRow.startsWith("| openwiki/x y.md |"), "newline must not split the row");
});

test("R-10: renderTrustDelta suppresses visually-no-op lines (rendered score equal AND band unchanged)", () => {
  // Measured: a sub-0.0005 drift emitted "0.550 -> 0.550 (ok -> ok)".
  const drift = structuredClone(scOk);
  drift.pages["openwiki/a.md"].score += 0.0001; // both sides render as 0.550
  assert.equal(renderTrustDelta(scOk, drift), "No wiki trust changes.\n");
  // Same rendered score but a band change still lists (existing contract).
  assert.match(renderTrustDelta(scOk, scAction), /openwiki\/b\.md: 0\.550 -> 0\.550 \(ok -> action\)/);
  // A visible rendered-score change still lists.
  assert.match(renderTrustDelta(scWarning, scOk), /openwiki\/a\.md: 0\.250 -> 0\.550/);
});

test("INVARIANT: no VERIFY check records PASS@1 when refsChecked is 0", async () => {
  const mixed: SampleResult[] = [
    { page: "openwiki/none.md", refsChecked: 0, refsBroken: 0, anyMissing: false, evidence: [] },
    { page: "openwiki/a.md", refsChecked: 2, refsBroken: 0, anyMissing: false, evidence: [] },
  ];
  for (const spec of sampleChecks(mixed)) {
    const res = await spec.run({ intent: "wiki sample", input: undefined, output: undefined });
    if (res.name === "openwiki:sample:openwiki/none.md") {
      assert.notEqual(res.verdict, "PASS", "zero-ref sample must never record PASS");
      assert.equal(res.verdict, "INCONCLUSIVE");
      assert.equal(res.confidence, 0);
    } else {
      assert.equal(res.verdict, "PASS"); // real refs keep the full signal
    }
  }
});

test("renderers are deterministic: pure functions of the sidecar, stable across calls and clones", () => {
  assert.equal(renderTrustMd(scAction), renderTrustMd(structuredClone(scAction)));
  assert.equal(renderFenceBlock(scAction), renderFenceBlock(structuredClone(scAction)));
  assert.equal(
    renderTrustDelta(scWarning, scAction),
    renderTrustDelta(structuredClone(scWarning), structuredClone(scAction)),
  );
  // Repeated calls: byte-identical (no wall clock, no randomness).
  assert.equal(renderTrustMd(scOk), renderTrustMd(scOk));
});

// ---------------------------------------------------------------------------
// Task 3.1: CLI-layer pure helpers (mulberry32 seeded PRNG, plan-snapshot name)
// ---------------------------------------------------------------------------

test("mulberry32 is a deterministic, reproducible PRNG in [0, 1)", () => {
  // Same seed => identical sequence, across fresh instances (reproducible runs
  // for --seed). This is what makes `sample --seed N` deterministic.
  const a = mulberry32(7);
  const b = mulberry32(7);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  // Every draw is a real fraction in [0, 1) — samplePages' cumulative walk
  // relies on this domain (out-of-domain values clamp to first/last).
  for (const x of seqA) {
    assert.ok(x >= 0 && x < 1, `draw ${x} out of [0,1)`);
  }
});

test("mulberry32 different seeds diverge (not a constant stream)", () => {
  const s1 = mulberry32(1)();
  const s2 = mulberry32(2)();
  assert.notEqual(s1, s2);
});

test("planFileName replaces ':' so the plan snapshot is a legal filename", () => {
  // ISO timestamps carry colons; a colon is illegal on some filesystems and
  // awkward everywhere. The snapshot file is <colons-replaced>.md.
  assert.equal(planFileName("2026-07-03T07:15:30.123Z"), "2026-07-03T07-15-30.123Z");
  assert.ok(!planFileName("2026-07-03T07:15:30.123Z").includes(":"));
});
