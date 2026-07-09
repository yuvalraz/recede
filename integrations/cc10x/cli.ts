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
 *                      [--mode record-only|advisory]
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
import { existsSync, readFileSync } from "node:fs";
import {
  FileLedger,
  coldStart,
  fixedCheckpoint,
  gate,
  policyDigest,
  REF_WEIGHTING_V02,
  referencePolicyV02,
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
                     [--mode record-only|advisory]   (default: record-only)

staged adoption (--mode):
  record-only  seal + fold + putTrust; the fail-closed honesty gate on
               '--human none' applies (it protects the ledger, not enforcement)
  advisory     record-only PLUS print the gate decision ("advisory: gate
               would ...") without changing behavior
  gated        NOT a recorder mode — enforcement happens BEFORE the action, as
               a future pre-action 'recede-cc10x gate' consult (exit codes
               usable as a required status check)
  never_recede lanes keep a human checkpoint in EVERY mode.
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
      mode: { type: "string" },
    },
  });

  const ledgerPath = need(v.ledger, "--ledger");
  const actor = need(v.actor, "--actor");
  const task = need(v.task, "--task");
  const intent = need(v.intent, "--intent");
  const risk = v.risk ?? defaultRiskFor(task);
  if (!risk) fail(`no default risk for task type '${task}' — pass --risk explicitly`);

  const human = oneOf(v.human ?? "none", "--human", ["approve", "reject", "modify", "none"]);
  // Staged adoption (P3.2 mode-taxonomy amendment). Two recorder modes only:
  // the honesty gate on '--human none' binds in BOTH (it protects the ledger,
  // it is not enforcement); 'advisory' only ADDS a printed gate decision.
  // 'gated' was DELETED: this CLI records post-merge, so there is nothing left
  // to block — enforcement belongs to a future pre-action consult. never_recede
  // floors live in the pure gate() itself, so they bind in every mode.
  const modeRaw = v.mode ?? "record-only";
  if (modeRaw === "gated") {
    fail(
      "--mode gated was removed — record time is post-merge; there is nothing left to block. " +
        "The gated stage ships as a pre-action 'recede-cc10x gate' consult (exit codes usable " +
        "as a required status check). Use --mode record-only|advisory.",
    );
  }
  const mode = oneOf(modeRaw, "--mode", ["record-only", "advisory"]);
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

  // Sidecar-aware (no policy split-brain): a backfilled ledger's forward
  // records fold under the SAME policy the ledger was folded with.
  const policy = ledgerPolicy(ledgerPath);
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
  if (mode === "advisory") {
    console.log(
      `advisory: gate would ${g0.autonomous ? "AUTONOMOUS" : `CHECKPOINT(${g0.altitude})`} — ${g0.reason}`,
    );
  }
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

  // Sidecar-aware (no policy split-brain): resealing a backfilled ledger under
  // v0.1 would store a v0.1-replayed trust that the v0.2-aware status reads as
  // a FALSE I2 FAIL. Replay under the policy the ledger was folded with.
  const policy = ledgerPolicy(ledgerPath);
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

/**
 * The fold policy a ledger operates under (decision-5/6 reconciliation).
 * A backfill persists its fold policy as a `<ledger>.policy.json` SIDECAR
 * (`recede-ledger-policy/1`) — the FileLedger line format has no foreign-line
 * tolerance, so an in-ledger tag would require a kernel change; the sidecar is
 * additive and self-describing. Consulted by record, reseal, AND status so the
 * fold, the re-fold, and the verification all use ONE policy (no split-brain).
 * If present, the policy is reconstructed via the audited `referencePolicyV02`
 * and the persisted digest is REQUIRED and verified (absent or mismatched ->
 * fail loud; backfill always writes it). Absent sidecar -> the v0.1 coding
 * policy, byte-identical to the pre-P3.2 behavior.
 */
function ledgerPolicy(ledgerPath: string): Policy {
  const sidecarPath = `${ledgerPath}.policy.json`;
  if (!existsSync(sidecarPath)) return codingPolicy();
  const raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
    schema?: string;
    weighting?: string;
    evidence_weights?: Policy["evidence_weights"];
    policy_digest?: string;
  };
  if (raw.schema !== "recede-ledger-policy/1") {
    fail(`unrecognized policy sidecar schema '${raw.schema}' in ${sidecarPath}`);
  }
  if (raw.weighting !== REF_WEIGHTING_V02) {
    fail(
      `policy sidecar weighting '${raw.weighting}' is not reconstructible ` +
        `(expected '${REF_WEIGHTING_V02}') in ${sidecarPath}`,
    );
  }
  const policy = referencePolicyV02(raw.evidence_weights ?? {});
  if (raw.policy_digest === undefined) {
    fail(
      `policy sidecar ${sidecarPath} carries no policy_digest — refusing an unpinned ` +
        `policy (backfill always writes one)`,
    );
  }
  if (policyDigest(policy) !== raw.policy_digest) {
    fail(
      `policy sidecar digest mismatch in ${sidecarPath} — the persisted weights do not ` +
        `reconstruct the policy this ledger claims it was folded under`,
    );
  }
  return policy;
}

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
  const policy = ledgerPolicy(ledgerPath);
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
