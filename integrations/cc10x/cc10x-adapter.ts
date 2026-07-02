// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Recede <- CC10X reference integration (a PATTERN, not a fork of CC10X).
 *
 * CC10X is an external verification spine: it already runs an independent
 * verifier, a parallel silent-failure-hunter, REVERT / test-honesty gates, and
 * a human review before "done". This adapter does NOT reimplement any of that.
 * It MAPS CC10X's existing phase outcomes onto Recede's evidence model so that:
 *
 *   - each CC10X phase result becomes a VERIFY or VALIDATE Check,
 *   - the phase sequence seals into one Warrant per unit of agent work,
 *   - trust accrues per (agent, task_type) — the Actor is the specific runner,
 *   - and CC10X's human-review checkpoint RECEDES once that (agent, task_type)
 *     has earned it, and SNAPS BACK on a REVERT.
 *
 * You feed it phase signals you already compute; it feeds Recede. That is the
 * whole seam. CC10X owns the PROCESS; Recede owns the memory + the receding gate
 * (gate/update/replay stay pure and unmodified). The relative import into the
 * reference source keeps this runnable with zero install; a published consumer
 * would import "recede" instead.
 */

import {
  Recede,
  MemoryLedger,
  check,
  defaultPolicy,
  type CheckSpec,
  type CheckpointHandler,
  type Ledger,
  type OutcomeResult,
  type Policy,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// CC10X-side vocabulary (the overlay's inputs)
// ---------------------------------------------------------------------------

/** The coding task types the default policy scopes trust by. */
export type CodingTaskType =
  | "code.fix"
  | "code.feature"
  | "code.migrate"
  | "release.publish"
  | "docs.write";

/**
 * Conservative default RiskClass per coding task type, used when a caller does
 * not declare a risk explicitly. `release.publish` and `code.migrate` map onto
 * `irreversible.critical`, which the policy pins into `never_recede` (I3):
 * those lanes keep a human checkpoint at every trust tier. A caller MAY
 * override per unit of work (e.g. a reversible migration *prep* step can
 * declare "reversible.low"); the never-recede floor still binds whatever risk
 * is actually declared.
 */
export const DEFAULT_TASK_RISK: Record<CodingTaskType, string> = {
  "code.fix": "reversible.low",
  "code.feature": "reversible.low",
  "code.migrate": "irreversible.critical",
  "release.publish": "irreversible.critical",
  "docs.write": "reversible.low",
};

/** Default risk for a task type; undefined for unknown types (caller decides). */
export function defaultRiskFor(taskType: string): string | undefined {
  return (DEFAULT_TASK_RISK as Record<string, string | undefined>)[taskType];
}

/**
 * A single CC10X phase outcome, as the spine already reports it. Did-it-right
 * gates (verifier, silent-failure-hunter, build) map to VERIFY; did-the-right-
 * thing gates (test-honesty, human review) map to VALIDATE.
 */
export interface Cc10xPhaseSignal {
  /** e.g. "verifier", "silent-failure-hunter", "test-honesty", "review". */
  phase: string;
  kind: "VERIFY" | "VALIDATE";
  /** The phase's own verdict. false = the phase failed / found a problem. */
  pass: boolean;
  /** The phase's own confidence in that verdict, [0,1]. */
  confidence: number;
}

/** The result of one CC10X build unit, ready to fold into Recede. */
export interface Cc10xBuildInput {
  /** The specific harness/runner acting. This IS the Recede Actor. */
  agent: string;
  /** Namespaced class of work. */
  taskType: CodingTaskType | string;
  /** One-line statement of what the agent proposed to do. */
  intent: string;
  /** Recede RiskClass; small fixes are typically "reversible.low". */
  risk: string;
  /** The ordered phase signals CC10X produced for this unit. */
  phases: Cc10xPhaseSignal[];
  /**
   * When set, the outcome seals UNRESOLVED with this deferral window and is
   * re-sealed later via `reseal()` once ground truth arrives (SPEC section 6).
   */
  deferUntil?: string;
}

// ---------------------------------------------------------------------------
// The default coding policy
// ---------------------------------------------------------------------------

/**
 * The default coding policy: the Recede reference policy (matrix + weighting
 * unchanged) with a coding-flavored id/version. The reference policy already
 * pins `irreversible.critical` into never_recede — which is exactly the
 * "never recede for schema / prod-deploy" rule this adapter wants — so no matrix
 * surgery is needed. Map such changes onto `irreversible.critical` in `risk`.
 * Kept as a function so the pure gate always sees a fresh, digest-stable Policy.
 */
export function codingPolicy(): Policy {
  return { ...defaultPolicy(), id: "recede.cc10x.coding", version: "0.1.0" };
}

// ---------------------------------------------------------------------------
// Phase signals -> Recede checks
// ---------------------------------------------------------------------------

/**
 * Translate CC10X phase signals into Recede check specs. Each check closes over
 * the reported verdict — CC10X already ran the analysis; the adapter records
 * verdicts, it does not re-derive them.
 */
export function phasesToChecks(phases: Cc10xPhaseSignal[]): CheckSpec[] {
  return phases.map((p) =>
    p.kind === "VERIFY"
      ? check.verify(`cc10x:${p.phase}`, () => p.pass)
      : check.validate(`cc10x:${p.phase}`, () => ({ ok: p.pass, confidence: p.confidence })),
  );
}

// ---------------------------------------------------------------------------
// The adapter front door
// ---------------------------------------------------------------------------

/**
 * A CC10X-facing wrapper over a Recede instance. One `recordBuild` call per
 * CC10X build unit; the human-review checkpoint fires only when the gate says
 * so — i.e. it RECEDES as (agent, task_type) earns trust, and SNAPS BACK on a
 * `revert()`.
 */
export class Cc10xRecede {
  private readonly r: Recede;

  constructor(opts: { checkpoint?: CheckpointHandler; ledger?: Ledger; policy?: Policy; now?: () => string } = {}) {
    this.r = new Recede({
      ledger: opts.ledger ?? new MemoryLedger(),
      policy: opts.policy ?? codingPolicy(),
      // The checkpoint IS CC10X's human review before "done". Recede decides
      // whether it fires at all; CC10X supplies the review surface.
      checkpoint: opts.checkpoint,
      now: opts.now,
    });
  }

  /** Current standing for one (agent, task-type) scope. */
  trustOf(agent: string, taskType: CodingTaskType | string) {
    return this.r.trustOf(agent, taskType);
  }

  /**
   * Fold one CC10X build unit into Recede. `apply` is the CC10X "ship the diff"
   * step you already have; Recede wraps it so the human gate can recede. Returns
   * the full RunResult — `out.checkpoint` is defined iff human review fired.
   */
  async recordBuild<O>(build: Cc10xBuildInput, apply: () => O | Promise<O>) {
    return this.r.run(apply, {
      actor: build.agent,
      taskType: build.taskType,
      intent: build.intent,
      risk: build.risk,
      checks: phasesToChecks(build.phases),
      operations: build.phases.map((p) => `${p.phase}:${p.pass ? "PASS" : "FAIL"}`),
      groundTruth: "cc10x-phases",
      deferUntil: build.deferUntil,
    });
  }

  /**
   * Re-seal a previously recorded build when ground truth arrives: a deferred
   * (UNRESOLVED) outcome lands, or a shipped diff is later confirmed/overturned.
   * Appends a superseding Outcome and re-folds via pure replay — so the trust
   * move is fully reconstructable (I2). Uses the sealed intent id from a prior
   * recordBuild's warrant.
   */
  reseal(intentId: string, result: Exclude<OutcomeResult, "UNRESOLVED">, groundTruthSource: string) {
    return this.r.reseal(intentId, result, groundTruthSource);
  }

  /**
   * A CC10X REVERT is negative evidence, often late-arriving. Feed it back so
   * trust drops fast and the human gate snaps back on the NEXT build of this
   * scope.
   */
  revert(intentId: string) {
    return this.reseal(intentId, "REVERTED", "cc10x-revert");
  }
}
