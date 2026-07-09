#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * NON-CI live smoke for recede-scout. This file lives under `scripts/` and is
 * NOT named `*.test.ts`, so `node --test "…/test/*.test.ts"` never picks it up.
 * It is MANUAL and OPSEC-safe by construction:
 *
 *   1. It asserts the ACTIVE `gh` account is `yuvalraz` BEFORE any API call, and
 *      fails LOUD otherwise (guards against the account flipping to a work login).
 *   2. It refuses any repo whose owner is not `yuvalraz`, and refuses a repo that
 *      is not PUBLIC (no private/work data ever leaves the machine).
 *
 * It then runs the real `GhApiEvidenceSource` + `collectScan` against the target
 * public repo and prints the discovered evidence-map + starter policy. It writes
 * NOTHING and records NOTHING. It is a human-in-the-loop verification step, never
 * a CI dependency.
 *
 *   node integrations/scanner/scripts/smoke.ts [owner/name] \
 *        [--artifact <runId>:<name>:<kind>:<surface>:<sha>]...   (default: yuvalraz/recede)
 *
 * `--artifact` (repeatable) demonstrates the end-to-end artifact pipeline against a
 * real public run: it downloads the named artifact via the gh CLI and attaches it to
 * the given check surface. Still OPSEC-guarded (public, self-owned repos only).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GhApiEvidenceSource,
  collectScan,
  buildEvidenceMap,
  emitStarterPolicy,
  parseArtifactSpec,
  type ArtifactRequest,
} from "../scanner.ts";
import { FileLedger } from "../../../reference/ts/src/index.ts";
import { runBackfill } from "../backfill.ts";

const execFileAsync = promisify(execFile);
const REQUIRED_ACCOUNT = "yuvalraz";

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`gh ${args.join(" ")} failed: ${e.stderr || e.message}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const artifacts: ArtifactRequest[] = [];
  let target = "yuvalraz/recede";
  let backfill = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--artifact") {
      const spec = argv[++i];
      if (spec === undefined) throw new Error("--artifact needs a runId:name:kind:surface:sha value");
      artifacts.push(parseArtifactSpec(spec));
    } else if (argv[i] === "--backfill") {
      backfill = true;
    } else {
      target = argv[i];
    }
  }
  const [owner, repoName] = target.split("/");
  if (!owner || !repoName) throw new Error(`target '${target}' must be 'owner/name'`);

  // GUARD 1 — the active gh account must be yuvalraz (the authenticated login the
  // active token resolves to). Fail loud before ANY evidence call.
  const login = await gh(["api", "user", "-q", ".login"]);
  if (login !== REQUIRED_ACCOUNT) {
    throw new Error(
      `OPSEC HALT: active gh account is '${login}', expected '${REQUIRED_ACCOUNT}'. ` +
        `Run 'gh auth switch --user ${REQUIRED_ACCOUNT}' and retry. Nothing was scanned.`,
    );
  }

  // GUARD 2 — public repos owned by yuvalraz only.
  if (owner !== REQUIRED_ACCOUNT) {
    throw new Error(`OPSEC HALT: repo owner '${owner}' is not '${REQUIRED_ACCOUNT}'. Public self-owned repos only.`);
  }
  const visibility = await gh(["repo", "view", target, "--json", "visibility", "-q", ".visibility"]);
  if (visibility.toLowerCase() !== "public") {
    throw new Error(`OPSEC HALT: '${target}' visibility is '${visibility}', not public. Public repos only.`);
  }

  console.log(`recede-scout smoke: account=${login} target=${target} (public) — scanning read-only…\n`);

  const source = new GhApiEvidenceSource();

  // --backfill: replay merge history into a THROWAWAY ledger under the OS tmp dir
  // (NEVER the repo tree — the ledger is personal STATE_DIR data). Same OPSEC
  // guards (public, self-owned, active-account) already passed above.
  if (backfill) {
    const dir = mkdtempSync(join(tmpdir(), "recede-backfill-smoke-"));
    const ledgerPath = join(dir, "ledger.jsonl");
    try {
      console.log(`recede-scout backfill smoke: ${target} → ${ledgerPath} (throwaway, tmp)\n`);
      const report = await runBackfill(source, { owner, repo: repoName }, new FileLedger(ledgerPath));
      console.log(
        `backfill OK — reconstructed ${report.reconstructed} across ${report.lanes} lane(s), ` +
          `${report.reverts} revert(s), folded under ${report.policy.id}@${report.policy.version}.`,
      );
      console.log("reconstructed, unsealed, from API state as of backfill. Ledger discarded below.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  // Leave `artifacts` UNSUPPLIED when no --artifact flag was given, so the live
  // smoke exercises AUTO-discovery (an explicit empty array would suppress it).
  const scan = await collectScan(
    source,
    { owner, repo: repoName },
    { prState: "merged", ...(artifacts.length > 0 ? { artifacts } : {}) },
  );
  const map = buildEvidenceMap([scan], { now: new Date().toISOString() });
  const policy = emitStarterPolicy(map, { mode: "all-equal" });

  console.log("=== evidence-map.json ===");
  console.log(JSON.stringify(map, null, 2));
  console.log("\n=== starter-policy.json ===");
  console.log(JSON.stringify(policy, null, 2));
  console.log(
    `\nsmoke OK — ${map.counts.totalSources} sources, ${map.counts.wiredToTrust} wired. Nothing written, nothing recorded.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
