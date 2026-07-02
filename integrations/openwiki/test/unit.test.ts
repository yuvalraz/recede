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
  type SampleResult,
  type WikiEvent,
} from "../openwiki-adapter.ts";
import { MemoryLedger, open, type Warrant } from "../../../reference/ts/src/index.ts";

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
    incremental = foldEvent(incremental, ev, warrant.intent.id, warrant.intent.ts);
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
