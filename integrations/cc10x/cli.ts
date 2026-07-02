#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * recede-cc10x — a thin CLI over the CC10X adapter for recording REAL agent
 * sessions into a persistent, cross-session trust ledger (FileLedger JSONL)
 * and reading trust state back. Zero runtime dependencies; Node >= 22.6
 * (native type stripping).
 *
 *   node cli.ts record --ledger <path> --actor <id> --task <type> --intent "..."
 *                      --verifier pass [--hunter pass|fail|skip] [--tests ...]
 *                      [--validate ...] [--human approve|reject|modify|none]
 *                      [--risk <RiskClass>] [--outcome ...] [--defer <ISO>]
 *   node cli.ts reseal --ledger <path> --warrant <id> --outcome reverted|success
 *                      --source "<ground truth>"
 *   node cli.ts status --ledger <path> [--actor <id>] [--task <type>]
 *
 * The CLI is a recorder, not a re-verifier: the phase flags carry verdicts the
 * workflow spine already produced. One honesty rule is enforced fail-closed:
 * if the pure gate demands a human checkpoint for a lane, `record --human none`
 * is REFUSED (exit 2) — the gate posture is the answer, not an obstacle.
 * The ledger path is always caller-supplied; nothing is ever written anywhere
 * else.
 */

import { parseArgs } from "node:util";
import {
  FileLedger,
  coldStart,
  fixedCheckpoint,
  gate,
  replay,
  RISK_ORDER,
  type CheckpointHandler,
  type Decision,
  type IntentRecord,
  type OutcomeResult,
  type Policy,
  type TrustState,
} from "../../reference/ts/src/index.ts";
import {
  Cc10xRecede,
  codingPolicy,
  defaultRiskFor,
  DEFAULT_TASK_RISK,
  type Cc10xPhaseSignal,
} from "./cc10x-adapter.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const USAGE = `recede-cc10x — record real build/verify cycles into a trust ledger

usage:
  node cli.ts record --ledger <path> --actor <id> --task <task-type> --intent "<one line>"
                     --verifier pass|fail [--hunter pass|fail|skip] [--tests pass|fail|skip]
                     [--validate pass|fail|skip] [--human approve|reject|modify|none]
                     [--risk <RiskClass>] [--outcome success|failure|reverted|unresolved]
                     [--defer <ISO date>] [--reviewer <name>]
  node cli.ts reseal --ledger <path> --warrant <id or unique prefix>
                     --outcome reverted|success --source "<ground truth>"
  node cli.ts status --ledger <path> [--actor <id>] [--task <task-type>]

task types with default risk:
${Object.entries(DEFAULT_TASK_RISK)
  .map(([t, r]) => `  ${t.padEnd(17)} ${r}`)
  .join("\n")}
(any other task type is accepted; pass --risk explicitly)`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(`run 'node cli.ts' with no arguments for usage`);
  process.exit(1);
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") fail(`missing required ${flag}`);
  return v;
}

function oneOf(v: string, flag: string, allowed: string[]): string {
  if (!allowed.includes(v)) fail(`${flag} must be one of ${allowed.join("|")} (got '${v}')`);
  return v;
}

const fmtTrust = (s: TrustState): string =>
  `tier=${s.tier} score=${s.score.toFixed(3)} conf=${s.confidence.toFixed(3)} n=${s.sample_count}`;

function posture(trust: TrustState, risk: string, policy: Policy): string {
  const g = gate(trust, risk, policy);
  return g.autonomous
    ? `AUTONOMOUS — ${g.reason}`
    : `CHECKPOINT(${g.altitude}) — ${g.reason}`;
}

function intentsIn(ledger: FileLedger): IntentRecord[] {
  return ledger.records().filter((r): r is IntentRecord => r.kind === "INTENT");
}

/** Resolve a warrant ref (full intent id or unique prefix) against the ledger. */
function resolveIntentId(ledger: FileLedger, ref: string): string {
  const intents = intentsIn(ledger);
  if (intents.some((r) => r.id === ref)) return ref;
  const hits = intents.filter((r) => r.id.startsWith(ref) || r.id.startsWith(`sha256:${ref}`));
  if (hits.length === 1) return hits[0].id;
  fail(
    hits.length === 0
      ? `no warrant matching '${ref}' in this ledger`
      : `ambiguous warrant ref '${ref}' (${hits.length} matches) — use more characters`,
  );
}

// ---------------------------------------------------------------------------
// record — seal one Warrant for a completed build/verify cycle
// ---------------------------------------------------------------------------

async function cmdRecord(args: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      ledger: { type: "string" },
      actor: { type: "string" },
      task: { type: "string" },
      risk: { type: "string" },
      intent: { type: "string" },
      verifier: { type: "string" },
      hunter: { type: "string" },
      tests: { type: "string" },
      validate: { type: "string" },
      human: { type: "string" },
      outcome: { type: "string" },
      defer: { type: "string" },
      reviewer: { type: "string" },
    },
  });

  const ledgerPath = need(v.ledger, "--ledger");
  const actor = need(v.actor, "--actor");
  const task = need(v.task, "--task");
  const intent = need(v.intent, "--intent");
  const risk = v.risk ?? defaultRiskFor(task);
  if (!risk) fail(`no default risk for task type '${task}' — pass --risk explicitly`);

  const human = oneOf(v.human ?? "none", "--human", ["approve", "reject", "modify", "none"]);
  const wanted = oneOf(v.outcome ?? (v.defer ? "unresolved" : "success"), "--outcome", [
    "success",
    "failure",
    "reverted",
    "unresolved",
  ]);
  if (wanted === "unresolved" && !v.defer) fail("--outcome unresolved requires --defer <ISO date>");
  if (v.defer && wanted !== "unresolved") {
    fail("--defer seals UNRESOLVED; drop --outcome or set it to 'unresolved'");
  }

  // Phase verdicts the spine already produced. Verifier is mandatory; the
  // others may be 'skip' (phase did not run — records nothing for it).
  const phases: Cc10xPhaseSignal[] = [];
  const addPhase = (
    flag: string,
    value: string | undefined,
    phase: string,
    kind: "VERIFY" | "VALIDATE",
    confidence: number,
  ): void => {
    if (value === undefined || value === "skip") return;
    oneOf(value, flag, ["pass", "fail", "skip"]);
    phases.push({ phase, kind, pass: value === "pass", confidence });
  };
  oneOf(need(v.verifier, "--verifier"), "--verifier", ["pass", "fail"]);
  addPhase("--verifier", v.verifier, "verifier", "VERIFY", 1);
  addPhase("--hunter", v.hunter, "silent-failure-hunter", "VERIFY", 1);
  addPhase("--tests", v.tests, "tests", "VERIFY", 1);
  addPhase("--validate", v.validate, "test-honesty", "VALIDATE", 0.9);

  const policy = codingPolicy();
  const ledger = new FileLedger(ledgerPath);
  const decisions: Record<string, Decision> = {
    approve: "APPROVE",
    reject: "REJECT",
    modify: "MODIFY",
  };
  const handler: CheckpointHandler =
    human === "none"
      ? () => {
          throw new Error("unreachable: gate pre-check refused --human none");
        }
      : fixedCheckpoint(decisions[human], v.reviewer ?? "human");
  const bridge = new Cc10xRecede({ ledger, policy, checkpoint: handler });

  // Fail-closed honesty gate: the same pure gate() recordBuild will consult.
  const before = bridge.trustOf(actor, task);
  const g0 = gate(before, risk, policy);
  if (!g0.autonomous && human === "none") {
    console.error("GATE REFUSED — this lane requires a human checkpoint; nothing was recorded.");
    console.error(`  scope   (${actor}, ${task})  ${fmtTrust(before)}`);
    console.error(`  risk    ${risk}  altitude=${g0.altitude}`);
    console.error(`  reason  ${g0.reason}`);
    console.error(`  re-run with --human approve|reject|modify once a human has reviewed.`);
    process.exit(2);
  }

  const out = await bridge.recordBuild(
    { agent: actor, taskType: task, intent, risk, phases, deferUntil: v.defer },
    () => "recorded-by-cli",
  );
  const intentId = out.warrant.intent.id;
  let sealed: OutcomeResult = out.warrant.outcome?.result ?? "UNRESOLVED";
  let after = out.trust.after;
  let note = "";

  // The operator's ground truth may supersede the phase-derived seal.
  if (wanted === "reverted" && sealed !== "REVERTED") {
    ({ after } = bridge.reseal(intentId, "REVERTED", "operator-reported"));
    sealed = "REVERTED";
  } else if (wanted === "failure" && sealed === "SUCCESS") {
    ({ after } = bridge.reseal(intentId, "FAILURE", "operator-reported"));
    sealed = "FAILURE";
  } else if (wanted === "success" && sealed !== "SUCCESS" && sealed !== "UNRESOLVED") {
    note = " (evidence contradicts --outcome success; the seal follows the evidence)";
  }

  const review = out.checkpoint
    ? `FIRED(${out.checkpoint.altitude}) -> ${out.checkpoint.decision}`
    : "receded (no checkpoint required)";
  console.log(`warrant  ${intentId}`);
  console.log(
    `sealed   ${sealed}${v.defer ? `  deferred_until=${v.defer}` : ""}  review=${review}${note}`,
  );
  console.log(`trust    (${actor}, ${task})`);
  console.log(`         before ${fmtTrust(before)}`);
  console.log(`         after  ${fmtTrust(after)}`);
  console.log(`gate     next '${task}' @ ${risk}: ${posture(after, risk, policy)}`);
}

// ---------------------------------------------------------------------------
// reseal — flip a deferred/landed outcome once ground truth arrives
// ---------------------------------------------------------------------------

function cmdReseal(args: string[]): void {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      ledger: { type: "string" },
      warrant: { type: "string" },
      outcome: { type: "string" },
      source: { type: "string" },
    },
  });
  const ledgerPath = need(v.ledger, "--ledger");
  const ref = need(v.warrant, "--warrant");
  const outcome = oneOf(need(v.outcome, "--outcome"), "--outcome", ["reverted", "success"]);
  const source = need(v.source, "--source");

  const policy = codingPolicy();
  const ledger = new FileLedger(ledgerPath);
  const intentId = resolveIntentId(ledger, ref);
  const bridge = new Cc10xRecede({ ledger, policy });
  const result = outcome === "reverted" ? "REVERTED" : "SUCCESS";
  const { before, after } = bridge.reseal(intentId, result, source);

  const w = ledger.warrant(intentId);
  const scope = w ? `(${w.intent.actor}, ${w.intent.task_type})` : "(unknown scope)";
  console.log(`warrant  ${intentId}`);
  console.log(`resealed ${result}  source="${source}"`);
  console.log(`trust    ${scope}`);
  console.log(`         before ${fmtTrust(before)}`);
  console.log(`         after  ${fmtTrust(after)}`);
  if (w) {
    console.log(
      `gate     next '${w.intent.task_type}' @ ${w.intent.declared_risk}: ` +
        posture(after, w.intent.declared_risk, policy),
    );
  }
}

// ---------------------------------------------------------------------------
// status — read-only trust table + I2 replay-integrity check
// ---------------------------------------------------------------------------

function cmdStatus(args: string[]): void {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      ledger: { type: "string" },
      actor: { type: "string" },
      task: { type: "string" },
    },
  });
  const ledgerPath = need(v.ledger, "--ledger");
  const policy = codingPolicy();
  const ledger = new FileLedger(ledgerPath);

  // Every (actor, task-type) lane, in first-seen order.
  const seen = new Set<string>();
  const lanes: { actor: string; task: string }[] = [];
  for (const r of intentsIn(ledger)) {
    const key = `${r.actor} ${r.task_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (v.actor && r.actor !== v.actor) continue;
    if (v.task && r.task_type !== v.task) continue;
    lanes.push({ actor: r.actor, task: r.task_type });
  }
  if (lanes.length === 0) {
    console.log("no matching (actor, task-type) lanes in this ledger");
    return;
  }

  const wA = Math.max(5, ...lanes.map((l) => l.actor.length));
  const wT = Math.max(4, ...lanes.map((l) => l.task.length));
  console.log(
    `${"ACTOR".padEnd(wA)}  ${"TASK".padEnd(wT)}  TIER  SCORE  CONF   N    UPDATED                   I2`,
  );

  let ok = 0;
  for (const lane of lanes) {
    const stored = ledger.getTrust(lane.actor, lane.task) ?? coldStart(lane.actor, lane.task);
    const replayed = replay(lane.actor, lane.task, ledger.warrantsFor(lane.actor, lane.task), policy);
    const i2 =
      stored.tier === replayed.tier &&
      Math.abs(stored.score - replayed.score) < 1e-9 &&
      Math.abs(stored.confidence - replayed.confidence) < 1e-9 &&
      stored.sample_count === replayed.sample_count;
    if (i2) ok++;
    console.log(
      `${lane.actor.padEnd(wA)}  ${lane.task.padEnd(wT)}  ${stored.tier}    ` +
        `${stored.score.toFixed(3)}  ${stored.confidence.toFixed(3)}  ${String(stored.sample_count).padEnd(3)}  ` +
        `${(stored.updated ?? "-").padEnd(24)}  ${i2 ? "PASS" : "FAIL"}`,
    );
    const cells = RISK_ORDER.map((riskClass) => {
      const g = gate(stored, riskClass, policy);
      const never = policy.never_recede.includes(riskClass) ? ",never-recedes" : "";
      return `${riskClass}=${g.autonomous ? "autonomous" : `checkpoint(${g.altitude}${never})`}`;
    });
    console.log(`${"".padEnd(wA)}  gate: ${cells.join("  ")}`);
  }

  console.log(
    `I2 replay integrity: ${ok === lanes.length ? "PASS" : "FAIL"} — ` +
      `replay() == stored trust for ${ok}/${lanes.length} lanes (policy ${policy.id}@${policy.version})`,
  );
  if (ok !== lanes.length) process.exit(1);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const cmd = process.argv[2];
const rest = process.argv.slice(3);
try {
  if (cmd === "record") await cmdRecord(rest);
  else if (cmd === "reseal") cmdReseal(rest);
  else if (cmd === "status") cmdStatus(rest);
  else {
    console.error(USAGE);
    process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
  }
} catch (err) {
  // parseArgs throws on unknown/malformed flags; keep the exit path uniform.
  fail(err instanceof Error ? err.message : String(err));
}
