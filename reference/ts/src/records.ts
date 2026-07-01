// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The wire-agnostic data model: record types and their constructors.
 *
 * Every record is content-addressed — its `id` is the hash of its canonical
 * form (see hash.ts) — and carries an optional `prev` link. The ordered
 * sequence Intent -> Action -> Check* -> Outcome (with any Checkpoints) forms
 * one Warrant: an append-only, hash-linked evidence chain.
 */

import { contentId, digest } from "./hash.ts";

export type RecordKind = "INTENT" | "ACTION" | "CHECK" | "OUTCOME" | "CHECKPOINT";

/** Declared risk of an action. Reference taxonomy; an org MAY define its own. */
export type RiskClass = string;

export type CheckKind = "VERIFY" | "VALIDATE";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export type OutcomeResult = "SUCCESS" | "FAILURE" | "REVERTED" | "UNRESOLVED";
export type Decision = "APPROVE" | "REJECT" | "MODIFY" | "ESCALATE";

export interface BaseRecord {
  id: string;
  kind: RecordKind;
  prev?: string | null;
  actor: string;
  ts: string;
  /** Reserved; signature profile deferred (SPEC section 10). */
  sig?: string | null;
}

export interface IntentRecord extends BaseRecord {
  kind: "INTENT";
  task_type: string;
  inputs_digest: string;
  proposed_action: string;
  declared_risk: RiskClass;
  expected_effects: string[];
}

export interface ActionRecord extends BaseRecord {
  kind: "ACTION";
  intent_ref: string;
  operations: string[];
  result_digest: string;
}

export interface CheckRecord extends BaseRecord {
  kind: "CHECK";
  action_ref: string;
  check_kind: CheckKind;
  method: string;
  verdict: Verdict;
  confidence: number;
  evidence_refs: string[];
}

export interface OutcomeRecord extends BaseRecord {
  kind: "OUTCOME";
  warrant_ref: string;
  result: OutcomeResult;
  ground_truth_source: string;
  deferred_until?: string | null;
  human_touched: boolean;
}

export interface CheckpointRecord extends BaseRecord {
  kind: "CHECKPOINT";
  warrant_ref: string;
  reason: string;
  presented_evidence: string[];
  altitude: string;
  decision: Decision;
  reviewer: string;
  latency: number;
}

export type AnyRecord =
  | IntentRecord
  | ActionRecord
  | CheckRecord
  | OutcomeRecord
  | CheckpointRecord;

/**
 * A Warrant is the full evidence chain for one unit of work. Checkpoints are
 * kept alongside the linear intent->action->check*->outcome spine because they
 * are decision records that `update()` folds in, not part of the value chain.
 */
export interface Warrant {
  intent: IntentRecord;
  action?: ActionRecord;
  checks: CheckRecord[];
  checkpoints: CheckpointRecord[];
  outcome?: OutcomeRecord;
}

/** Finalize a record: stamp its content id (leaving prev/sig as provided). */
function seal<T extends Omit<BaseRecord, "id">>(rec: T): T & { id: string } {
  const id = contentId(rec as unknown as Record<string, unknown>);
  return { ...rec, id };
}

export interface OpenArgs {
  actor: string;
  task_type: string;
  proposed_action: string;
  declared_risk: RiskClass;
  expected_effects?: string[];
  inputs?: unknown;
  ts?: string;
}

/** open(): create the IntentRecord that begins a Warrant. */
export function open(args: OpenArgs): IntentRecord {
  return seal({
    kind: "INTENT",
    prev: null,
    actor: args.actor,
    ts: args.ts ?? new Date().toISOString(),
    task_type: args.task_type,
    inputs_digest: digest(args.inputs ?? null),
    proposed_action: args.proposed_action,
    declared_risk: args.declared_risk,
    expected_effects: args.expected_effects ?? [],
  }) as IntentRecord;
}

export interface ActArgs {
  intent: IntentRecord;
  operations: string[];
  result: unknown;
  ts?: string;
}

/** act(): record what the agent actually did, linked to its intent. */
export function act(args: ActArgs): ActionRecord {
  return seal({
    kind: "ACTION",
    prev: args.intent.id,
    actor: args.intent.actor,
    ts: args.ts ?? new Date().toISOString(),
    intent_ref: args.intent.id,
    operations: args.operations,
    result_digest: digest(args.result ?? null),
  }) as ActionRecord;
}

export interface CheckArgs {
  action: ActionRecord;
  check_kind: CheckKind;
  method: string;
  verdict: Verdict;
  confidence: number;
  evidence_refs?: string[];
  prev?: string;
  ts?: string;
}

/** check(): a typed V&V step over an action. */
export function check(args: CheckArgs): CheckRecord {
  if (args.confidence < 0 || args.confidence > 1) {
    throw new RangeError("check confidence must be in [0,1]");
  }
  return seal({
    kind: "CHECK",
    prev: args.prev ?? args.action.id,
    actor: args.action.actor,
    ts: args.ts ?? new Date().toISOString(),
    action_ref: args.action.id,
    check_kind: args.check_kind,
    method: args.method,
    verdict: args.verdict,
    confidence: args.confidence,
    evidence_refs: args.evidence_refs ?? [],
  }) as CheckRecord;
}

export interface CheckpointArgs {
  warrant_ref: string;
  actor: string;
  reason: string;
  presented_evidence?: string[];
  altitude: string;
  decision: Decision;
  reviewer: string;
  latency?: number;
  prev?: string;
  ts?: string;
}

/** checkpoint(): a human decision record. */
export function checkpoint(args: CheckpointArgs): CheckpointRecord {
  return seal({
    kind: "CHECKPOINT",
    prev: args.prev ?? args.warrant_ref,
    actor: args.actor,
    ts: args.ts ?? new Date().toISOString(),
    warrant_ref: args.warrant_ref,
    reason: args.reason,
    presented_evidence: args.presented_evidence ?? [],
    altitude: args.altitude,
    decision: args.decision,
    reviewer: args.reviewer,
    latency: args.latency ?? 0,
  }) as CheckpointRecord;
}

export interface SealArgs {
  warrant_ref: string;
  actor: string;
  result: OutcomeResult;
  ground_truth_source: string;
  deferred_until?: string | null;
  human_touched?: boolean;
  prev?: string;
  ts?: string;
}

/** seal(): finalize a Warrant with an Outcome (possibly deferred). */
export function sealOutcome(args: SealArgs): OutcomeRecord {
  return seal({
    kind: "OUTCOME",
    prev: args.prev ?? args.warrant_ref,
    actor: args.actor,
    ts: args.ts ?? new Date().toISOString(),
    warrant_ref: args.warrant_ref,
    result: args.result,
    ground_truth_source: args.ground_truth_source,
    deferred_until: args.deferred_until ?? null,
    human_touched: args.human_touched ?? false,
  }) as OutcomeRecord;
}
