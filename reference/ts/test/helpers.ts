// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  act,
  makeCheckRecord,
  checkpoint,
  open,
  seal,
  type CheckKind,
  type Decision,
  type OutcomeResult,
  type RiskClass,
  type Verdict,
  type Warrant,
} from "../src/index.ts";

let clockN = 0;
export function resetClock() {
  clockN = 0;
}
export function tick(): string {
  return new Date(1_700_000_000_000 + clockN++ * 1000).toISOString();
}

export interface BuildOpts {
  actor?: string;
  task_type?: string;
  risk?: RiskClass;
  checks?: { kind: CheckKind; verdict: Verdict; confidence: number }[];
  result?: OutcomeResult;
  decision?: Decision;
  reviewer?: string;
}

/** Build a complete sealed Warrant for a scope, deterministically. */
export function buildWarrant(o: BuildOpts = {}): Warrant {
  const actor = o.actor ?? "bot";
  const task_type = o.task_type ?? "x";
  const intent = open({
    actor,
    task_type,
    proposed_action: "do a thing",
    declared_risk: o.risk ?? "reversible.low",
    ts: tick(),
  });
  const action = act({ intent, operations: ["op"], result: { ok: true }, ts: tick() });
  const checks = (o.checks ?? []).map((c) =>
    makeCheckRecord({
      action,
      check_kind: c.kind,
      method: "m",
      verdict: c.verdict,
      confidence: c.confidence,
      ts: tick(),
    }),
  );
  const checkpoints = o.decision
    ? [
        checkpoint({
          warrant_ref: intent.id,
          actor,
          reason: "test",
          altitude: "full",
          decision: o.decision,
          reviewer: o.reviewer ?? "human",
          ts: tick(),
        }),
      ]
    : [];
  const outcome = o.result
    ? seal({
        warrant_ref: intent.id,
        actor,
        result: o.result,
        ground_truth_source: "test",
        human_touched: checkpoints.length > 0,
        ts: tick(),
      })
    : undefined;
  return { intent, action, checks, checkpoints, outcome };
}

/** A clean positive warrant: VERIFY+VALIDATE PASS, SUCCESS. */
export function cleanSuccess(overrides: BuildOpts = {}): Warrant {
  return buildWarrant({
    checks: [
      { kind: "VERIFY", verdict: "PASS", confidence: 1 },
      { kind: "VALIDATE", verdict: "PASS", confidence: 0.9 },
    ],
    result: "SUCCESS",
    ...overrides,
  });
}
