#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * recede-scout — read-only evidence-discovery CLI (Phase 2). Walks an adopter's
 * GitHub repo(s) via the authenticated `gh` CLI, discovers the machine-readable
 * evidence already present, and emits two artifacts:
 *   - `evidence-map.json`  — the discovered inventory (schema `recede-evidence-map/1`)
 *   - `starter-policy.json` — a starter `Policy` (via the audited referencePolicyV02;
 *                             `all-equal` placeholders or `empty`, ZERO authored magnitudes)
 *
 *   node cli.ts scan --repo <owner/name>[,<owner/name>…] --out <evidence-map.json>
 *                    --policy-out <starter-policy.json>
 *                    [--mode all-equal|empty] [--source gh|fixture] [--fixture <set.json>]
 *                    [--branch <name>] [--pr-state merged|open|all]
 *
 * Read-only against GitHub; the ONLY writes are the two output files. This CLI is
 * the ONLY place the clock enters (`generatedAt`) — the pure core is deterministic.
 * Zero runtime dependencies; Node >= 22.6 (native type stripping).
 */

import { parseArgs } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
import {
  GhApiEvidenceSource,
  FixtureEvidenceSource,
  collectScan,
  buildEvidenceMap,
  emitStarterPolicy,
  parseArtifactSpec,
  type ArtifactRequest,
  type EvidenceSource,
  type FixtureSet,
  type RepoRef,
  type RepoScan,
} from "./scanner.ts";

const USAGE = `recede-scout — read-only evidence-discovery scanner

usage:
  node cli.ts scan --repo <owner/name>[,<owner/name>…] --out <evidence-map.json>
                   --policy-out <starter-policy.json>
                   [--mode all-equal|empty]   (default: all-equal)
                   [--source gh|fixture]      (default: gh)
                   [--fixture <set.json>]     (required when --source fixture)
                   [--branch <name>]          (default: main)
                   [--pr-state merged|open|all] (default: merged)
                   [--artifact <runId>:<name>:<kind>:<surface>:<sha>]  (repeatable)
                       kind ∈ junit|coverage|mutation; binds a CI artifact to the
                       check surface it evidences. Artifact auto-discovery is P3;
                       this is the manual P2 path.

Reads GitHub read-only via the authenticated 'gh' CLI. Writes ONLY the two output
files. No records, no ledger, no egress beyond your own gh-authed provider.`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(`run 'node cli.ts' with no arguments for usage`);
  process.exit(1);
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") fail(`missing required ${flag}`);
  return v;
}

function oneOf<T extends string>(v: string, flag: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(v)) fail(`${flag} must be one of ${allowed.join("|")} (got '${v}')`);
  return v as T;
}

/** Parse "owner/name" → RepoRef; reject anything that is not exactly one slash. */
function parseRepo(spec: string): RepoRef {
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail(`--repo entry '${spec}' must be 'owner/name'`);
  return { owner: parts[0], repo: parts[1] };
}

async function cmdScan(args: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      "policy-out": { type: "string" },
      mode: { type: "string" },
      source: { type: "string" },
      fixture: { type: "string" },
      branch: { type: "string" },
      "pr-state": { type: "string" },
      artifact: { type: "string", multiple: true },
    },
  });

  const repos = need(v.repo, "--repo")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseRepo);
  if (repos.length === 0) fail("--repo listed no repositories");

  const outPath = need(v.out, "--out");
  const policyPath = need(v["policy-out"], "--policy-out");
  const mode = oneOf(v.mode ?? "all-equal", "--mode", ["all-equal", "empty"] as const);
  const sourceKind = oneOf(v.source ?? "gh", "--source", ["gh", "fixture"] as const);
  const branch = v.branch ?? "main";
  const prState = oneOf(v["pr-state"] ?? "merged", "--pr-state", ["merged", "open", "all"] as const);
  const artifacts: ArtifactRequest[] = (v.artifact ?? []).map(parseArtifactSpec);

  let source: EvidenceSource;
  if (sourceKind === "fixture") {
    const fixturePath = need(v.fixture, "--fixture (required when --source fixture)");
    const set = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureSet;
    source = new FixtureEvidenceSource(set);
  } else {
    source = new GhApiEvidenceSource();
  }

  const scans: RepoScan[] = [];
  for (const repo of repos) {
    scans.push(await collectScan(source, repo, { prState, branch, artifacts }));
  }

  // The ONE place the clock enters the whole pipeline (Durable Decision 7).
  const map = buildEvidenceMap(scans, { now: new Date().toISOString() });
  const policy = emitStarterPolicy(map, { mode });

  writeFileSync(outPath, JSON.stringify(map, null, 2) + "\n");
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");

  const bs = map.counts.byStrength;
  console.log(`recede-scout: scanned ${map.repos.length} repo(s) via ${sourceKind}`);
  console.log(`  sources    ${map.counts.totalSources} (wired ${map.counts.wiredToTrust})`);
  console.log(
    `  strength   L3 signed=${bs["signed-provenance"]}  L2 required=${bs["required-status-check"]}  ` +
      `L1 optional=${bs["optional-check"]}  L1 self=${bs["self-reported"]}`,
  );
  console.log(`  classes    ${Object.entries(map.counts.byClass).map(([k, n]) => `${k}:${n}`).join("  ") || "(none)"}`);
  if (artifacts.length === 0) {
    console.log(`  artifacts  none requested (pass --artifact to attach CI artifacts; auto-discovery is a P3 skill)`);
  } else {
    console.log(
      `  artifacts  requested=${artifacts.length}  withArtifact=${map.counts.withArtifact}  ` +
        `mutationAdequate=${map.counts.mutationAdequate}`,
    );
  }
  console.log(`  wrote      ${outPath}`);
  console.log(`  wrote      ${policyPath}  (starter policy, mode=${mode}, never_recede intact)`);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
try {
  if (cmd === "scan") await cmdScan(rest);
  else {
    console.error(USAGE);
    process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
