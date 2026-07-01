// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The checkpoint surface: the human decision point.
 *
 * The protocol defines `altitude` + `presented_evidence`; the rendering is out
 * of scope (SPEC section 10). This module ships the one reference surface — a
 * CLI/stdio prompt — plus an auto surface for tests. A CheckpointHandler is any
 * async function that, given a presentation, returns a human decision.
 */

import { createInterface } from "node:readline";
import type { Decision, GateDecisionLike } from "./types.ts";

/** What the human is shown at a checkpoint. */
export interface CheckpointPresentation {
  actor: string;
  task_type: string;
  proposed_action: string;
  declared_risk: string;
  altitude: string;
  reason: string;
  /** Evidence record ids gathered so far (intent, action, checks). */
  presented_evidence: string[];
  /** Human-readable lines describing the evidence (altitude-dependent). */
  detail: string[];
}

export interface HumanDecision {
  decision: Decision;
  reviewer: string;
  /** Present when the human MODIFYs the proposed result. */
  modified_result?: unknown;
  /** Seconds spent — the fatigue signal. Filled by the caller if omitted. */
  latency?: number;
}

export type CheckpointHandler = (
  p: CheckpointPresentation,
) => Promise<HumanDecision> | HumanDecision;

/**
 * The reference CLI checkpoint surface. Renders the presentation to stderr and
 * reads a single-character decision from stdin. Only shows detail lines when
 * the altitude asks for it ("full"); "brief" shows just the headline — the
 * receding-oversight ergonomic (less to read as trust grows).
 */
export function consoleCheckpoint(
  opts: { reviewer?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): CheckpointHandler {
  const reviewer = opts.reviewer ?? "cli-reviewer";
  const output = opts.output ?? process.stderr;
  const input = opts.input ?? process.stdin;

  return async (p: CheckpointPresentation): Promise<HumanDecision> => {
    const w = (s: string) => output.write(s + "\n");
    w("");
    w("=== RECEDE CHECKPOINT ===================================");
    w(`scope   : (${p.actor}, ${p.task_type})`);
    w(`risk    : ${p.declared_risk}   altitude: ${p.altitude}`);
    w(`reason  : ${p.reason}`);
    w(`propose : ${p.proposed_action}`);
    if (p.altitude === "full") {
      for (const line of p.detail) w("  " + line);
      w(`evidence: ${p.presented_evidence.join(", ")}`);
    }
    w("decision [a=approve r=reject m=modify e=escalate] > ");

    const start = Date.now();
    const rl = createInterface({ input, output: undefined as never, terminal: false });
    const answer: string = await new Promise((resolve) => {
      rl.once("line", (l) => resolve(l.trim().toLowerCase()));
    });
    rl.close();
    const latency = (Date.now() - start) / 1000;

    const decision: Decision =
      answer.startsWith("a") ? "APPROVE"
      : answer.startsWith("r") ? "REJECT"
      : answer.startsWith("m") ? "MODIFY"
      : answer.startsWith("e") ? "ESCALATE"
      : "REJECT"; // fail-closed: an unrecognized answer does not approve.

    return { decision, reviewer, latency };
  };
}

/**
 * A non-interactive handler for tests/automation. Always returns the same
 * decision. `autoApprove()` is the common case.
 */
export function fixedCheckpoint(
  decision: Decision,
  reviewer = "auto",
  modified_result?: unknown,
): CheckpointHandler {
  return () => ({ decision, reviewer, modified_result, latency: 0 });
}

export const autoApprove = (reviewer = "auto"): CheckpointHandler =>
  fixedCheckpoint("APPROVE", reviewer);

// Re-export so callers can build presentations without importing gate.ts.
export type { GateDecisionLike };
