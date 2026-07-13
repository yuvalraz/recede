// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3 — the `matrix` subcommand: the readiness landscape behind
 * `node cli.ts matrix --ledger <path> [--map <evidence-map.json>]
 *  [--out <readiness.json>] [--md-out <file>]`.
 *
 * All offline (spawnSync per the cli-mode.test.ts precedent, temp dirs only).
 * The clock enters HERE and only here (`generatedAt`); the pure core stays
 * clockless. Fail-closed I2: any lane whose stored trust does not replay ->
 * exit 1, the lane named on stderr, and NOTHING written (no --out, no
 * --md-out, no stdout markdown).
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
const freshDir = (): string => mkdtempSync(join(tmpdir(), "recede-cli-matrix-"));
const freshPath = (dir: string, name: string): string => join(dir, `${n++}-${name}`);

function run(cli: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A no-sidecar ledger built forward via real `record` invocations. */
function recordedLedger(dir: string): string {
  const ledger = freshPath(dir, "ledger.jsonl");
  for (const [task, intent] of [
    ["code.fix", "fix the widget"],
    ["code.fix", "fix the gadget"],
    ["docs.write", "document the widget"],
  ]) {
    const r = run(CLI, [
      "record",
      "--ledger", ledger,
      "--actor", "fable-5@claude-code",
      "--task", task,
      "--intent", intent,
      "--verifier", "pass",
      "--human", "approve",
    ]);
    assert.equal(r.code, 0, r.err);
  }
  return ledger;
}

/** A backfilled ledger + v0.2 policy sidecar from the widget fixture. */
function backfilledLedger(dir: string): string {
  const ledger = freshPath(dir, "backfilled.jsonl");
  const r = run(SCOUT_CLI, [
    "backfill",
    "--repo", "acme/widget",
    "--ledger", ledger,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(`${ledger}.policy.json`), "backfill writes the sidecar");
  return ledger;
}

interface ReadinessJson {
  schemaVersion: string;
  generatedAt: string | null;
  policy: { id: string; version: string };
  lanes: {
    actor: string;
    task_type: string;
    reconstructed: boolean;
    outcomes: Record<string, number>;
    cells: { move: { evidence_alternative: string | null } }[];
  }[];
  evidence_map: { generator: string; repos: string[]; counts: unknown } | null;
}

// ---------------------------------------------------------------------------
// no-sidecar ledger -> v0.1 path, stdout markdown, valid JSON artifact
// ---------------------------------------------------------------------------

test("matrix: no-sidecar ledger — exit 0, stdout markdown, --out writes a valid stamped artifact", () => {
  const dir = freshDir();
  const ledger = recordedLedger(dir);
  const outPath = freshPath(dir, "readiness.json");

  const r = run(CLI, ["matrix", "--ledger", ledger, "--out", outPath]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Recede readiness matrix\n/, "markdown to stdout by default");
  assert.ok(r.out.includes("(counts, never averaged"), "the counts-only caption verbatim");
  assert.match(r.out, /policy recede\.cc10x\.coding@0\.1\.0/, "absent sidecar -> v0.1 coding policy");

  assert.ok(existsSync(outPath), "--out writes the JSON artifact");
  const j = JSON.parse(readFileSync(outPath, "utf8")) as ReadinessJson;
  assert.equal(j.schemaVersion, "recede-readiness/1");
  assert.ok(j.generatedAt, "generatedAt stamped at the CLI boundary");
  assert.match(j.generatedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "a valid ISO stamp");
  assert.ok(!Number.isNaN(Date.parse(j.generatedAt!)), "parseable timestamp");
  assert.equal(j.lanes.length, 2, "code.fix + docs.write lanes");
});

test("matrix: --md-out redirects the markdown to a file instead of stdout", () => {
  const dir = freshDir();
  const ledger = recordedLedger(dir);
  const mdPath = freshPath(dir, "readiness.md");

  const r = run(CLI, ["matrix", "--ledger", ledger, "--md-out", mdPath]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(mdPath), "--md-out writes the markdown file");
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /^# Recede readiness matrix\n/);
  assert.ok(!r.out.includes("# Recede readiness matrix"), "markdown not duplicated on stdout");
});

// ---------------------------------------------------------------------------
// backfilled ledger + sidecar -> v0.2 path, reconstructed marker, alternative
// ---------------------------------------------------------------------------

test("matrix: backfilled ledger — v0.2 policy, REVERTED lane with the * marker, honest evidence_alternative", () => {
  const dir = freshDir();
  const ledger = backfilledLedger(dir);
  const outPath = freshPath(dir, "readiness.json");

  const r = run(CLI, ["matrix", "--ledger", ledger, "--out", outPath]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /policy recede\.reference@0\.2\.0/, "sidecar -> the persisted v0.2 policy");
  assert.match(r.out, / \* \| T\d /, "a reconstructed lane row carries the * marker");
  assert.ok(r.out.includes("* = reconstructed lane"), "the * legend is present");

  const j = JSON.parse(readFileSync(outPath, "utf8")) as ReadinessJson;
  const reverted = j.lanes.find((l) => (l.outcomes["REVERTED"] ?? 0) > 0);
  assert.ok(reverted, "the widget history has a REVERTED lane");
  assert.equal(reverted!.reconstructed, true, "backfilled ground truth marks the lane reconstructed");
  // evidence_alternative populates only where a declared L2 weight exists.
  // The backfill's ALL-EQUAL placeholder table declares L1 weights ONLY
  // (proven from the sidecar below), so the honest end-to-end answer here is
  // null in every cell — the core never invents a weight the table lacks.
  // (The populated path is unit-proven in readiness.test.ts v02Fixture.)
  const sidecar = JSON.parse(readFileSync(`${ledger}.policy.json`, "utf8")) as {
    evidence_weights: Record<string, Record<string, number>>;
  };
  const declaredL2 = Object.values(sidecar.evidence_weights).some((w) => "L2" in w);
  assert.equal(declaredL2, false, "the placeholder table declares no L2 weight");
  const alts = j.lanes.flatMap((l) => l.cells).filter((c) => c.move.evidence_alternative !== null);
  assert.equal(alts.length, 0, "no declared L2 weight -> no alternative is ever claimed");
});

// ---------------------------------------------------------------------------
// --map: repo-level block only; lanes byte-identical with and without it
// ---------------------------------------------------------------------------

test("matrix: --map embeds the repo-level block; lanes byte-identical to the no-map run", () => {
  const dir = freshDir();
  const ledger = backfilledLedger(dir);
  const mapPath = freshPath(dir, "evidence-map.json");
  const policyPath = freshPath(dir, "starter-policy.json");
  const scan = run(SCOUT_CLI, [
    "scan",
    "--repo", "acme/widget",
    "--out", mapPath,
    "--policy-out", policyPath,
    "--source", "fixture",
    "--fixture", FIXTURE,
  ]);
  assert.equal(scan.code, 0, scan.err);

  const withOut = freshPath(dir, "with-map.json");
  const withoutOut = freshPath(dir, "without-map.json");
  const withMap = run(CLI, ["matrix", "--ledger", ledger, "--map", mapPath, "--out", withOut]);
  const noMap = run(CLI, ["matrix", "--ledger", ledger, "--out", withoutOut]);
  assert.equal(withMap.code, 0, withMap.err);
  assert.equal(noMap.code, 0, noMap.err);
  assert.ok(withMap.out.includes("Evidence map (repo-level"), "the repo-level block renders");

  const a = JSON.parse(readFileSync(withOut, "utf8")) as ReadinessJson;
  const b = JSON.parse(readFileSync(withoutOut, "utf8")) as ReadinessJson;
  assert.ok(a.evidence_map, "evidence_map block present in the JSON artifact");
  assert.equal(a.evidence_map!.repos[0], "acme/widget");
  assert.equal(b.evidence_map, null);
  // generatedAt differs run-to-run; the LANES must be byte-identical (map neutrality).
  assert.equal(JSON.stringify(a.lanes), JSON.stringify(b.lanes), "lanes unaffected by the map");
});

test("matrix: --map refuses a file with the wrong schemaVersion (fail loud)", () => {
  const dir = freshDir();
  const ledger = recordedLedger(dir);
  const mapPath = freshPath(dir, "bad-map.json");
  writeFileSync(mapPath, JSON.stringify({ schemaVersion: "not-a-map/9" }) + "\n");

  const r = run(CLI, ["matrix", "--ledger", ledger, "--map", mapPath]);
  assert.equal(r.code, 1, "a wrong-schema map must not be silently accepted");
  assert.match(r.err, /recede-evidence-map\/1/, "the error names the expected schema");
});

// ---------------------------------------------------------------------------
// fail-closed I2: corrupted stored trust -> exit 1, lane named, NOTHING written
// ---------------------------------------------------------------------------

test("matrix: corrupted stored-trust line — exit 1, stderr names the lane, no files written", () => {
  const dir = freshDir();
  const ledger = recordedLedger(dir);

  // Doctor the LAST stored-trust line for a lane (FileLedger lines are tagged
  // {"t":"record",...} | {"t":"trust","s":{...}}): nudge the score so the
  // stored snapshot no longer replays.
  const lines = readFileSync(ledger, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let doctored = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]) as { t: string; s?: { score: number } };
    if (row.t === "trust") {
      row.s!.score += 0.1;
      lines[i] = JSON.stringify(row);
      doctored = i;
      break;
    }
  }
  assert.ok(doctored >= 0, "found a stored-trust line to corrupt");
  writeFileSync(ledger, lines.join("\n") + "\n");

  const outPath = freshPath(dir, "readiness.json");
  const mdPath = freshPath(dir, "readiness.md");
  const r = run(CLI, ["matrix", "--ledger", ledger, "--out", outPath, "--md-out", mdPath]);
  assert.equal(r.code, 1, "I2 FAIL is fail-closed");
  assert.match(r.err, /I2/, "stderr names the failed invariant");
  assert.match(r.err, /fable-5@claude-code/, "stderr names the offending lane's actor");
  assert.ok(!existsSync(outPath), "--out NOT written on I2 FAIL");
  assert.ok(!existsSync(mdPath), "--md-out NOT written on I2 FAIL");
  assert.ok(!r.out.includes("# Recede readiness matrix"), "no stdout markdown on I2 FAIL");
});

// ---------------------------------------------------------------------------
// usage surface
// ---------------------------------------------------------------------------

test("matrix: --ledger is required; USAGE names the matrix subcommand", () => {
  const missing = run(CLI, ["matrix"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--ledger/);

  const usage = run(CLI, []);
  assert.equal(usage.code, 0);
  assert.match(usage.err, /matrix --ledger <path> \[--map <path>\] \[--out <path>\] \[--md-out <path>\]/);
});
