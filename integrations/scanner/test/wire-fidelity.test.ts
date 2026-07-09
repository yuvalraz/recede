// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.2 — THE FIDELITY GATE (provable property 6). The emitted
 * `recede-record.yml` invokes the SHIPPED CLIs; every flag in those emitted
 * invocations must exist in the real CLI option surface. The option surface is
 * read from the CLI SOURCE (the parseArgs options object), not hand-copied —
 * an invented flag in the emitter, or a renamed flag in the CLI, fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitRecordWorkflow } from "../wire.ts";

const RECORD_CLI = join(import.meta.dirname, "../../cc10x/cli.ts");
const SCOUT_CLI = join(import.meta.dirname, "../cli.ts");

/** The parseArgs option names of one subcommand function in a CLI source file. */
function optionSurface(cliPath: string, fnName: string): Set<string> {
  const src = readFileSync(cliPath, "utf8");
  const start = src.indexOf(`function ${fnName}`);
  assert.ok(start >= 0, `${fnName} not found in ${cliPath}`);
  const optionsStart = src.indexOf("options: {", start);
  const optionsEnd = src.indexOf("\n    },", optionsStart);
  assert.ok(optionsStart > start && optionsEnd > optionsStart, `no parseArgs options in ${fnName}`);
  const block = src.slice(optionsStart, optionsEnd);
  const names = new Set<string>();
  for (const m of block.matchAll(/(?:"([a-z][a-z-]*)"|([a-z][a-z-]*)):\s*\{\s*type:/g)) {
    names.add(m[1] ?? m[2]);
  }
  assert.ok(names.size > 0, `empty option surface for ${fnName}`);
  return names;
}

/** Extract the --flags of every emitted invocation of `<cliRe> <sub>` in the YAML. */
function emittedFlags(yml: string, marker: string): string[][] {
  const lines = yml.split("\n");
  const invocations: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(marker)) continue;
    // Join shell continuation lines into one logical command.
    let cmd = lines[i];
    let j = i;
    while (cmd.trimEnd().endsWith("\\") && j + 1 < lines.length) {
      j += 1;
      cmd = cmd.trimEnd().slice(0, -1) + " " + lines[j].trim();
    }
    const flags = [...cmd.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]);
    invocations.push(flags);
  }
  return invocations;
}

// Built lazily inside each test so a not-yet-implemented emitter is a
// behavioral test failure, not a module-collection error.
const yml = (): string => emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "v0.2.0" });

test("fidelity: every flag in the emitted `recede-cc10x record` invocation exists in the CLI", () => {
  const surface = optionSurface(RECORD_CLI, "cmdRecord");
  const invocations = emittedFlags(yml(), "cli.ts record");
  assert.ok(invocations.length >= 1, "the workflow must invoke `recede-cc10x record`");
  for (const flags of invocations) {
    // Non-vacuous: the record contract's required flags are actually passed.
    for (const required of ["ledger", "actor", "task", "intent", "verifier"]) {
      assert.ok(flags.includes(required), `record invocation missing --${required}`);
    }
    for (const flag of flags) {
      assert.ok(surface.has(flag), `emitted flag --${flag} does not exist in cmdRecord options`);
    }
  }
});

test("fidelity: every flag in the emitted `recede-scout backfill` invocation exists in the CLI", () => {
  const surface = optionSurface(SCOUT_CLI, "cmdBackfill");
  const invocations = emittedFlags(yml(), "cli.ts backfill");
  assert.ok(invocations.length >= 1, "the workflow must invoke `recede-scout backfill`");
  for (const flags of invocations) {
    for (const required of ["repo", "ledger"]) {
      assert.ok(flags.includes(required), `backfill invocation missing --${required}`);
    }
    for (const flag of flags) {
      assert.ok(surface.has(flag), `emitted flag --${flag} does not exist in cmdBackfill options`);
    }
  }
});

test("fidelity: every flag in the emitted `recede-scout infer-task` invocation exists in the CLI", () => {
  const surface = optionSurface(SCOUT_CLI, "cmdInferTask");
  const invocations = emittedFlags(yml(), "cli.ts infer-task");
  assert.ok(invocations.length >= 1, "the workflow must invoke `recede-scout infer-task`");
  for (const flags of invocations) {
    for (const required of ["title", "labels"]) {
      assert.ok(flags.includes(required), `infer-task invocation missing --${required}`);
    }
    for (const flag of flags) {
      assert.ok(surface.has(flag), `emitted flag --${flag} does not exist in cmdInferTask options`);
    }
  }
});

test("fidelity: the gate itself would catch an invented flag", () => {
  const surface = optionSurface(RECORD_CLI, "cmdRecord");
  assert.ok(!surface.has("no-such-flag"), "sanity: an invented flag is not in the surface");
  assert.ok(surface.has("ledger") && surface.has("verifier"), "sanity: real flags are");
});
