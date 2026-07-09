// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.2 — the staged-adoption flag (`record --mode record-only|advisory`)
 * and the policy-aware CLI (decision-5/6 reconciliation, sidecar design).
 *
 * Modes (mode-taxonomy amendment, 2026-07-09): record-only is the existing
 * behavior EXACTLY (incl. the fail-closed honesty gate on --human none, which
 * protects the ledger in BOTH modes); advisory additionally PRINTS the gate
 * decision. `gated` is NOT a recorder mode — record time is post-merge, there
 * is nothing left to block — so `--mode gated` is REFUSED with a pointer to
 * the future pre-action `recede-cc10x gate` consult. never_recede lanes stay
 * checkpointed in EVERY mode.
 *
 * Sidecar: a backfill writes a `<ledger>.policy.json` SIDECAR (the fold policy
 * is not persistable in the ledger itself without a kernel change); record,
 * reseal, AND status resolve it and fold/replay under THAT policy. No sidecar
 * -> v0.1 behavior byte-identical. A sidecar without a policy_digest is
 * refused (backfill always writes one).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "cli.ts");
const SCOUT_CLI = join(import.meta.dirname, "../scanner/cli.ts");
const FIXTURE = join(import.meta.dirname, "../scanner/test/fixtures/merge-history/widget.json");

let n = 0;
const freshLedger = (): string =>
  join(mkdtempSync(join(tmpdir(), "recede-cli-mode-")), `ledger-${n++}.jsonl`);

function run(cli: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const recordArgs = (ledger: string, extra: string[] = []): string[] => [
  "record",
  "--ledger", ledger,
  "--actor", "fable-5@claude-code",
  "--task", "code.fix",
  "--intent", "fix the widget",
  "--verifier", "pass",
  ...extra,
];

// ---------------------------------------------------------------------------
// --mode record-only (default, backward-compatible)
// ---------------------------------------------------------------------------

test("record-only: explicit --mode record-only behaves like the default (no advisory line)", () => {
  const a = run(CLI, recordArgs(freshLedger(), ["--human", "approve"]));
  const b = run(CLI, recordArgs(freshLedger(), ["--human", "approve", "--mode", "record-only"]));
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.ok(!a.out.includes("advisory:"), "default prints no advisory line");
  assert.ok(!b.out.includes("advisory:"), "record-only prints no advisory line");
  assert.match(a.out, /sealed\s+SUCCESS/);
  assert.match(b.out, /sealed\s+SUCCESS/);
});

test("record-only: the fail-closed honesty gate on --human none STAYS (exit 2)", () => {
  const r = run(CLI, recordArgs(freshLedger(), ["--human", "none", "--mode", "record-only"]));
  assert.equal(r.code, 2);
  assert.match(r.err, /GATE REFUSED/);
});

test("--mode rejects an unknown value", () => {
  const r = run(CLI, recordArgs(freshLedger(), ["--human", "approve", "--mode", "yolo"]));
  assert.equal(r.code, 1);
  assert.match(r.err, /--mode must be one of/);
});

// ---------------------------------------------------------------------------
// --mode advisory
// ---------------------------------------------------------------------------

test("advisory: prints the gate decision line, records exactly like record-only", () => {
  const r = run(CLI, recordArgs(freshLedger(), ["--human", "approve", "--mode", "advisory"]));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /advisory: gate would CHECKPOINT\(full\) — /, "cold lane would checkpoint");
  assert.match(r.out, /sealed\s+SUCCESS/, "still records");
});

test("advisory: does not weaken the honesty gate (--human none still refused)", () => {
  const r = run(CLI, recordArgs(freshLedger(), ["--human", "none", "--mode", "advisory"]));
  assert.equal(r.code, 2);
  assert.match(r.err, /GATE REFUSED/);
});

// ---------------------------------------------------------------------------
// --mode gated is DELETED (P3.2 mode-taxonomy amendment)
// ---------------------------------------------------------------------------

test("gated: --mode gated is REFUSED, naming the future pre-action gate consult", () => {
  const r = run(CLI, recordArgs(freshLedger(), ["--human", "approve", "--mode", "gated"]));
  assert.equal(r.code, 1, "refused as an unknown mode value");
  assert.match(r.err, /--mode/);
  assert.match(r.err, /pre-action/, "the error names the upgrade path");
  assert.match(r.err, /recede-cc10x gate/, "the error names the future gate consult");
});

// ---------------------------------------------------------------------------
// never_recede floor holds in EVERY mode
// ---------------------------------------------------------------------------

for (const mode of ["record-only", "advisory"]) {
  test(`never_recede: release.publish stays checkpointed under --mode ${mode}`, () => {
    const ledger = freshLedger();
    const refused = run(CLI, [
      "record",
      "--ledger", ledger,
      "--actor", "fable-5@claude-code",
      "--task", "release.publish",
      "--intent", "publish the widget",
      "--verifier", "pass",
      "--human", "none",
      "--mode", mode,
    ]);
    assert.equal(refused.code, 2, `--human none must refuse under ${mode}`);
    assert.match(refused.err, /GATE REFUSED/);

    const ok = run(CLI, [
      "record",
      "--ledger", ledger,
      "--actor", "fable-5@claude-code",
      "--task", "release.publish",
      "--intent", "publish the widget",
      "--verifier", "pass",
      "--human", "approve",
      "--mode", mode,
    ]);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /review=FIRED\(full\)/, "the checkpoint FIRED — it never receded");
    assert.match(ok.out, /irreversible\.critical: CHECKPOINT\(full\)/, "next gate stays checkpointed");
  });
}

// ---------------------------------------------------------------------------
// policy-aware status (decision-5/6 reconciliation; sidecar design)
// ---------------------------------------------------------------------------

test("status: verifies a v0.2 backfilled ledger via the policy sidecar (I2 PASS, exit 0)", () => {
  const ledger = freshLedger();
  const backfill = run(SCOUT_CLI, [
    "backfill",
    "--repo", "acme/widget",
    "--ledger", ledger,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(backfill.code, 0, backfill.err);

  const sidecar = `${ledger}.policy.json`;
  assert.ok(existsSync(sidecar), "backfill writes the fold-policy sidecar next to the ledger");
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as { schema?: string };
  assert.equal(parsed.schema, "recede-ledger-policy/1");

  const status = run(CLI, ["status", "--ledger", ledger]);
  assert.equal(status.code, 0, `status must PASS on the policy it was folded under\n${status.out}${status.err}`);
  assert.match(status.out, /I2 replay integrity: PASS/);
  assert.match(status.out, /recede\.reference@0\.2\.0/, "replayed under the persisted v0.2 policy");
});

test("status: a ledger without a sidecar keeps the v0.1 behavior byte-identical", () => {
  const ledger = freshLedger();
  const rec = run(CLI, recordArgs(ledger, ["--human", "approve"]));
  assert.equal(rec.code, 0, rec.err);
  assert.ok(!existsSync(`${ledger}.policy.json`), "no sidecar for a forward-recorded ledger");

  const status = run(CLI, ["status", "--ledger", ledger]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /I2 replay integrity: PASS/);
  assert.match(status.out, /recede\.cc10x\.coding@0\.1\.0/, "v0.1 default policy unchanged");
});

test("reseal: a backfilled (sidecar'd) ledger keeps `status` I2 PASS after a reseal", () => {
  const ledger = freshLedger();
  const backfill = run(SCOUT_CLI, [
    "backfill",
    "--repo", "acme/widget",
    "--ledger", ledger,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(backfill.code, 0, backfill.err);

  // Any backfilled warrant: the first INTENT record in the ledger (FileLedger
  // lines are tagged: {"t":"record","r":{...}} | {"t":"trust","s":{...}}).
  const intent = readFileSync(ledger, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { t: string; r?: { kind: string; id: string } })
    .filter((row) => row.t === "record")
    .map((row) => row.r!)
    .find((r) => r.kind === "INTENT");
  assert.ok(intent, "backfilled ledger has an INTENT record");

  // The false-FAIL scenario: a reseal that folds under v0.1 while the ledger
  // was folded (and is verified) under the sidecar's v0.2 policy breaks I2.
  const reseal = run(CLI, [
    "reseal",
    "--ledger", ledger,
    "--warrant", intent!.id,
    "--outcome", "reverted",
    "--source", "post-merge regression",
  ]);
  assert.equal(reseal.code, 0, reseal.err);

  const status = run(CLI, ["status", "--ledger", ledger]);
  assert.equal(status.code, 0, `reseal must fold under the sidecar policy\n${status.out}${status.err}`);
  assert.match(status.out, /I2 replay integrity: PASS/);
});

test("status: refuses a sidecar without a policy_digest (unpinned policy, fail loud)", () => {
  const ledger = freshLedger();
  const backfill = run(SCOUT_CLI, [
    "backfill",
    "--repo", "acme/widget",
    "--ledger", ledger,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(backfill.code, 0, backfill.err);

  const sidecarPath = `${ledger}.policy.json`;
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as { policy_digest?: string };
  delete sidecar.policy_digest;
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");

  const status = run(CLI, ["status", "--ledger", ledger]);
  assert.equal(status.code, 1, "an unpinned sidecar must not be silently trusted");
  assert.match(status.err, /policy_digest/);
});

test("status: fails loud on a sidecar whose digest does not match its weights", () => {
  const ledger = freshLedger();
  const backfill = run(SCOUT_CLI, [
    "backfill",
    "--repo", "acme/widget",
    "--ledger", ledger,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(backfill.code, 0, backfill.err);

  const sidecarPath = `${ledger}.policy.json`;
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as { policy_digest: string };
  sidecar.policy_digest = "sha256:" + "0".repeat(64);
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");

  const status = run(CLI, ["status", "--ledger", ledger]);
  assert.equal(status.code, 1, "a tampered/mismatched sidecar must not be silently trusted");
  assert.match(status.err, /digest/i);
});
