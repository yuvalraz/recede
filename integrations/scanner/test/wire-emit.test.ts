// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.2 — wire emitter output shape + the A4 gate + no-committed-magnitude
 * (red-team rule 1). `emitPolicyTs` round-trips through `referencePolicyV02`
 * (a malformed / out-of-range policy fails loud BEFORE emit); the emitted
 * module is real TS (imported back and digest-compared). `emitCheckAdapters`
 * carries evClass/provTier/locator VERBATIM into hash-covered evRefs.
 * `emitRecordWorkflow` is SHA-pinned, least-privilege, ledger-branch-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEvRef,
  policyDigest,
  referencePolicyV02,
  type CheckSpec,
  type Policy,
} from "../../../reference/ts/src/index.ts";
import type { EvidenceMapEntry } from "../scanner.ts";
import { emitPolicyTs, emitCheckAdapters, emitRecordWorkflow } from "../wire.ts";

// Absolute specifier the emitted temp modules can import the reference from.
const REF_INDEX = join(import.meta.dirname, "../../../reference/ts/src/index.ts");

// ---------------------------------------------------------------------------
// emitPolicyTs
// ---------------------------------------------------------------------------

test("emitPolicyTs: emitted module round-trips to the same policy digest", async () => {
  const policy = referencePolicyV02({ unit: { L1: 0.5, L2: 0.5 }, e2e: { L1: 0.5 } });
  const src = emitPolicyTs(policy, { importFrom: REF_INDEX });

  const dir = mkdtempSync(join(tmpdir(), "recede-wire-policy-"));
  const path = join(dir, "recede.policy.ts");
  writeFileSync(path, src);
  const mod = (await import(path)) as { policy: Policy };

  assert.equal(policyDigest(mod.policy), policyDigest(policy), "round-trip digest");
  assert.deepEqual(mod.policy.evidence_weights, policy.evidence_weights);
  assert.equal(mod.policy.version, "0.2.0");
});

test("emitPolicyTs: out-of-range evidence weight fails loud (A4 gate), nothing emitted", () => {
  // Bypass the constructor (a hand-edited proposed-policy.json could do this).
  const bad: Policy = {
    ...referencePolicyV02({}),
    evidence_weights: { unit: { L1: 1.5 } },
  };
  assert.throws(() => emitPolicyTs(bad), /out of range/);
});

test("emitPolicyTs: a non-v0.2 policy is refused (cannot round-trip the emitted shape)", () => {
  const v01: Policy = { ...referencePolicyV02({}), weighting: undefined, version: "0.1.0" };
  assert.throws(() => emitPolicyTs(v01), /v0\.2/);
});

test("emitPolicyTs: never invents a magnitude — empty weights emit zero numeric weights", () => {
  const src = emitPolicyTs(referencePolicyV02({}));
  // The ONLY numbers allowed in the emitted module are the input's declared
  // weights. With an empty table there must be no fractional literal at all.
  assert.ok(!/\d*\.\d+/.test(src), `emitted module invented a magnitude:\n${src}`);
});

// ---------------------------------------------------------------------------
// emitCheckAdapters
// ---------------------------------------------------------------------------

const entry = (over: Partial<EvidenceMapEntry>): EvidenceMapEntry => ({
  repo: "acme/widget",
  sourceKey: "check-run:unit",
  evClass: "unit",
  checkKind: "VERIFY",
  strength: "required-status-check",
  provTier: "L2",
  sha: "a".repeat(40),
  wiredToTrust: false,
  locator: "https://github.com/acme/widget/runs/1",
  discoveredVia: "fixture",
  ...over,
});

test("emitCheckAdapters: one adapter per class, evRef fields VERBATIM from the map entry", async () => {
  const entries: EvidenceMapEntry[] = [
    entry({
      artifact: { kind: "mutation", mutationScore: 0.9, mutationAdequate: true },
    }),
    entry({
      sourceKey: "status:lint",
      evClass: "lint",
      checkKind: "gate-only",
      strength: "self-reported",
      provTier: "L1",
      locator: "https://github.com/acme/widget/statuses/lint",
    }),
    entry({ sourceKey: "check-run:mystery", evClass: "unknown", checkKind: "gate-only" }),
  ];
  const files = emitCheckAdapters(entries, { importFrom: REF_INDEX });

  // "unknown" is skipped; one file per remaining class, deterministic order.
  assert.deepEqual(
    files.map((f) => f.path),
    ["checks/lint.ts", "checks/unit.ts"],
  );

  // Spot-check validity: import the emitted unit adapter and run it.
  const dir = mkdtempSync(join(tmpdir(), "recede-wire-checks-"));
  mkdirSync(join(dir, "checks"), { recursive: true });
  const unit = files.find((f) => f.path === "checks/unit.ts")!;
  const unitPath = join(dir, unit.path);
  writeFileSync(unitPath, unit.source);
  const mod = (await import(unitPath)) as {
    unitCheck: (verdict: string, confidence?: number) => CheckSpec;
  };
  const spec = mod.unitCheck("PASS");
  assert.equal(spec.check_kind, "VERIFY");
  const result = await spec.run({ intent: "", input: undefined, output: undefined });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.evidence_refs.length, 1);

  const desc = parseEvRef(result.evidence_refs[0]);
  assert.ok(desc, "emitted ref must parse under the ev1 grammar");
  assert.equal(desc!.evClass, "unit", "evClass verbatim");
  assert.equal(desc!.tier, "L2", "provTier verbatim");
  assert.equal(desc!.mutation, true, "mutationAdequate === true sets the ;mut=1 pre-image");
  assert.ok(
    result.evidence_refs[0].includes("|https://github.com/acme/widget/runs/1"),
    "locator verbatim",
  );

  // The lint entry: no adequate mutation artifact -> no mut marker; VALIDATE map.
  const lint = files.find((f) => f.path === "checks/lint.ts")!;
  assert.ok(!lint.source.includes("mut=1"), "no invented mutation marker");
  assert.ok(lint.source.includes('"ev1|lint|L1|'), "lint ref class/tier verbatim");
});

test("emitCheckAdapters: VALIDATE-kind classes emit VALIDATE check specs", () => {
  const files = emitCheckAdapters([
    entry({ sourceKey: "check-run:codecov", evClass: "coverage", checkKind: "VALIDATE", provTier: "L1" }),
  ]);
  assert.equal(files.length, 1);
  assert.ok(files[0].source.includes('"VALIDATE"'), "coverage maps to VALIDATE");
});

test("emitCheckAdapters: only 'unknown' entries -> no files, never a checks/unknown.ts", () => {
  const files = emitCheckAdapters([entry({ evClass: "unknown", checkKind: "gate-only" })]);
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// emitRecordWorkflow
// ---------------------------------------------------------------------------

/** Every line inside a `run: |` block (where shell executes — no ${{ }} allowed). */
function runBlockLines(yml: string): string[] {
  const lines = yml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run: \|/);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      if (l.match(/^\s*/)![0].length <= indent) break;
      out.push(l);
    }
    i = j - 1;
  }
  return out;
}

test("emitRecordWorkflow: SHA-pinned, least-privilege, ledger-branch-only, both CLIs invoked", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });

  // Every action is SHA-pinned (40-hex ref + version comment).
  const uses = yml.split("\n").filter((l) => l.includes("uses:"));
  assert.ok(uses.length >= 2, "workflow uses actions");
  for (const line of uses) {
    assert.match(line, /uses: [^@]+@[0-9a-f]{40} # v/, `not SHA-pinned: ${line}`);
  }

  // Least-privilege permissions block, scoped write.
  assert.match(yml, /permissions:\n\s+contents: write/);
  // The record engine is the shipped CLI (decision 2 — no Marketplace Action).
  assert.match(yml, /integrations\/cc10x\/cli\.ts record/);
  assert.match(yml, /--mode record-only/);
  // The workflow_dispatch backfill step invokes recede-scout backfill.
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /integrations\/scanner\/cli\.ts backfill/);
  // Writes go only to the ledger branch.
  assert.match(yml, /push origin "HEAD:\$LEDGER_BRANCH"/);
  assert.ok(yml.includes("recede-ledger"), "ledger branch threaded in");
  assert.ok(yml.includes("v0.2.0"), "scout ref threaded in");
  // No authored magnitude in a committed default (red-team rule 1). Strip the
  // action pins/version comments and the scout ref first — those are the only
  // legitimate dotted numbers.
  const stripped = yml
    .replace(/@[0-9a-f]{40} # v[\d.]+/g, "")
    .replaceAll("v0.2.0", "");
  assert.ok(!/\d\.\d/.test(stripped), "no magnitudes in the committed workflow default");
});

test("emitRecordWorkflow: the verifier verdict is DERIVED from real checks, never a literal pass", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });
  // The record step consumes the derived verdict.
  assert.match(yml, /--verifier "\$VERIFIER_VERDICT"/, "record must use the derived verdict");
  assert.ok(
    !/--verifier pass\b/.test(yml),
    "a hard-coded '--verifier pass' fabricates VERIFY evidence for a PR merged over red CI",
  );
  // The derivation step queries the combined status AND the check-runs at the
  // merge SHA, fails loud if the query fails (set -euo pipefail), and excludes
  // this workflow's own check run by name.
  assert.match(yml, /commits\/\$MERGE_SHA\/status/, "queries the combined status at the merge SHA");
  assert.match(yml, /commits\/\$MERGE_SHA\/check-runs/, "queries the check-runs at the merge SHA");
  assert.match(yml, /set -euo pipefail/, "derivation fails loud, never records an unbound verdict");
  assert.match(yml, /SELF_JOB/, "excludes this workflow's own check run by name");
});

test("emitRecordWorkflow: the task lane is INFERRED via the shipped infer-task, not hard-coded", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });
  assert.match(yml, /integrations\/scanner\/cli\.ts infer-task/, "runs the shipped inference");
  assert.match(yml, /--task "\$TASK_TYPE"/, "record consumes the inferred task type");
  assert.match(yml, /--risk "\$TASK_RISK"/, "record consumes the inferred risk");
  assert.ok(!yml.includes("--task code.feature"), "the lane must not be hard-coded");
});

test("emitRecordWorkflow: merged-by is labeled distinguishably from an independent review", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });
  assert.match(yml, /--reviewer "merged-by:\$PR_MERGED_BY"/, "merge approval labeled merged-by:");
});

test("emitRecordWorkflow: no concurrency group; pushes rebase-retry bounded and fail loud", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });
  assert.ok(!yml.includes("concurrency:"), "no workflow-level concurrency group");
  assert.match(yml, /git -C ledger fetch origin "\$LEDGER_BRANCH"/, "fetch on contention");
  assert.match(yml, /git -C ledger rebase "origin\/\$LEDGER_BRANCH"/, "rebase on contention");
  assert.match(yml, /for attempt in 1 2 3 4 5/, "bounded retries");
  assert.match(yml, /exit 1/, "fails loud after the retry budget");
});

test("emitRecordWorkflow: PR-derived strings stay env-routed — no ${{ }} inside run blocks", () => {
  const yml = emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });
  const lines = runBlockLines(yml);
  assert.ok(lines.length > 5, "run blocks exist");
  for (const line of lines) {
    assert.ok(!line.includes("${{"), `expression interpolation inside a run block: ${line}`);
  }
});

test("emitRecordWorkflow: refuses an unsafe branch/ref (fail loud, nothing emitted)", () => {
  assert.throws(() => emitRecordWorkflow({ ledgerBranch: "", scoutRef: "v1" }), /ledgerBranch/);
  assert.throws(
    () => emitRecordWorkflow({ ledgerBranch: 'x" && rm -rf', scoutRef: "v1" }),
    /ledgerBranch/,
  );
  assert.throws(() => emitRecordWorkflow({ ledgerBranch: "ok", scoutRef: "a\nb" }), /scoutRef/);
});
