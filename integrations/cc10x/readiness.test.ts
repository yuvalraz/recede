// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Readiness matrix — pure core + markdown render (plan §4-§7), fixture-tested
// offline on MemoryLedger. Namespace import so during RED the not-yet-exported
// functions are `undefined` and calls fail behaviorally ("is not a function"),
// not as a module-collection error (adapter.test.ts precedent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "./readiness.ts";
import type { Readiness, ReadinessCell, ReadinessLane } from "./readiness.ts";
import {
  act,
  checkpoint,
  coldStart,
  evRef,
  gate,
  makeCheckRecord,
  MemoryLedger,
  open,
  seal,
  update,
  referencePolicyV02,
  type CheckKind,
  type Decision,
  type OutcomeResult,
  type Policy,
  type TrustState,
  type Verdict,
  type Warrant,
} from "../../reference/ts/src/index.ts";
import { codingPolicy } from "./cc10x-adapter.ts";
import type { EvidenceMap } from "../scanner/scanner.ts";

// ---------------------------------------------------------------------------
// Fixture plumbing — deterministic timestamps, kernel-built warrants
// ---------------------------------------------------------------------------

let seq = 0;
function ts(): string {
  const n = seq++;
  const hh = String(Math.floor(n / 3600)).padStart(2, "0");
  const mm = String(Math.floor((n % 3600) / 60)).padStart(2, "0");
  const ss = String(n % 60).padStart(2, "0");
  return `2026-01-01T${hh}:${mm}:${ss}.000Z`;
}

interface CycleCheck {
  kind: CheckKind;
  verdict: Verdict;
  confidence: number;
  refs?: string[];
}

interface CycleOpts {
  actor: string;
  task: string;
  risk: string;
  checks?: CycleCheck[];
  outcome?: OutcomeResult;
  gts?: string;
  human?: Decision;
}

/** Record one full warrant via the kernel's own builders + fold trust via update(). */
function recordCycle(ledger: MemoryLedger, policy: Policy, o: CycleOpts): void {
  const intent = open({
    actor: o.actor,
    task_type: o.task,
    proposed_action: "do the thing",
    declared_risk: o.risk,
    ts: ts(),
  });
  const action = act({ intent, operations: ["op"], result: null, ts: ts() });
  ledger.append(intent);
  ledger.append(action);
  let prev: string = action.id;
  const checks = o.checks ?? [{ kind: "VERIFY" as const, verdict: "PASS" as const, confidence: 1 }];
  for (const c of checks) {
    const rec = makeCheckRecord({
      action,
      check_kind: c.kind,
      method: "cc10x:phase",
      verdict: c.verdict,
      confidence: c.confidence,
      evidence_refs: c.refs ?? [],
      prev,
      ts: ts(),
    });
    ledger.append(rec);
    prev = rec.id;
  }
  if (o.human) {
    const cp = checkpoint({
      warrant_ref: intent.id,
      actor: o.actor,
      reason: "review",
      altitude: "brief",
      decision: o.human,
      reviewer: "yuval",
      prev,
      ts: ts(),
    });
    ledger.append(cp);
    prev = cp.id;
  }
  const out = seal({
    warrant_ref: intent.id,
    actor: o.actor,
    result: o.outcome ?? "SUCCESS",
    ground_truth_source: o.gts ?? "cc10x-phases",
    prev,
    ts: ts(),
  });
  ledger.append(out);
  const w = ledger.warrant(intent.id)!;
  const prevTrust = ledger.getTrust(o.actor, o.task) ?? coldStart(o.actor, o.task);
  ledger.putTrust(update(prevTrust, w, policy).state);
}

/**
 * Widget-shaped fixture (v0.1 coding policy): a REVERTED, backfill-marked lane
 * whose stored tier is HELD below the derived tier (demotion hold), plus an
 * UNRESOLVED-only lane (per-cycle-confidence fallback path).
 *   octo-dev/code.fix: 12 clean SUCCESS -> T2 (score ~.784, n=12); then one
 *   APPROVE+REVERTED warrant: positive fold (human overrides) to score ~.810,
 *   n=13, derived T2, force-demote clamps stored to T1 -> demotion hold.
 */
function widgetFixture(): { ledger: MemoryLedger; policy: Policy } {
  const policy = codingPolicy();
  const ledger = new MemoryLedger();
  for (let i = 0; i < 12; i++) {
    recordCycle(ledger, policy, {
      actor: "octo-dev",
      task: "code.fix",
      risk: "reversible.low",
      gts: "backfill:reconstructed",
    });
  }
  recordCycle(ledger, policy, {
    actor: "octo-dev",
    task: "code.fix",
    risk: "reversible.low",
    human: "APPROVE",
    outcome: "REVERTED",
    gts: "backfill:revert-detected",
  });
  recordCycle(ledger, policy, {
    actor: "octo-dev",
    task: "code.docs",
    risk: "read.only",
    outcome: "UNRESOLVED",
    gts: "cc10x-phases",
  });
  return { ledger, policy };
}

/**
 * Dogfood-shaped fixture (v0.1): the plan §5.2 worked example — 6 clean cycles
 * with checks (1, 1, 1, .9) -> per-cycle c = .975, score ~.526, n=6 — plus an
 * n=1 cold lane.
 */
function dogfoodFixture(): { ledger: MemoryLedger; policy: Policy } {
  const policy = codingPolicy();
  const ledger = new MemoryLedger();
  const phases: CycleCheck[] = [
    { kind: "VERIFY", verdict: "PASS", confidence: 1 },
    { kind: "VERIFY", verdict: "PASS", confidence: 1 },
    { kind: "VERIFY", verdict: "PASS", confidence: 1 },
    { kind: "VALIDATE", verdict: "PASS", confidence: 0.9 },
  ];
  for (let i = 0; i < 6; i++) {
    recordCycle(ledger, policy, {
      actor: "fable-5@claude-code",
      task: "code.feature",
      risk: "reversible.low",
      checks: phases,
    });
  }
  recordCycle(ledger, policy, {
    actor: "opus-4.8@claude-code",
    task: "code.fix",
    risk: "reversible.low",
  });
  return { ledger, policy };
}

/**
 * v0.2 fixture: declared evidence_weights, evidence_refs on every check, so
 * LaneEvidence and evidence_alternative populate. `review` is a NON-test class
 * (no assertion-strength gate), `unit` IS a test class. Pooled per-cycle
 * confidence: review@L1 (.3) + unit@L2-without-mut (gated to L1 -> .2)
 * + a ref-less VALIDATE (class "unknown", .1*.9 = .09)
 * -> pool = 1 - .7*.8*.91 = .4904. Best single edit: review L1->L2 (.9)
 * -> pool = 1 - .1*.8*.91 = .9272 (beats unit mut=1 -> 1 - .7*.15*.91 = .90445).
 */
function v02Fixture(): { ledger: MemoryLedger; policy: Policy } {
  const policy = referencePolicyV02({
    review: { L1: 0.3, L2: 0.9 },
    unit: { L1: 0.2, L2: 0.85 },
  });
  const ledger = new MemoryLedger();
  const checks: CycleCheck[] = [
    {
      kind: "VERIFY",
      verdict: "PASS",
      confidence: 1,
      refs: [evRef("review", "L1", "ci", "sha256:a", "gh://run/1")],
    },
    {
      kind: "VERIFY",
      verdict: "PASS",
      confidence: 1,
      refs: [evRef("unit", "L2", "ci", "sha256:b", "gh://run/2")],
    },
    { kind: "VALIDATE", verdict: "PASS", confidence: 0.9 }, // no ref -> undescribed
  ];
  for (let i = 0; i < 2; i++) {
    recordCycle(ledger, policy, {
      actor: "agentA",
      task: "code.fix",
      risk: "reversible.low",
      checks,
    });
  }
  return { ledger, policy };
}

/** Fold k synthetic clean warrants at confidence c through the REAL update(). */
function foldClean(state: TrustState, c: number, policy: Policy, k: number): TrustState {
  let s = state;
  for (let i = 0; i < k; i++) {
    const intent = open({
      actor: state.actor,
      task_type: state.task_type,
      proposed_action: "clean cycle",
      declared_risk: "reversible.low",
      ts: ts(),
    });
    const action = act({ intent, operations: ["op"], result: null, ts: ts() });
    const check = makeCheckRecord({
      action,
      check_kind: "VERIFY",
      method: "sim",
      verdict: "PASS",
      confidence: c,
      ts: ts(),
    });
    const outcome = seal({
      warrant_ref: intent.id,
      actor: state.actor,
      result: "SUCCESS",
      ground_truth_source: "sim",
      ts: ts(),
    });
    const w: Warrant = { intent, action, checks: [check], checkpoints: [], outcome };
    s = update(s, w, policy).state;
  }
  return s;
}

function laneOf(r: Readiness, actor: string, task: string): ReadinessLane {
  const lane = r.lanes.find((l) => l.actor === actor && l.task_type === task);
  assert.ok(lane, `lane (${actor}, ${task}) present`);
  return lane!;
}

function cellOf(lane: ReadinessLane, risk: string): ReadinessCell {
  const cell = lane.cells.find((c) => c.risk === risk);
  assert.ok(cell, `cell ${risk} present`);
  return cell!;
}

// ---------------------------------------------------------------------------
// Schema + column order + tier scan
// ---------------------------------------------------------------------------

test("READINESS_SCHEMA is the frozen contract marker", () => {
  assert.equal(R.READINESS_SCHEMA, "recede-readiness/1");
});

test("riskColumns: RISK_ORDER first, then extra matrix keys sorted, then never_recede extras", () => {
  const base = codingPolicy();
  assert.deepEqual(R.riskColumns(base), [
    "read.only",
    "reversible.low",
    "financial.reversible",
    "irreversible.critical",
  ]);
  const cp = { kind: "REQUIRE_CHECKPOINT" as const, altitude: "full" };
  const row = { T0: cp, T1: cp, T2: cp, T3: cp, T4: cp };
  const org: Policy = {
    ...base,
    matrix: { ...base.matrix, "custom.zz": row, "custom.aa": row },
    never_recede: [...base.never_recede, "org.floor"],
  };
  assert.deepEqual(R.riskColumns(org), [
    "read.only",
    "reversible.low",
    "financial.reversible",
    "irreversible.critical",
    "custom.aa",
    "custom.zz",
    "org.floor",
  ]);
});

test("minAutonomousTier: lowest AUTONOMOUS tier per risk; null when no tier reaches it", () => {
  const p = codingPolicy();
  assert.equal(R.minAutonomousTier(p, "read.only"), "T1");
  assert.equal(R.minAutonomousTier(p, "reversible.low"), "T2");
  assert.equal(R.minAutonomousTier(p, "financial.reversible"), "T3");
  assert.equal(R.minAutonomousTier(p, "irreversible.critical"), null);
  assert.equal(R.minAutonomousTier(p, "unknown.risk"), null);
});

// ---------------------------------------------------------------------------
// perCycleConfidence + cleanCyclesTo
// ---------------------------------------------------------------------------

test("perCycleConfidence: last counted warrant's folded confidence under the ledger's policy", () => {
  const { ledger, policy } = dogfoodFixture();
  const c = R.perCycleConfidence(ledger.warrantsFor("fable-5@claude-code", "code.feature"), policy);
  assert.ok(Math.abs(c - 0.975) < 1e-12, `mean of (1,1,1,.9) is .975, got ${c}`);
});

test("perCycleConfidence: no counted warrant -> fallback 1", () => {
  const { ledger, policy } = widgetFixture();
  const c = R.perCycleConfidence(ledger.warrantsFor("octo-dev", "code.docs"), policy);
  assert.equal(c, 1, "UNRESOLVED-only lane carries no counted warrant");
});

test("cleanCyclesTo: worked example — n=1 cold lane needs 9 clean cycles at c=1 to flip reversible.low", () => {
  const { ledger, policy } = dogfoodFixture();
  const trust = ledger.getTrust("opus-4.8@claude-code", "code.fix")!;
  // reversible.low flips at T2. Independent arithmetic: score 1-.88^(1+k) >= .55
  // at k=6; n = 1+k >= 10 at k=9.
  assert.equal(R.cleanCyclesTo(trust, "reversible.low", 1, policy), 9);
});

test("cleanCyclesTo: cap hit -> null (never an infinite loop)", () => {
  const policy = codingPolicy();
  const cold = coldStart("a", "t");
  // Confidence 0: the positive fold step is 0 -> score never moves -> the gate
  // never flips for reversible.low.
  assert.equal(R.cleanCyclesTo(cold, "reversible.low", 0, policy, 50), null);
});

// ---------------------------------------------------------------------------
// bindingConstraintOf + cheapestMoveOf (unit level)
// ---------------------------------------------------------------------------

test("never_recede floor binds FIRST at every tier, move is none_floor verbatim (I3)", () => {
  const policy = codingPolicy();
  for (const tier of ["T0", "T1", "T2", "T3", "T4"] as const) {
    const trust: TrustState = {
      actor: "a",
      task_type: "t",
      tier,
      score: 0.99,
      confidence: 0.95,
      sample_count: 100,
    };
    const b = R.bindingConstraintOf(trust, "irreversible.critical", policy, false);
    assert.equal(b.kind, "never_recede_floor", `tier ${tier}`);
    const m = R.cheapestMoveOf(b, trust, "irreversible.critical", policy, {
      perCycleConf: 1,
      evidenceAlternative: null,
    });
    assert.equal(m.kind, "none_floor");
    assert.equal(m.detail, "none — floor by design (I3)");
    assert.equal(m.clean_cycles, null);
  }
});

test("earned / matrix_ceiling / sample_cap / score_floor / score_and_samples classification", () => {
  const policy = codingPolicy();
  const st = (tier: TrustState["tier"], score: number, n: number): TrustState => ({
    actor: "a",
    task_type: "t",
    tier,
    score,
    confidence: 0.5,
    sample_count: n,
  });
  // earned: T2 is autonomous for reversible.low.
  assert.equal(R.bindingConstraintOf(st("T2", 0.6, 12), "reversible.low", policy, false).kind, "earned");
  // matrix_ceiling: unknown risk -> conservative checkpoint at every tier.
  assert.equal(R.bindingConstraintOf(st("T2", 0.6, 12), "custom.risk", policy, false).kind, "matrix_ceiling");
  // sample_cap: score clears the T2 floor (.55) but n=4 < 10 (I5).
  const cap = R.bindingConstraintOf(st("T1", 0.6, 4), "reversible.low", policy, false);
  assert.equal(cap.kind, "sample_cap");
  assert.match(cap.detail, /6 more samples/, "cites confidence_samples_per_tier[2] - n = 10 - 4");
  // score_floor: n=12 >= 10 but score .4 < .55.
  const floor = R.bindingConstraintOf(st("T1", 0.4, 12), "reversible.low", policy, false);
  assert.equal(floor.kind, "score_floor");
  assert.match(floor.detail, /0\.55/);
  // score_and_samples: both short.
  assert.equal(R.bindingConstraintOf(st("T1", 0.4, 4), "reversible.low", policy, false).kind, "score_and_samples");
});

test("demotion_hold: stored tier below derived tier + negative evidence", () => {
  const policy = codingPolicy();
  const trust: TrustState = {
    actor: "a",
    task_type: "t",
    tier: "T1",
    score: 0.81,
    confidence: 0.8,
    sample_count: 13,
  };
  const b = R.bindingConstraintOf(trust, "reversible.low", policy, true);
  assert.equal(b.kind, "demotion_hold");
  const m = R.cheapestMoveOf(b, trust, "reversible.low", policy, {
    perCycleConf: 1,
    evidenceAlternative: null,
  });
  assert.equal(m.kind, "clean_cycles");
  assert.equal(m.clean_cycles, 1, "the first clean fold re-derives the tier");
});

test("demotion_hold does NOT leak onto higher-target cells of the same demoted lane", () => {
  // CR-1: the hold explains ONLY cells whose target the derived tier actually
  // reaches. Same demoted trust (stored T1, derived T2, n=13): the T3-target
  // cell is bound by the I5 sample cap, not the demotion.
  const policy = codingPolicy();
  const trust: TrustState = {
    actor: "a",
    task_type: "t",
    tier: "T1",
    score: 0.81,
    confidence: 0.8,
    sample_count: 13,
  };
  // reversible.low (target T2 == derived T2): the hold binds, k=1.
  assert.equal(R.bindingConstraintOf(trust, "reversible.low", policy, true).kind, "demotion_hold");
  // financial.reversible (target T3 > derived T2): the hold is NOT the binding
  // constraint — re-deriving the tier still leaves the cell 12 samples short.
  const b = R.bindingConstraintOf(trust, "financial.reversible", policy, true);
  assert.equal(b.kind, "sample_cap");
  assert.match(b.detail, /12 more samples/, "n=13 of 25 for T3");
  const m = R.cheapestMoveOf(b, trust, "financial.reversible", policy, {
    perCycleConf: 1,
    evidenceAlternative: null,
  });
  assert.equal(m.kind, "clean_cycles");
  assert.equal(m.clean_cycles, 12, "binding and move agree: the sample cap is the constraint");
});

test("cleanCyclesTo: claimed k is a REAL gate() flip even under a non-monotone adopter matrix", () => {
  // M-2: adopter matrix autonomous at T2, checkpoint at T3, autonomous at T4,
  // with equal T2/T3 sample thresholds so the derived tier SKIPS T2 (T1 -> T3).
  // A tierFor>=target exit would claim a flip that never happens; the exit must
  // be gate() itself.
  const base = codingPolicy();
  const cp = { kind: "REQUIRE_CHECKPOINT" as const, altitude: "full" };
  const auto = { kind: "AUTONOMOUS" as const };
  const policy: Policy = {
    ...base,
    matrix: {
      ...base.matrix,
      "adopter.risk": { T0: cp, T1: cp, T2: auto, T3: cp, T4: auto },
    },
    weights: {
      ...base.weights,
      confidence_samples_per_tier: [0, 3, 10, 10, 60], // n=10 jumps T1 -> T3
    },
  };
  const trust: TrustState = {
    actor: "a",
    task_type: "t",
    tier: "T1",
    score: 0.8,
    confidence: 0.8,
    sample_count: 8,
  };
  const k = R.cleanCyclesTo(trust, "adopter.risk", 1, policy);
  assert.equal(k, 52, "T2 is skipped; the first real flip is T4 at n=60");
  // The claim must survive the REAL update(): gate flips at k, not at k-1.
  assert.equal(gate(foldClean(trust, 1, policy, k!), "adopter.risk", policy).autonomous, true);
  assert.equal(gate(foldClean(trust, 1, policy, k! - 1), "adopter.risk", policy).autonomous, false);
});

test("move detail strings cite the policy id@version and the no-decay assumption", () => {
  const policy = codingPolicy();
  const cold = coldStart("a", "t");
  const b = R.bindingConstraintOf(cold, "reversible.low", policy, false);
  const m = R.cheapestMoveOf(b, cold, "reversible.low", policy, {
    perCycleConf: 1,
    evidenceAlternative: null,
  });
  assert.equal(m.kind, "clean_cycles");
  assert.match(m.detail, /declared policy recede\.cc10x\.coding@0\.1\.0/);
  assert.match(m.detail, /digest sha256:[0-9a-f]{12}/);
  assert.match(m.detail, /assumes no idle decay/);
  // unreachable carries the raise-confidence framing + the same citation.
  const u = R.cheapestMoveOf(b, cold, "reversible.low", policy, {
    perCycleConf: 0,
    evidenceAlternative: null,
  });
  assert.equal(u.kind, "unreachable");
  assert.match(u.detail, /raise evidence confidence/);
  assert.match(u.detail, /declared policy recede\.cc10x\.coding@0\.1\.0/);
});

// ---------------------------------------------------------------------------
// buildReadiness — lanes, evidence, honesty labels, summary
// ---------------------------------------------------------------------------

test("buildReadiness: widget fixture — REVERTED lane is reconstructed, demotion hold reports k=1", () => {
  const { ledger, policy } = widgetFixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "octo-dev", "code.fix");
  assert.equal(lane.tier, "T1", "force-demote clamped the stored tier");
  assert.equal(lane.i2, "PASS");
  assert.ok(lane.outcomes.REVERTED >= 1);
  assert.equal(lane.outcomes.SUCCESS, 12);
  assert.equal(lane.reconstructed, true);
  assert.equal(lane.ground_truth_sources["backfill:reconstructed"], 12);
  assert.equal(lane.ground_truth_sources["backfill:revert-detected"], 1);
  const cell = cellOf(lane, "reversible.low");
  assert.equal(cell.posture, "checkpoint");
  assert.equal(cell.binding.kind, "demotion_hold");
  assert.equal(cell.move.kind, "clean_cycles");
  assert.equal(cell.move.clean_cycles, 1);
  // financial.reversible on the SAME demoted lane: the hold does not leak —
  // the derived tier (T2) never reaches the T3 target, so the I5 sample cap
  // binds and the footnote agrees with its own move (12 cycles = 12 samples).
  const higher = cellOf(lane, "financial.reversible");
  assert.equal(higher.binding.kind, "sample_cap");
  assert.match(higher.binding.detail, /12 more samples/);
  assert.equal(higher.move.kind, "clean_cycles");
  assert.equal(higher.move.clean_cycles, 12);
  // read.only at T1 is earned.
  const earned = cellOf(lane, "read.only");
  assert.equal(earned.posture, "autonomous");
  assert.equal(earned.altitude, null);
  assert.equal(earned.binding.kind, "earned");
  assert.equal(earned.move.kind, "none_earned");
});

test("buildReadiness: UNRESOLVED-only lane — coldStart posture, fallback c=1 labeled", () => {
  const { ledger, policy } = widgetFixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "octo-dev", "code.docs");
  assert.equal(lane.tier, "T0");
  assert.equal(lane.sample_count, 0);
  assert.equal(lane.outcomes.UNRESOLVED, 1);
  const cell = cellOf(lane, "read.only");
  assert.equal(cell.binding.kind, "score_and_samples");
  assert.equal(cell.move.per_cycle_confidence, 1);
  assert.match(cell.move.detail, /assumes fully-confident clean evidence/);
});

test("buildReadiness: dogfood worked example — score_and_samples, 4 clean cycles at c=.975", () => {
  const { ledger, policy } = dogfoodFixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "fable-5@claude-code", "code.feature");
  assert.equal(lane.sample_count, 6);
  const cell = cellOf(lane, "reversible.low");
  assert.equal(cell.binding.kind, "score_and_samples");
  assert.equal(cell.move.kind, "clean_cycles");
  assert.equal(cell.move.clean_cycles, 4, "plan §5.2 worked example");
  assert.ok(Math.abs(cell.move.per_cycle_confidence! - 0.975) < 1e-12);
});

test("buildReadiness: n=1 cold lane — sane k, evidence_alternative null under v0.1", () => {
  const { ledger, policy } = dogfoodFixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "opus-4.8@claude-code", "code.fix");
  assert.equal(lane.sample_count, 1);
  const cell = cellOf(lane, "reversible.low");
  assert.equal(cell.binding.kind, "score_and_samples");
  assert.equal(cell.move.clean_cycles, 9);
  for (const l of r.lanes) {
    for (const c of l.cells) {
      assert.equal(c.move.evidence_alternative, null, "v0.1 policy declares no evidence weights");
    }
  }
});

test("buildReadiness: empty ledger — valid artifact, zero lanes, summary zeros", () => {
  const policy = codingPolicy();
  const r = R.buildReadiness(new MemoryLedger(), policy);
  assert.equal(r.schemaVersion, "recede-readiness/1");
  assert.deepEqual(r.lanes, []);
  assert.deepEqual(r.summary, {
    lanes: 0,
    cells: 0,
    autonomous: 0,
    checkpoint_brief: 0,
    checkpoint_full: 0,
    never_recede: 0,
  });
  assert.equal(r.evidence_map, null);
  assert.equal(r.generatedAt, null, "pure core never stamps a clock");
});

test("buildReadiness: lanes are code-unit sorted by (actor, task_type), not append order", () => {
  const policy = codingPolicy();
  const ledger = new MemoryLedger();
  recordCycle(ledger, policy, { actor: "zeta", task: "code.fix", risk: "reversible.low" });
  recordCycle(ledger, policy, { actor: "alpha", task: "code.fix", risk: "reversible.low" });
  recordCycle(ledger, policy, { actor: "alpha", task: "code.docs", risk: "read.only" });
  const r = R.buildReadiness(ledger, policy);
  assert.deepEqual(
    r.lanes.map((l) => `${l.actor} ${l.task_type}`),
    ["alpha code.docs", "alpha code.fix", "zeta code.fix"],
  );
});

test("buildReadiness: LaneEvidence from the LEDGER's evidence_refs (classes/tiers/undescribed)", () => {
  const { ledger, policy } = v02Fixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "agentA", "code.fix");
  assert.deepEqual(lane.evidence.classes, { review: 2, unit: 2 });
  assert.deepEqual(lane.evidence.tiers, { L1: 2, L2: 2 });
  assert.equal(lane.evidence.undescribed_checks, 2, "the ref-less VALIDATE in each warrant");
});

test("buildReadiness: forward v1 records (empty refs) read as all self-reported — correct, not a bug", () => {
  const { ledger, policy } = dogfoodFixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "fable-5@claude-code", "code.feature");
  assert.deepEqual(lane.evidence.classes, {});
  assert.deepEqual(lane.evidence.tiers, {});
  assert.equal(lane.evidence.undescribed_checks, 24);
});

test("buildReadiness: v0.2 evidence_alternative — best single declared-weight edit, through the real gates", () => {
  const { ledger, policy } = v02Fixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "agentA", "code.fix");
  const cell = cellOf(lane, "reversible.low");
  assert.equal(cell.move.kind, "clean_cycles");
  assert.ok(Math.abs(cell.move.per_cycle_confidence! - 0.4904) < 1e-12, "pooled .4904");
  const alt = cell.move.evidence_alternative;
  assert.ok(alt, "a declared L2 weight exists -> alternative computed");
  // review L1->L2 (pool .9272) beats unit mut=1 (pool .90445): the anti-gaming
  // assertion-strength gate keeps declared-L2-without-mut unit at L1 (.2), so the
  // winning edit must be review — an L2 lift on the unadequate test class
  // cannot raise the pool without mut=1.
  assert.match(alt!, /^raising review .*L1→L2/);
  assert.doesNotMatch(alt!, /^raising unit/);
  assert.match(alt!, /0\.490→0\.927/);
  assert.match(alt!, /clean cycles/);
});

test("buildReadiness: tampered stored trust -> lane i2 FAIL (pure core reports, CLI fails closed later)", () => {
  const { ledger, policy } = dogfoodFixture();
  const stored = ledger.getTrust("opus-4.8@claude-code", "code.fix")!;
  ledger.putTrust({ ...stored, score: stored.score + 0.5 });
  const r = R.buildReadiness(ledger, policy);
  assert.equal(laneOf(r, "opus-4.8@claude-code", "code.fix").i2, "FAIL");
});

// ---------------------------------------------------------------------------
// Provable properties 1-6 (§7)
// ---------------------------------------------------------------------------

test("property 1 — determinism: byte-identical JSON on repeat builds; no clock in the module", () => {
  const { ledger, policy } = widgetFixture();
  const a = JSON.stringify(R.buildReadiness(ledger, policy));
  const b = JSON.stringify(R.buildReadiness(ledger, policy));
  assert.equal(a, b);
  const src = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bnew Date\(|\bDate\.now\(|Math\.random/, "purity grep (scanner precedent)");
});

test("property 2 — no aggregate: summary is the six integer counts, nothing averaged", () => {
  const { ledger, policy } = widgetFixture();
  const r = R.buildReadiness(ledger, policy);
  assert.deepEqual(Object.keys(r.summary).sort(), [
    "autonomous",
    "cells",
    "checkpoint_brief",
    "checkpoint_full",
    "lanes",
    "never_recede",
  ]);
  for (const v of Object.values(r.summary)) assert.ok(Number.isInteger(v), `count ${v} is an integer`);
  const total = r.summary.autonomous + r.summary.checkpoint_brief + r.summary.checkpoint_full + r.summary.never_recede;
  assert.equal(total, r.summary.cells, "postures partition the cells");
  assert.equal(r.summary.lanes, r.lanes.length);
});

test("property 3 — posture fidelity: every cell equals gate() verbatim, altitude included", () => {
  for (const { ledger, policy } of [widgetFixture(), dogfoodFixture(), v02Fixture()]) {
    const r = R.buildReadiness(ledger, policy);
    for (const lane of r.lanes) {
      const stored = ledger.getTrust(lane.actor, lane.task_type) ?? coldStart(lane.actor, lane.task_type);
      for (const cell of lane.cells) {
        const g = gate(stored, cell.risk, policy);
        assert.equal(cell.posture, g.autonomous ? "autonomous" : "checkpoint", `${lane.actor}/${cell.risk}`);
        assert.equal(cell.altitude, g.autonomous ? null : (g.altitude ?? null));
        assert.equal(cell.never_recede, policy.never_recede.includes(cell.risk));
      }
    }
  }
});

test("property 4 — move minimality: k clean folds through the REAL update() flip gate(); k-1 does not", () => {
  for (const { ledger, policy } of [widgetFixture(), dogfoodFixture()]) {
    const r = R.buildReadiness(ledger, policy);
    for (const lane of r.lanes) {
      const stored = ledger.getTrust(lane.actor, lane.task_type) ?? coldStart(lane.actor, lane.task_type);
      for (const cell of lane.cells) {
        if (cell.move.kind !== "clean_cycles") continue;
        const k = cell.move.clean_cycles!;
        const c = cell.move.per_cycle_confidence!;
        const atK = foldClean(stored, c, policy, k);
        assert.equal(gate(atK, cell.risk, policy).autonomous, true, `${lane.actor}/${cell.risk}: k=${k} flips`);
        if (k > 1) {
          const atKm1 = foldClean(stored, c, policy, k - 1);
          assert.equal(gate(atKm1, cell.risk, policy).autonomous, false, `${lane.actor}/${cell.risk}: k-1 does not`);
        } else {
          assert.equal(gate(stored, cell.risk, policy).autonomous, false, `${lane.actor}/${cell.risk}: 0 folds does not`);
        }
      }
    }
  }
  // v0.2 lane: clean cycles "like your last one" — fold copies of the lane's own
  // last counted warrant (its pooled confidence IS the per-cycle c).
  const { ledger, policy } = v02Fixture();
  const r = R.buildReadiness(ledger, policy);
  const lane = laneOf(r, "agentA", "code.fix");
  const stored = ledger.getTrust("agentA", "code.fix")!;
  const warrants = ledger.warrantsFor("agentA", "code.fix");
  const last = warrants[warrants.length - 1];
  const foldLast = (state: TrustState, k: number): TrustState => {
    let s = state;
    for (let i = 0; i < k; i++) s = update(s, last, policy).state;
    return s;
  };
  const cell = cellOf(lane, "reversible.low");
  assert.equal(cell.move.kind, "clean_cycles");
  const k = cell.move.clean_cycles!;
  assert.equal(gate(foldLast(stored, k), "reversible.low", policy).autonomous, true);
  assert.equal(gate(foldLast(stored, k - 1), "reversible.low", policy).autonomous, false);
});

test("property 5 — never_recede cells: checkpoint(full) + none_floor in every built fixture", () => {
  for (const { ledger, policy } of [widgetFixture(), dogfoodFixture(), v02Fixture()]) {
    const r = R.buildReadiness(ledger, policy);
    for (const lane of r.lanes) {
      for (const cell of lane.cells) {
        if (!policy.never_recede.includes(cell.risk)) continue;
        assert.equal(cell.posture, "checkpoint");
        assert.equal(cell.altitude, "full");
        assert.equal(cell.never_recede, true);
        assert.equal(cell.binding.kind, "never_recede_floor");
        assert.equal(cell.move.kind, "none_floor");
        assert.equal(cell.move.detail, "none — floor by design (I3)");
      }
    }
  }
});

test("property 6 — map neutrality: lanes byte-identical with and without the map", () => {
  const { ledger, policy } = widgetFixture();
  const map = {
    schemaVersion: "recede-evidence-map/1",
    generator: "recede-scout@0.1.0",
    generatedAt: null,
    repos: ["octo/widget"],
    sources: [],
    counts: {
      totalSources: 14,
      wiredToTrust: 0,
      byStrength: { "required-status-check": 3, "optional-check": 9, "self-reported": 2 },
      byClass: {},
      withArtifact: 0,
      mutationAdequate: 0,
    },
  } as unknown as EvidenceMap;
  const without = R.buildReadiness(ledger, policy);
  const withMap = R.buildReadiness(ledger, policy, { map });
  assert.equal(JSON.stringify(withMap.lanes), JSON.stringify(without.lanes));
  assert.equal(without.evidence_map, null);
  assert.deepEqual(withMap.evidence_map, {
    generator: "recede-scout@0.1.0",
    repos: ["octo/widget"],
    counts: map.counts,
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — renderMarkdown (§6)
// ---------------------------------------------------------------------------

test("renderMarkdown: header, counts-only caption verbatim, legends, honesty captions, I2 line", () => {
  const { ledger, policy } = widgetFixture();
  const md = R.renderMarkdown(R.buildReadiness(ledger, policy));
  assert.match(md, /^# Recede readiness matrix\n/);
  assert.ok(md.includes("(counts, never averaged"), "the verbatim caption is always present");
  assert.ok(md.includes("NEVER = never-recede floor"), "NEVER legend");
  assert.ok(md.includes("* = reconstructed lane"), "reconstructed legend");
  assert.ok(md.includes("Weights are declared policy, edit freely — not a prediction."));
  assert.match(md, /I2 replay integrity: PASS \(2\/2 lanes\)/, "widget fixture has 2 lanes");
  assert.match(md, /policy recede\.cc10x\.coding@0\.1\.0 \(digest sha256:[0-9a-f]{12}\)/);
  // Reconstructed lane carries the * marker in its row.
  assert.match(md, /octo-dev · code\.fix \*/);
  // never_recede column renders NEVER, autonomous renders auto.
  assert.match(md, /\| NEVER \|/);
  assert.match(md, /\| auto \|/);
  // No forecast language anywhere (declared-policy arithmetic only). The one
  // permitted occurrence of "predict" is the mandated honesty caption itself.
  assert.doesNotMatch(md, /will succeed/i);
  assert.equal((md.match(/predict/gi) ?? []).length, 1, "only 'not a prediction' in the caption");
  assert.ok(md.includes("not a prediction"));
});

test("renderMarkdown: footnote integrity — every [n] marker in the table has a block", () => {
  for (const { ledger, policy } of [widgetFixture(), dogfoodFixture(), v02Fixture()]) {
    const md = R.renderMarkdown(R.buildReadiness(ledger, policy));
    const tableMarkers = [...md.matchAll(/cp\((?:[a-z]+)\) \[(\d+)\]/g)].map((m) => m[1]);
    assert.ok(tableMarkers.length > 0, "checkpoint cells carry markers");
    for (const n of tableMarkers) {
      assert.ok(md.includes(`[${n}] binding: `), `footnote block [${n}] present`);
      assert.match(md, new RegExp(`\\[${n}\\] binding: [\\s\\S]*?\\n    move: `), `move line for [${n}]`);
    }
  }
});

test("renderMarkdown: summary line is counts only and matches the artifact", () => {
  const { ledger, policy } = dogfoodFixture();
  const r = R.buildReadiness(ledger, policy);
  const md = R.renderMarkdown(r);
  const s = r.summary;
  assert.ok(
    md.includes(
      `${s.lanes} lanes · ${s.cells} cells: ${s.autonomous} autonomous · ` +
        `${s.checkpoint_brief} checkpoint(brief) · ${s.checkpoint_full} checkpoint(full) · ` +
        `${s.never_recede} never-recede`,
    ),
    "counts-only summary line",
  );
});

test("renderMarkdown: per-lane evidence lines from the ledger; repo-level map block when present", () => {
  const { ledger, policy } = v02Fixture();
  const map = {
    schemaVersion: "recede-evidence-map/1",
    generator: "recede-scout@0.1.0",
    generatedAt: null,
    repos: ["octo/widget"],
    sources: [],
    counts: {
      totalSources: 14,
      wiredToTrust: 0,
      byStrength: { "required-status-check": 3 },
      byClass: {},
      withArtifact: 0,
      mutationAdequate: 0,
    },
  } as unknown as EvidenceMap;
  const md = R.renderMarkdown(R.buildReadiness(ledger, policy, { map }));
  assert.match(md, /Evidence \(per lane, from the ledger\): agentA · code\.fix — 4 evidence descriptors; 2 checks self-reported\./);
  assert.match(md, /Evidence map \(repo-level, per-source — not joinable per-lane\): 14 sources, 0 wired to trust/);
});

test("renderMarkdown: a '|' in the actor is escaped — every table row keeps the header's field count", () => {
  // M-1: lane labels and altitudes are interpolated into |-delimited rows;
  // unescaped pipes silently break the table.
  const policy = codingPolicy();
  const ledger = new MemoryLedger();
  recordCycle(ledger, policy, { actor: "evil|actor", task: "code.fix", risk: "reversible.low" });
  const md = R.renderMarkdown(R.buildReadiness(ledger, policy));
  const table = md.split("\n").filter((l) => l.startsWith("|"));
  assert.ok(table.length >= 3, "header + separator + one lane row");
  const fields = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;
  const headerFields = fields(table[0]);
  for (const line of table) {
    assert.equal(fields(line), headerFields, `well-formed row: ${line}`);
  }
  assert.ok(md.includes("evil\\|actor"), "the pipe is escaped, not dropped");
});

test("renderMarkdown: a '|' in a risk-class name is escaped in the header row", () => {
  // Deferred pipe note (remfix): risk classes are org-defined strings and land
  // in the |-delimited header row; an unescaped pipe silently adds a column.
  const base = codingPolicy();
  const policy: Policy = {
    ...base,
    matrix: { ...base.matrix, "weird|risk": base.matrix["reversible.low"] },
  };
  const ledger = new MemoryLedger();
  recordCycle(ledger, policy, { actor: "octo-dev", task: "code.fix", risk: "reversible.low" });
  const md = R.renderMarkdown(R.buildReadiness(ledger, policy));
  const table = md.split("\n").filter((l) => l.startsWith("|"));
  const fields = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;
  const headerFields = fields(table[0]);
  for (const line of table) {
    assert.equal(fields(line), headerFields, `well-formed row: ${line}`);
  }
  assert.ok(md.includes("weird\\|risk"), "the header pipe is escaped, not dropped");
});

test("renderMarkdown: empty ledger renders valid, boring output", () => {
  const md = R.renderMarkdown(R.buildReadiness(new MemoryLedger(), codingPolicy()));
  assert.match(md, /^# Recede readiness matrix\n/);
  assert.ok(md.includes("no lanes recorded yet"));
  assert.ok(md.includes("(counts, never averaged"));
  assert.match(md, /I2 replay integrity: PASS \(0\/0 lanes\)/);
});

test("renderMarkdown: generatedAt stamped by the caller appears; null renders unstamped", () => {
  const { ledger, policy } = dogfoodFixture();
  const stamped = R.renderMarkdown(
    R.buildReadiness(ledger, policy, { now: "2026-07-12T10:00:00Z" }),
  );
  assert.ok(stamped.includes("generated 2026-07-12T10:00:00Z"));
  const unstamped = R.renderMarkdown(R.buildReadiness(ledger, policy));
  assert.ok(unstamped.includes("generated (unstamped)"));
});
