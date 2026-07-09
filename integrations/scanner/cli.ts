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
import { FileLedger, coldStart, replay } from "../../reference/ts/src/index.ts";
import { inferTaskType, policySidecar, runBackfill } from "./backfill.ts";
import type { IntentRecord } from "../../reference/ts/src/index.ts";

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
                       check surface it evidences. When OMITTED, artifacts are
                       AUTO-discovered from each run's artifact list (expired +
                       unrecognized names skipped); supplying the flag overrides
                       auto-discovery entirely.

  node cli.ts backfill --repo <owner/name> --ledger <path.jsonl>
                       [--source gh|fixture]      (default: gh)
                       [--fixture <set.json>]     (required when --source fixture)
                       [--since-days <n>]         (default: 90)
       Replays ~90 days of merge history into a FileLedger (one warrant per merge,
       reverts resealed REVERTED), folded under the v0.2 pooled profile with an
       ALL-EQUAL placeholder weight table. Deterministic; ts injected from history.
       The ledger is personal STATE_DIR data — never commit it.

  node cli.ts infer-task --title "<PR title>" [--labels a,b] [--json]
       Prints '<taskType> <risk>' (or JSON with --json) using the SAME pure lane
       inference the backfill uses — so forward records land on the lanes the
       backfilled history earned. No network, no writes.

Reads GitHub read-only via the authenticated 'gh' CLI. 'scan' writes ONLY the two
output files; 'backfill' writes ONLY the caller-supplied --ledger. No egress beyond
your own gh-authed provider.`;

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
    // No --artifact flags → leave `artifacts` UNSUPPLIED so collectScan runs
    // auto-discovery (P3.3); an explicit flag overrides auto entirely.
    scans.push(
      await collectScan(source, repo, {
        prState,
        branch,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      }),
    );
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
    const found = scans.reduce((n, s) => n + (s.autoDiscovery?.found ?? 0), 0);
    const attached = scans.reduce((n, s) => n + (s.autoDiscovery?.attached ?? 0), 0);
    console.log(
      `  artifacts  auto-discovery: found ${found} artifact(s), attached ${attached} ` +
        `(withArtifact=${map.counts.withArtifact}; pass --artifact to override)`,
    );
  } else {
    console.log(
      `  artifacts  requested=${artifacts.length}  withArtifact=${map.counts.withArtifact}  ` +
        `mutationAdequate=${map.counts.mutationAdequate}`,
    );
  }
  console.log(`  wrote      ${outPath}`);
  console.log(`  wrote      ${policyPath}  (starter policy, mode=${mode}, never_recede intact)`);
}

// ---------------------------------------------------------------------------
// backfill — replay ~90 days of merge history into a FileLedger (P3.0)
// ---------------------------------------------------------------------------

async function cmdBackfill(args: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      ledger: { type: "string" },
      source: { type: "string" },
      fixture: { type: "string" },
      "since-days": { type: "string" },
    },
  });

  const repo = parseRepo(need(v.repo, "--repo"));
  // The ledger path is ALWAYS caller-supplied — never a repo-internal default
  // (Durable Decision 8: the ledger is personal STATE_DIR data, never committed).
  const ledgerPath = need(v.ledger, "--ledger");
  const sourceKind = oneOf(v.source ?? "gh", "--source", ["gh", "fixture"] as const);
  const sinceDays = v["since-days"] ? Number(v["since-days"]) : undefined;
  if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0)) {
    fail(`--since-days must be a positive number (got '${v["since-days"]}')`);
  }

  let source: EvidenceSource;
  if (sourceKind === "fixture") {
    const fixturePath = need(v.fixture, "--fixture (required when --source fixture)");
    source = new FixtureEvidenceSource(JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureSet);
  } else {
    source = new GhApiEvidenceSource();
  }

  const ledger = new FileLedger(ledgerPath);
  // C1: backfill appends; a re-run on an existing non-empty ledger would silently
  // DOUBLE every record + sample_count (and the I2 self-check would still pass on
  // the doubled state). Refuse loud — require a fresh path.
  if (ledger.records().length > 0) {
    fail(`--ledger ${ledgerPath} exists / non-empty; backfill requires a fresh path`);
  }
  const report = await runBackfill(source, repo, ledger, { sinceDays });

  // Persist the fold policy as a SIDECAR next to the ledger (decision-5/6
  // reconciliation): `recede-cc10x status` reads it and replays under the SAME
  // v0.2 policy the fold used. Never committed — it lives with the ledger.
  const sidecarPath = `${ledgerPath}.policy.json`;
  writeFileSync(sidecarPath, JSON.stringify(policySidecar(report.policy), null, 2) + "\n");

  console.log(`recede-scout backfill: ${repo.owner}/${repo.repo} via ${sourceKind}`);
  console.log(`  reconstructed  ${report.reconstructed} warrant(s) across ${report.lanes} lane(s)`);
  console.log(`  reverts        ${report.reverts} resealed REVERTED`);
  console.log(`  dropped        ${report.dropped} merged PR(s) skipped (null mergedAt)`);
  console.log(`  forwardSealed  ${report.forwardSealed} (backfill records nothing forward)`);
  console.log(`  wrote          ${ledgerPath}`);
  console.log(`  wrote          ${sidecarPath}  (fold-policy sidecar; status replays under it)`);

  // I2 self-check under the SAME v0.2 policy the ledger was folded with. The
  // frozen `recede-cc10x status` replays under v0.1 (codingPolicy) and therefore
  // cannot verify a v0.2-pooled ledger — so backfill proves I2 itself, honestly.
  const seen = new Set<string>();
  const lanes: { actor: string; task: string }[] = [];
  for (const r of ledger.records()) {
    if (r.kind !== "INTENT") continue;
    const i = r as IntentRecord;
    const key = `${i.actor} ${i.task_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lanes.push({ actor: i.actor, task: i.task_type });
  }
  // M1: split the self-check by lane kind so it does not OVERSTATE independence.
  //  - FORWARD lanes: genuine replay() == stored (the incremental fold matches a
  //    pure re-fold — real I2 evidence).
  //  - REVERT lanes: stored trust IS a replay() result, so replay==stored is
  //    tautological. Verify an INDEPENDENT demotion property instead: the lane
  //    demoted to the floor tier (T0) AND its sample_count is unchanged from the
  //    forward fold (the single warrant collapsed, not doubled).
  const revertKeys = new Map(report.revertedLanes.map((r) => [`${r.actor} ${r.task}`, r.forwardSampleCount]));
  let forwardOk = 0;
  let forwardTotal = 0;
  let revertOk = 0;
  for (const lane of lanes) {
    const key = `${lane.actor} ${lane.task}`;
    const stored = ledger.getTrust(lane.actor, lane.task) ?? coldStart(lane.actor, lane.task);
    if (revertKeys.has(key)) {
      const forwardSampleCount = revertKeys.get(key)!;
      if (stored.tier === "T0" && stored.sample_count === forwardSampleCount) revertOk++;
    } else {
      forwardTotal++;
      const replayed = replay(lane.actor, lane.task, ledger.warrantsFor(lane.actor, lane.task), report.policy);
      const i2 =
        stored.tier === replayed.tier &&
        Math.abs(stored.score - replayed.score) < 1e-9 &&
        Math.abs(stored.confidence - replayed.confidence) < 1e-9 &&
        stored.sample_count === replayed.sample_count;
      if (i2) forwardOk++;
    }
  }
  const revertTotal = report.revertedLanes.length;
  const allOk = forwardOk === forwardTotal && revertOk === revertTotal;
  console.log(
    `  I2 replay integrity: ${allOk ? "PASS" : "FAIL"} — ` +
      `forward replay()==stored ${forwardOk}/${forwardTotal}, ` +
      `revert lanes demoted ${revertOk}/${revertTotal} ` +
      `(policy ${report.policy.id}@${report.policy.version})`,
  );

  // Honesty labels (marketing §3 + decision 6). These are RECONSTRUCTED rows.
  console.log("");
  console.log("  note: reconstructed, unsealed, from API state as of backfill.");
  console.log("        hash-chain integrity starts at the first forward-sealed warrant.");
  console.log(
    "        trust computed under the v0.2 pooled profile with an ALL-EQUAL placeholder weight",
  );
  console.log(
    "        table — these weights are yours to declare, not a prediction; edit them in the PR.",
  );

  if (!allOk) process.exit(1);
}

// ---------------------------------------------------------------------------
// infer-task — the SAME lane inference the backfill uses (lane continuity)
// ---------------------------------------------------------------------------

/**
 * Thin CLI over the pure `inferTaskType` so the emitted record workflow routes
 * forward records through the exact inference the backfill applied to history.
 * PURE passthrough: no network, no clock, no writes.
 */
function cmdInferTask(args: string[]): void {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      title: { type: "string" },
      labels: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const title = need(v.title, "--title");
  const labels = (v.labels ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const { taskType, risk } = inferTaskType(title, labels);
  console.log(v.json ? JSON.stringify({ taskType, risk }) : `${taskType} ${risk}`);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
try {
  if (cmd === "scan") await cmdScan(rest);
  else if (cmd === "backfill") await cmdBackfill(rest);
  else if (cmd === "infer-task") cmdInferTask(rest);
  else {
    console.error(USAGE);
    process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
