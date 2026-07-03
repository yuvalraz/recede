#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * fake-openwiki — a stand-in for the real OpenWiki generator, so the demo and
 * tests run with NO network, NO LLM, and NO OpenWiki install. It reproduces
 * the ONE upstream behavior the wrapper must survive: OpenWiki writes a
 * `_plan.md` (a claim->evidence sketch) while generating, then DELETES it when
 * done. The wrapper's watcher exists precisely to snapshot that ephemeral file
 * before it vanishes.
 *
 *   node fake-openwiki.ts <wikiDir> --head <sha> [--fail] [--no-plan] [--no-last-update]
 *
 * Steps:
 *   1. Copy the fixture wiki pages (fixtures/wiki/*) into <wikiDir>.
 *   2. Unless --no-plan: write <wikiDir>/_plan.md, wait 200ms (a deterministic
 *      capture window emulating LLM latency), then delete it.
 *   3. Unless --no-last-update: write <wikiDir>/.last-update.json = {"gitHead": <--head>}.
 *   4. --fail: exit 3 after step 1 WITHOUT writing .last-update.json (models a
 *      failed generation — the wrapper must seal nothing, mutate nothing).
 */

import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      head: { type: "string" },
      fail: { type: "boolean" },
      "no-plan": { type: "boolean" },
      "no-last-update": { type: "boolean" },
    },
  });

  const wikiDir = positionals[0];
  if (!wikiDir) {
    console.error("fake-openwiki: missing <wikiDir> positional");
    process.exit(2);
  }
  const head = values.head ?? "0000000";

  // Step 1: materialize the fixture pages into the wiki dir.
  mkdirSync(wikiDir, { recursive: true });
  const templateDir = join(import.meta.dirname, "wiki");
  for (const name of readdirSync(templateDir)) {
    if (!name.endsWith(".md")) continue;
    writeFileSync(join(wikiDir, name), readFileSync(join(templateDir, name), "utf8"));
  }

  // Step 4: a failed generation exits before writing the freshness marker.
  if (values.fail) {
    console.error("fake-openwiki: simulated generation failure");
    process.exit(3);
  }

  // Step 2: the ephemeral plan file — write, linger, delete.
  if (!values["no-plan"]) {
    const planPath = join(wikiDir, "_plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n- claim: parser walks tokens -> evidence: src/parser.ts#parseAll\n" +
        "- claim: shared helpers -> evidence: src/utils.ts#helperFn\n",
    );
    await sleep(200);
    rmSync(planPath, { force: true });
  }

  // Step 3: the freshness marker OpenWiki drops after a successful run.
  if (!values["no-last-update"]) {
    writeFileSync(join(wikiDir, ".last-update.json"), JSON.stringify({ gitHead: head }) + "\n");
  }
}

await main();
