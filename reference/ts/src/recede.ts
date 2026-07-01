// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The Recede class — the ergonomic front door over the eight core operations.
 *
 * r.run(fn, opts) wraps a function the caller already has. It: opens an Intent,
 * runs the PURE gate over current trust, fires a Checkpoint iff the gate demands
 * one, executes the function (or the human-edited value on MODIFY), records the
 * Action and the V&V Checks, seals the Outcome, and folds the Warrant through
 * the PURE update() reducer. The gate is IMPLICIT: there is no `if (approval)`
 * in caller code — run() decides, replayably.
 */

import {
  act,
  check as mkCheck,
  checkpoint as mkCheckpoint,
  open as mkOpen,
  sealOutcome,
  type ActionRecord,
  type CheckRecord,
  type CheckpointRecord,
  type IntentRecord,
  type OutcomeRecord,
  type OutcomeResult,
  type RiskClass,
  type Warrant,
} from "./records.ts";
import type { CheckContext, CheckSpec } from "./check.ts";
import { gate, type GateDecision } from "./gate.ts";
import { defaultPolicy, type Policy } from "./policy.ts";
import { coldStart, update, type TrustState } from "./trust.ts";
import type { Ledger } from "./ledger.ts";
import { MemoryLedger } from "./ledger.ts";
import type { CheckpointHandler, HumanDecision } from "./checkpoint.ts";
import { autoApprove } from "./checkpoint.ts";

export interface RecedeConfig {
  ledger?: Ledger;
  checkpoint?: CheckpointHandler;
  policy?: Policy;
  /** Injectable clock — pure/testable. Defaults to Date.now via new Date(). */
  now?: () => string;
}

export interface RunOptions<I = unknown, O = unknown> {
  actor: string;
  taskType: string;
  intent: string;
  risk: RiskClass;
  checks?: CheckSpec<I, O>[];
  input?: I;
  expectedEffects?: string[];
  operations?: string[];
  /** Ground-truth source label for the sealed outcome. */
  groundTruth?: string;
  /** When set, the outcome is sealed UNRESOLVED with this deferral window. */
  deferUntil?: string;
}

export interface RunResult<O = unknown> {
  result: O;
  trust: { before: TrustState; after: TrustState; delta: number };
  checkpoint?: CheckpointRecord;
  gateDecision: GateDecision;
  warrant: Warrant;
}

export class Recede {
  readonly ledger: Ledger;
  private readonly handler: CheckpointHandler;
  readonly policy: Policy;
  private readonly clock: () => string;

  constructor(config: RecedeConfig = {}) {
    this.ledger = config.ledger ?? new MemoryLedger();
    this.handler = config.checkpoint ?? autoApprove();
    this.policy = config.policy ?? defaultPolicy();
    this.clock = config.now ?? (() => new Date().toISOString());
  }

  /** Current standing for a scope (last snapshot, else cold start). */
  trustOf(actor: string, taskType: string): TrustState {
    return this.ledger.getTrust(actor, taskType) ?? coldStart(actor, taskType);
  }

  // ---- the eight core ops, exposed directly ----

  open = mkOpen;
  gate = (trust: TrustState, risk: RiskClass, policy: Policy = this.policy) =>
    gate(trust, risk, policy);
  act = act;
  check = mkCheck;
  checkpoint = mkCheckpoint;
  seal = sealOutcome;
  update = (
    prev: TrustState,
    warrant: Warrant,
    opts?: { idle_ms?: number; drift?: number; now?: string },
  ) => update(prev, warrant, this.policy, opts);

  /**
   * The ergonomic front door. Wrap a function; run() drives the full lifecycle.
   */
  async run<O = unknown, I = unknown>(
    fn: () => O | Promise<O>,
    opts: RunOptions<I, O>,
  ): Promise<RunResult<O>> {
    const before = this.trustOf(opts.actor, opts.taskType);

    // 1. open(): the Intent record begins the Warrant.
    const intent: IntentRecord = mkOpen({
      actor: opts.actor,
      task_type: opts.taskType,
      proposed_action: opts.intent,
      declared_risk: opts.risk,
      expected_effects: opts.expectedEffects,
      inputs: opts.input,
      ts: this.clock(),
    });
    this.ledger.append(intent);

    // 2. gate(): PURE decision over CURRENT trust.
    const gateDecision = gate(before, opts.risk, this.policy);

    // 3. Checkpoint iff the gate demands one — the human decision point.
    let cp: CheckpointRecord | undefined;
    let humanDecision: HumanDecision | undefined;
    if (!gateDecision.autonomous) {
      const presentation = {
        actor: opts.actor,
        task_type: opts.taskType,
        proposed_action: opts.intent,
        declared_risk: opts.risk,
        altitude: gateDecision.altitude ?? "full",
        reason: gateDecision.reason,
        presented_evidence: [intent.id],
        detail: [
          `proposed: ${opts.intent}`,
          `expected effects: ${(opts.expectedEffects ?? []).join("; ") || "(none)"}`,
        ],
      };
      humanDecision = await this.handler(presentation);
      cp = mkCheckpoint({
        warrant_ref: intent.id,
        actor: opts.actor,
        reason: gateDecision.reason,
        presented_evidence: presentation.presented_evidence,
        altitude: presentation.altitude,
        decision: humanDecision.decision,
        reviewer: humanDecision.reviewer,
        latency: humanDecision.latency ?? 0,
        ts: this.clock(),
      });
      this.ledger.append(cp);
    }

    // A REJECT / ESCALATE aborts execution: seal FAILURE/UNRESOLVED, fold, return.
    if (humanDecision?.decision === "REJECT" || humanDecision?.decision === "ESCALATE") {
      const result: OutcomeResult =
        humanDecision.decision === "ESCALATE" ? "UNRESOLVED" : "FAILURE";
      const outcome = sealOutcome({
        warrant_ref: intent.id,
        actor: opts.actor,
        result,
        ground_truth_source: opts.groundTruth ?? "human-checkpoint",
        deferred_until: humanDecision.decision === "ESCALATE" ? (opts.deferUntil ?? this.clock()) : null,
        human_touched: true,
        prev: cp?.id ?? intent.id,
        ts: this.clock(),
      });
      this.ledger.append(outcome);
      const warrant: Warrant = { intent, checks: [], checkpoints: cp ? [cp] : [], outcome };
      const { state: after } = update(before, warrant, this.policy, { now: this.clock() });
      this.ledger.putTrust(after);
      return {
        result: undefined as O,
        trust: { before, after, delta: after.score - before.score },
        checkpoint: cp,
        gateDecision,
        warrant,
      };
    }

    // 4. Execute the wrapped function — or take the human-edited value on MODIFY.
    let result: O;
    if (humanDecision?.decision === "MODIFY" && "modified_result" in humanDecision) {
      result = humanDecision.modified_result as O;
    } else {
      result = await fn();
    }

    // 5. act(): record what actually happened.
    const action: ActionRecord = act({
      intent,
      operations: opts.operations ?? [opts.intent],
      result,
      ts: this.clock(),
    });
    this.ledger.append(action);

    // 6. check(): run each V&V spec, record a CheckRecord per result.
    const ctx: CheckContext<I, O> = {
      intent: opts.intent,
      input: opts.input as I,
      output: result,
    };
    const checkRecords: CheckRecord[] = [];
    for (const spec of opts.checks ?? []) {
      const res = await spec.run(ctx);
      const rec = mkCheck({
        action,
        check_kind: res.check_kind,
        method: res.name,
        verdict: res.verdict,
        confidence: res.confidence,
        evidence_refs: res.evidence_refs,
        ts: this.clock(),
      });
      this.ledger.append(rec);
      checkRecords.push(rec);
    }

    // 7. seal(): finalize the outcome. SUCCESS unless a check FAILed, in which
    //    case FAILURE; deferred outcomes are sealed UNRESOLVED.
    const anyFail = checkRecords.some((c) => c.verdict === "FAIL");
    let result_status: OutcomeResult;
    if (opts.deferUntil) result_status = "UNRESOLVED";
    else if (anyFail) result_status = "FAILURE";
    else result_status = "SUCCESS";

    const outcome: OutcomeRecord = sealOutcome({
      warrant_ref: intent.id,
      actor: opts.actor,
      result: result_status,
      ground_truth_source: opts.groundTruth ?? (result_status === "UNRESOLVED" ? "deferred" : "immediate-checks"),
      deferred_until: opts.deferUntil ?? null,
      human_touched: humanDecision !== undefined,
      prev: checkRecords[checkRecords.length - 1]?.id ?? action.id,
      ts: this.clock(),
    });
    this.ledger.append(outcome);

    // 8. update(): PURE reducer folds the Warrant into next trust.
    const warrant: Warrant = {
      intent,
      action,
      checks: checkRecords,
      checkpoints: cp ? [cp] : [],
      outcome,
    };
    const { state: after } = update(before, warrant, this.policy, { now: this.clock() });
    this.ledger.putTrust(after);

    return {
      result,
      trust: { before, after, delta: after.score - before.score },
      checkpoint: cp,
      gateDecision,
      warrant,
    };
  }

  /**
   * Re-seal a deferred (UNRESOLVED) Warrant when ground truth arrives, then
   * re-fold so late-arriving negative evidence feeds back (SPEC section 6).
   * Returns the re-folded trust. Uses full replay so the result stays I2-exact.
   */
  reseal(
    intentId: string,
    result: Exclude<OutcomeResult, "UNRESOLVED">,
    ground_truth_source: string,
  ): { before: TrustState; after: TrustState; outcome: OutcomeRecord } {
    const w = this.ledger.warrant(intentId);
    if (!w) throw new Error(`no warrant for intent ${intentId}`);
    const before = this.trustOf(w.intent.actor, w.intent.task_type);

    const outcome = sealOutcome({
      warrant_ref: intentId,
      actor: w.intent.actor,
      result,
      ground_truth_source,
      deferred_until: null,
      human_touched: w.checkpoints.length > 0,
      prev: w.outcome?.id ?? intentId,
      ts: this.clock(),
    });
    this.ledger.append(outcome);

    // Re-fold via full replay so the new outcome supersedes the UNRESOLVED one.
    const after = this.replay(w.intent.actor, w.intent.task_type);
    this.ledger.putTrust(after);
    return { before, after, outcome };
  }

  /**
   * replay(): PURE reconstruction of trust for a scope from stored Warrants +
   * this policy. MUST equal the incrementally-stored state (I2).
   */
  replay(actor: string, taskType: string): TrustState {
    const warrants = this.ledger.warrantsFor(actor, taskType);
    let state = coldStart(actor, taskType);
    for (const w of warrants) {
      state = update(state, w, this.policy).state;
    }
    return state;
  }
}
