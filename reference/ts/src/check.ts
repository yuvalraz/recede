// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The ergonomic check builders: check.verify and check.validate.
 *
 * Verify = "did it do the thing right" (schema, tests) — a sync boolean-ish
 * predicate. Validate = "did it do the *right* thing" (intent, policy) — an
 * async judgement returning {ok, confidence}. Keeping them split is the
 * first-class V&V distinction from the SPEC; conflating them is how
 * confidently-wrong output slips through.
 */

import type { CheckKind, Verdict } from "./records.ts";

/** The runtime context a check sees: intent + input + the step's output. */
export interface CheckContext<I = unknown, O = unknown> {
  intent: string;
  input: I;
  output: O;
}

/** A resolved check result, pre-record. */
export interface CheckResult {
  name: string;
  check_kind: CheckKind;
  verdict: Verdict;
  confidence: number;
  evidence_refs: string[];
}

/** A declarative check the caller passes to run(). */
export interface CheckSpec<I = unknown, O = unknown> {
  name: string;
  check_kind: CheckKind;
  run(ctx: CheckContext<I, O>): Promise<CheckResult> | CheckResult;
}

/**
 * check.verify(name, fn): a synchronous "did-it-right" predicate. A truthy
 * return is PASS at full confidence; falsy is FAIL; a thrown error is
 * INCONCLUSIVE (the check itself could not run).
 */
function verify<I = unknown, O = unknown>(
  name: string,
  fn: (ctx: CheckContext<I, O>) => boolean | Promise<boolean>,
): CheckSpec<I, O> {
  return {
    name,
    check_kind: "VERIFY",
    async run(ctx) {
      try {
        const ok = await fn(ctx);
        return {
          name,
          check_kind: "VERIFY",
          verdict: ok ? "PASS" : "FAIL",
          confidence: 1,
          evidence_refs: [],
        };
      } catch {
        return {
          name,
          check_kind: "VERIFY",
          verdict: "INCONCLUSIVE",
          confidence: 0,
          evidence_refs: [],
        };
      }
    },
  };
}

/**
 * check.validate(name, fn): an async "did-the-right-thing" judgement returning
 * {ok, confidence}. Used for policy/intent judges (e.g. an LLM-as-judge). A
 * thrown error is INCONCLUSIVE.
 */
function validate<I = unknown, O = unknown>(
  name: string,
  fn: (
    ctx: CheckContext<I, O>,
  ) => Promise<{ ok: boolean; confidence: number }> | { ok: boolean; confidence: number },
): CheckSpec<I, O> {
  return {
    name,
    check_kind: "VALIDATE",
    async run(ctx) {
      try {
        const { ok, confidence } = await fn(ctx);
        return {
          name,
          check_kind: "VALIDATE",
          verdict: ok ? "PASS" : "FAIL",
          confidence: Math.max(0, Math.min(1, confidence)),
          evidence_refs: [],
        };
      } catch {
        return {
          name,
          check_kind: "VALIDATE",
          verdict: "INCONCLUSIVE",
          confidence: 0,
          evidence_refs: [],
        };
      }
    },
  };
}

export const check = { verify, validate };
