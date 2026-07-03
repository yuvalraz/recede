#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * openwiki-trust — a thin CLI that wraps an OpenWiki generator run under
 * Recede. It owns ALL process/fs/git I/O; the adapter (openwiki-adapter.ts)
 * stays a pure mapping core and the sampler (sampler.ts) does the mechanical
 * re-verification. Zero runtime dependencies; Node >= 22.18 (native type
 * stripping AND the `import.meta.main` guard below — silently a no-op on
 * 22.6-22.17, so the run-if-main guard would never fire there). The ledger path
 * is ALWAYS caller-supplied — nothing is ever written to a default location.
 *
 *   node cli.ts run    --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki] [--inject] [-- <cmd...>]
 *   node cli.ts decay  --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki]
 *   node cli.ts seal   --ledger <path> --page <p> [--page <p2>...] --human <id> [--dir .] [--wiki openwiki] [--actor openwiki]
 *   node cli.ts sample --ledger <path> [--n 3] [--seed <int>] [--dir .] [--wiki openwiki] [--actor openwiki]
 *   node cli.ts status --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki]
 *   node cli.ts replay --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki] [--write]
 *   node cli.ts inject --ledger <path> [--dir .] [--wiki openwiki] [--create]
 *
 * Warrants in the ledger are the ONLY truth; the per-page sidecar
 * (<wiki>/.trust/state.json) is a derived cache, byte-reconstructible via
 * `replay`. OpenWiki itself is NEVER forked or patched — this is a wrap.
 *
 * ponytail: single-runner assumption — no lockfile; concurrent runs are
 * last-writer-wins on state.json. Upgrade path: an O_EXCL .trust/lock file.
 */

import { parseArgs } from "node:util";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  watch,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  FileLedger,
  coldStart,
  digest,
  gate,
  RISK_ORDER,
  type Policy,
  type TrustState,
} from "../../reference/ts/src/index.ts";
import {
  DOC_MAP_TASK,
  docPolicy,
  emptySidecar,
  extractSources,
  foldEvent,
  foldWarrants,
  renderFenceBlock,
  renderTrustDelta,
  renderTrustMd,
  runChecks,
  decayChecks,
  sampleChecks,
  sealChecks,
  sealEventWarrant,
  spliceFence,
  type SampleResult,
  type Sidecar,
  type WikiEvent,
} from "./openwiki-adapter.ts";
import { MechanicalVerifier, samplePages, verifyPage } from "./sampler.ts";

// ---------------------------------------------------------------------------
// Usage + small helpers
// ---------------------------------------------------------------------------

const USAGE = `openwiki-trust — per-page trust for an OpenWiki wiki, under Recede

usage:
  node cli.ts run    --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki] [--inject] [-- <cmd...>]
  node cli.ts decay  --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki]
  node cli.ts seal   --ledger <path> --page <p> [--page <p2>...] --human <id> [--dir .] [--wiki openwiki] [--actor openwiki]
  node cli.ts sample --ledger <path> [--n 3] [--seed <int>] [--dir .] [--wiki openwiki] [--actor openwiki]
  node cli.ts status --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki]
  node cli.ts replay --ledger <path> [--dir .] [--wiki openwiki] [--actor openwiki] [--write]
  node cli.ts inject --ledger <path> [--dir .] [--wiki openwiki] [--create]

the ledger path is always caller-supplied; OpenWiki is never forked or patched.`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(`run 'node cli.ts' with no arguments for usage`);
  process.exit(1);
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") fail(`missing required ${flag}`);
  return v;
}

/**
 * A tiny seeded PRNG so `sample --seed <int>` is reproducible run-to-run
 * (the sampler takes a plain `() => number`; this is where the CLI's seed
 * becomes one). mulberry32 is a well-known 32-bit generator: fast, tiny, and
 * good enough for staleness-weighted page selection — NOT for anything
 * security-sensitive. Returns fractions in [0, 1).
 * ponytail: no crypto-grade RNG here; page sampling has no adversary.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Turn an ISO timestamp into a legal plan-snapshot filename by replacing the
 * ':' separators (illegal on some filesystems). The caller appends ".md".
 */
export function planFileName(iso: string): string {
  return iso.replace(/:/g, "-");
}

/** Parse an integer flag; NaN (a non-numeric arg) fails clearly, never throws through. */
function parseIntArg(s: string, flag: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) fail(`${flag} must be an integer (got '${s}')`);
  return n;
}

// The four options every command shares. Ledger is always caller-supplied.
const COMMON_OPTS = {
  ledger: { type: "string" },
  dir: { type: "string" },
  wiki: { type: "string" },
  actor: { type: "string" },
} as const;

interface Common {
  ledgerPath: string;
  repoRoot: string;
  wiki: string;
  wikiDir: string;
  actor: string;
}

function resolveCommon(v: {
  ledger?: string;
  dir?: string;
  wiki?: string;
  actor?: string;
}): Common {
  const ledgerPath = need(v.ledger, "--ledger");
  const repoRoot = resolve(v.dir ?? ".");
  const wiki = v.wiki ?? "openwiki";
  return { ledgerPath, repoRoot, wiki, wikiDir: join(repoRoot, wiki), actor: v.actor ?? "openwiki" };
}

// ---------------------------------------------------------------------------
// Sidecar + artifact fs (the write boundary: <wiki>/.trust, TRUST.md, fence)
// ---------------------------------------------------------------------------

const trustDir = (wikiDir: string) => join(wikiDir, ".trust");
const statePath = (wikiDir: string) => join(trustDir(wikiDir), "state.json");
const plansDir = (wikiDir: string) => join(trustDir(wikiDir), "plans");

function loadSidecar(wikiDir: string): Sidecar | null {
  const p = statePath(wikiDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Sidecar;
}

/** Serialize deterministically (2-space indent + trailing newline) — replay must byte-match this. */
function serializeSidecar(sidecar: Sidecar): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

function writeSidecar(wikiDir: string, sidecar: Sidecar): void {
  mkdirSync(trustDir(wikiDir), { recursive: true });
  // ponytail: tmp-write + rename makes each state.json update atomic — a
  // reader (status/replay) never sees a half-written/torn sidecar. This is NOT
  // concurrency safety: the single-runner ceiling still holds (last-writer-wins;
  // the upgrade path is the O_EXCL .trust/lock file noted at the top).
  const target = statePath(wikiDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, serializeSidecar(sidecar));
  renameSync(tmp, target);
}

/**
 * Compute the new AGENTS.md content for the trust fence. Returns null to mean
 * "leave the file alone / do not create". Throws on corrupt markers (via
 * spliceFence) BEFORE any write, so a corrupt file is never touched.
 * - existing null (no file): create the file iff `create`.
 * - fence present: refresh it (idempotent).
 * - file present, no fence: append the block iff `create`; else leave alone.
 */
function fenceContent(existing: string | null, block: string, create: boolean): string | null {
  if (existing === null) return create ? block + "\n" : null;
  const spliced = spliceFence(existing, block); // null = no fence; throws on corrupt
  if (spliced !== null) return spliced;
  if (!create) return null;
  const gap = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + gap + block + "\n";
}

function writeFenceToAgents(repoRoot: string, sidecar: Sidecar, create: boolean): void {
  const agentsPath = join(repoRoot, "AGENTS.md");
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null;
  const next = fenceContent(existing, renderFenceBlock(sidecar), create);
  if (next !== null) writeFileSync(agentsPath, next);
}

/** Rewrite the full derived surface: state.json, TRUST.md, and the fence. */
function writeArtifacts(repoRoot: string, wikiDir: string, sidecar: Sidecar, injectFence: boolean): void {
  writeSidecar(wikiDir, sidecar);
  writeFileSync(join(repoRoot, "TRUST.md"), renderTrustMd(sidecar));
  // By the time we touch AGENTS.md the trust event is ALREADY sealed and
  // state.json + TRUST.md are written. A fence-write failure (AGENTS.md is a
  // directory/unwritable -> EISDIR/EACCES, or corrupt markers) must NOT surface
  // as a raw error that makes the operator think nothing happened and re-run
  // `run` (which would seal a SECOND warrant). Warn precisely and exit clean:
  // the durable trust record stands; only the optional fence is stale.
  try {
    writeFenceToAgents(repoRoot, sidecar, injectFence);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `warning: trust event sealed and state.json + TRUST.md written, but the ` +
        `AGENTS.md fence could not be updated (${reason}). Fix AGENTS.md, then re-run ` +
        `\`openwiki-trust inject\` — do NOT re-run \`run\`, which would seal a second warrant.`,
    );
  }
}

// ---------------------------------------------------------------------------
// git + wiki scanning
// ---------------------------------------------------------------------------

/** Read the gitHead OpenWiki drops in `.last-update.json`; null when absent/unusable. */
function readLastUpdateHead(wikiDir: string): string | null {
  const p = join(wikiDir, ".last-update.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { gitHead?: unknown };
    return typeof parsed.gitHead === "string" && parsed.gitHead ? parsed.gitHead : null;
  } catch {
    return null;
  }
}

function gitHeadOrFail(repoRoot: string, context: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (err) {
    fail(`${context}: git unavailable or not a repo (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface DiskPage {
  path: string;
  sources: string[];
  contentDigest: string;
}

/**
 * Scan every `*.md` under the wiki dir (excluding `.trust/`), sorted by path so
 * the run event's page order is deterministic — which keeps state.json's key
 * order (and thus byte-identical replay) stable.
 */
function scanPages(wikiDir: string, repoRoot: string): DiskPage[] {
  const out: DiskPage[] = [];
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === ".trust") continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = readFileSync(abs, "utf8");
        out.push({
          path: relative(repoRoot, abs),
          sources: extractSources(content, repoRoot),
          contentDigest: digest(content),
        });
      }
    }
  };
  walk(wikiDir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// run — wrap the generator child, snapshot _plan.md, seal one doc.map warrant
// ---------------------------------------------------------------------------

async function cmdRun(rest: string[]): Promise<void> {
  const dashIdx = rest.indexOf("--");
  const optArgs = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
  const childArgv = dashIdx === -1 ? [] : rest.slice(dashIdx + 1);
  const { values: v } = parseArgs({
    args: optArgs,
    strict: true,
    options: { ...COMMON_OPTS, inject: { type: "boolean" } },
  });
  const { ledgerPath, repoRoot, wiki, wikiDir, actor } = resolveCommon(v);
  const [childCmd, ...childArgs] = childArgv.length ? childArgv : ["openwiki"];

  // The watcher needs wikiDir to exist BEFORE the child writes into it (to
  // catch the ephemeral _plan.md). Create ONLY wikiDir here — NOT the .trust/
  // sidecar scaffold: a failed run seals no warrant and writes no trust state,
  // so it must not leave a .trust/ directory behind (the plans dir is created
  // post-seal, where the snapshot is actually written).
  mkdirSync(wikiDir, { recursive: true });

  // Watch for the ephemeral _plan.md; keep the LATEST content we manage to read
  // before OpenWiki deletes it. Read races are ignored (keep-latest semantics).
  let planContent: string | null = null;
  const watcher = watch(wikiDir, (_event, filename) => {
    if (filename !== "_plan.md") return;
    try {
      planContent = readFileSync(join(wikiDir, "_plan.md"), "utf8");
    } catch {
      /* race: file already gone / not readable yet — keep the latest good read */
    }
  });

  // Spawn the child. A missing binary emits an 'error' event (ENOENT) with NO
  // exit code — a distinct path from a child that runs and exits non-zero.
  // Both seal NO warrant and write NO trust state (the generator's own partial
  // output under wikiDir is its business, not the wrap's — so we claim only
  // what the wrap controls, never a blanket "nothing mutated").
  const childCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(childCmd, childArgs, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", (err) => {
      watcher.close();
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        fail(
          `could not spawn '${childCmd}': not found. Install OpenWiki, or pass '-- <cmd>' ` +
            `pointing at its binary. No warrant sealed; no trust state written.`,
        );
      }
      fail(`failed to spawn '${childCmd}': ${e.message}. No warrant sealed; no trust state written.`);
    });
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
  watcher.close();

  if (childCode !== 0) {
    console.error(`child '${childCmd}' exited ${childCode} — no warrant sealed; no trust state written.`);
    process.exit(childCode);
  }

  // gitHead: prefer OpenWiki's .last-update.json, else degrade to `git rev-parse HEAD`.
  const fromLastUpdate = readLastUpdateHead(wikiDir);
  const gitHead = fromLastUpdate ?? gitHeadOrFail(repoRoot, "run");
  const gitHeadSource: "last-update" | "degraded-head" = fromLastUpdate ? "last-update" : "degraded-head";

  // One wall-clock read for the whole run: it is BOTH the warrant's ts (via
  // now() below) AND the plan-snapshot filename, so the snapshot name DERIVES
  // from the warrant ts — no second, drifting clock read.
  const runTs = new Date().toISOString();

  // The plan-snapshot PATH is decided now (it rides in the sealed event), but
  // the FILE is written only AFTER the seal succeeds — so a seal throw leaves
  // no orphan snapshot on disk.
  const planSnapshot: string | null =
    planContent !== null ? join(wiki, ".trust", "plans", planFileName(runTs) + ".md") : null;

  const current = loadSidecar(wikiDir) ?? emptySidecar(actor);
  const diskPages = scanPages(wikiDir, repoRoot);
  const diskPaths = new Set(diskPages.map((p) => p.path));
  const removed = Object.keys(current.pages).filter((p) => !diskPaths.has(p));
  // New-or-changed pages become event entries; unchanged pages keep their trust.
  const changedPages = diskPages.filter((p) => {
    const prev = current.pages[p.path];
    return !prev || prev.contentDigest !== p.contentDigest;
  });

  const event: WikiEvent = {
    kind: "run",
    runId: randomUUID(),
    gitHead,
    gitHeadSource,
    planSnapshot,
    pages: changedPages,
    removed,
  };
  const checks = runChecks({
    childExit: childCode,
    pageCount: diskPages.length,
    gitHeadSource,
    planSnapshot: planSnapshot ? "captured" : "absent",
  });
  const { warrant } = await sealEventWarrant({
    ledger: new FileLedger(ledgerPath),
    policy: docPolicy(),
    generator: actor,
    event,
    intent: `openwiki run @ ${gitHead.slice(0, 7)}`,
    checks,
    groundTruth: "openwiki-artifacts",
    now: () => runTs, // warrant.intent.ts === runTs, so the snapshot name derives from it
  });

  // Post-seal: materialize the plan snapshot INSIDE the write boundary now that
  // the warrant stands. The .trust/plans dir is created HERE (not before the
  // spawn) so a failed run leaves no .trust/ scaffold; the filename is
  // planFileName(warrant.intent.ts).
  if (planContent !== null && planSnapshot !== null) {
    mkdirSync(plansDir(wikiDir), { recursive: true });
    writeFileSync(join(repoRoot, planSnapshot), planContent);
  }

  const next = foldEvent(current, event, warrant.intent.id, warrant.intent.ts);
  writeArtifacts(repoRoot, wikiDir, next, v.inject === true);
  console.log(renderTrustDelta(current, next));
}

// ---------------------------------------------------------------------------
// decay — git diff attribution + time decay for all pages
// ---------------------------------------------------------------------------

async function cmdDecay(rest: string[]): Promise<void> {
  const { values: v } = parseArgs({ args: rest, strict: true, options: { ...COMMON_OPTS } });
  const { ledgerPath, repoRoot, wikiDir, actor } = resolveCommon(v);
  const current = loadSidecar(wikiDir);
  if (!current) fail("no sidecar state — run `openwiki-trust run` (or `replay --write`) first");

  // Two distinct git failures, kept distinct (the old single catch labelled a
  // stale-revision error "not a repo"): rev-parse HEAD proves we ARE in a git
  // repo; only after that can a `<fromHead>..HEAD` diff failure be attributed to
  // an unknown/GC'd revision (a sidecar gitHead left stale by force-push/rebase).
  let toHead: string;
  try {
    toHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (err) {
    fail(
      `decay cannot read HEAD: git unavailable or not a repo ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let changedFiles: string[];
  try {
    const diff = execFileSync("git", ["diff", "--name-only", `${current.gitHead}..HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    changedFiles = diff.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    // We ARE in a repo (rev-parse HEAD succeeded), so a diff failure means the
    // sidecar's fromHead is unknown to this repo — stale after a force-push,
    // rebase, or GC. Rebuild the cursor rather than blaming the repo.
    fail(
      `decay cannot diff from the sidecar's recorded head ${current.gitHead.slice(0, 12)}: ` +
        `unknown revision — the sidecar is stale (force-push / rebase / GC?). ` +
        `Re-run after \`git fetch\`, or rebuild the sidecar with \`openwiki-trust replay --write\`. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const event: WikiEvent = {
    kind: "decay",
    runId: randomUUID(),
    fromHead: current.gitHead,
    toHead,
    changedFiles,
    nowMs: Date.now(),
  };
  // Decay is lane-neutral bookkeeping: no verify checks (see decayChecks).
  const checks = decayChecks();
  const { warrant } = await sealEventWarrant({
    ledger: new FileLedger(ledgerPath),
    policy: docPolicy(),
    generator: actor,
    event,
    intent: `decay ${current.gitHead.slice(0, 7)}..${toHead.slice(0, 7)} (${changedFiles.length} changed)`,
    checks,
    groundTruth: "git-diff",
  });
  const next = foldEvent(current, event, warrant.intent.id, warrant.intent.ts);
  writeArtifacts(repoRoot, wikiDir, next, false);
  console.log(renderTrustDelta(current, next));
}

// ---------------------------------------------------------------------------
// seal — a human raises page trust via a VALIDATE warrant
// ---------------------------------------------------------------------------

async function cmdSeal(rest: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args: rest,
    strict: true,
    options: { ...COMMON_OPTS, page: { type: "string", multiple: true }, human: { type: "string" } },
  });
  const { ledgerPath, repoRoot, wikiDir, actor } = resolveCommon(v);
  const pages = v.page ?? [];
  if (pages.length === 0) fail("seal requires at least one --page");
  const human = need(v.human, "--human");
  const current = loadSidecar(wikiDir);
  if (!current) fail("no sidecar state — run `openwiki-trust run` first");
  const unknown = pages.filter((p) => !current.pages[p]);
  if (unknown.length) fail(`unknown page(s): ${unknown.join(", ")} — see TRUST.md for the page list`);

  const event: WikiEvent = { kind: "seal", runId: randomUUID(), pages, human };
  const { warrant } = await sealEventWarrant({
    ledger: new FileLedger(ledgerPath),
    policy: docPolicy(),
    generator: actor,
    event,
    intent: `human seal by ${human}: ${pages.join(", ")}`,
    checks: sealChecks(human),
    groundTruth: "human-seal",
    humanTouched: true,
  });
  const next = foldEvent(current, event, warrant.intent.id, warrant.intent.ts);
  writeArtifacts(repoRoot, wikiDir, next, false);
  console.log(renderTrustDelta(current, next));
}

// ---------------------------------------------------------------------------
// sample — staleness-weighted mechanical re-verification at HEAD
// ---------------------------------------------------------------------------

async function cmdSample(rest: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args: rest,
    strict: true,
    options: { ...COMMON_OPTS, n: { type: "string" }, seed: { type: "string" } },
  });
  const { ledgerPath, repoRoot, wikiDir, actor } = resolveCommon(v);
  const current = loadSidecar(wikiDir);
  if (!current) fail("no sidecar state — run `openwiki-trust run` first");

  const n = parseIntArg(v.n ?? "3", "--n");
  const seed = v.seed !== undefined ? parseIntArg(v.seed, "--seed") : undefined;
  const rand = seed !== undefined ? mulberry32(seed) : Math.random;
  const picks = samplePages(current, n, Date.now(), rand);
  if (picks.length === 0) fail("no pages to sample");

  const verifier = new MechanicalVerifier(repoRoot);
  const results: SampleResult[] = [];
  for (const path of picks) results.push(await verifyPage(repoRoot, current.pages[path], verifier));

  const event: WikiEvent = { kind: "sample", runId: randomUUID(), results };
  const { warrant } = await sealEventWarrant({
    ledger: new FileLedger(ledgerPath),
    policy: docPolicy(),
    generator: actor,
    event,
    intent: `mechanical sample of ${results.length} page(s)`,
    checks: sampleChecks(results),
    groundTruth: "mechanical-sample",
  });
  const next = foldEvent(current, event, warrant.intent.id, warrant.intent.ts);
  writeArtifacts(repoRoot, wikiDir, next, false);

  for (const r of results) {
    console.log(`  ${r.page}: ${r.refsBroken}/${r.refsChecked} broken${r.anyMissing ? " (cited file missing)" : ""}`);
    for (const e of r.evidence) console.log(`    - ${e}`);
  }
  console.log(renderTrustDelta(current, next));
}

// ---------------------------------------------------------------------------
// status — per-page table + doc.map lane trust + sidecar replay integrity
// ---------------------------------------------------------------------------

function posture(trust: TrustState, risk: string, policy: Policy): string {
  const g = gate(trust, risk, policy);
  const never = policy.never_recede.includes(risk) ? ",never-recedes" : "";
  return g.autonomous ? "autonomous" : `checkpoint(${g.altitude}${never})`;
}

function cmdStatus(rest: string[]): void {
  const { values: v } = parseArgs({ args: rest, strict: true, options: { ...COMMON_OPTS } });
  const { ledgerPath, wikiDir } = resolveCommon(v);
  const current = loadSidecar(wikiDir);
  if (!current) fail("no sidecar state — run `openwiki-trust run` (or `replay --write`) first");
  const actor = v.actor ?? current.generator;

  const pages = Object.values(current.pages).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const now = Date.now();
  const wP = Math.max(4, ...pages.map((p) => p.path.length));
  console.log(`${"PAGE".padEnd(wP)}  SCORE  BAND     SEALED-BY  HEAD     AGE`);
  for (const p of pages) {
    const ageDays = ((now - p.lastEventMs) / 86_400_000).toFixed(1);
    console.log(
      `${p.path.padEnd(wP)}  ${p.score.toFixed(3)}  ${p.band.padEnd(7)}  ` +
        `${(p.sealedBy ?? "—").padEnd(9)}  ${p.gitHead.slice(0, 7).padEnd(7)}  ${ageDays}d`,
    );
  }

  const policy = docPolicy();
  const ledger = new FileLedger(ledgerPath);
  const trust = ledger.getTrust(actor, DOC_MAP_TASK) ?? coldStart(actor, DOC_MAP_TASK);
  console.log(
    `\nlane (${actor}, ${DOC_MAP_TASK}): tier=${trust.tier} score=${trust.score.toFixed(3)} ` +
      `conf=${trust.confidence.toFixed(3)} n=${trust.sample_count}`,
  );
  console.log(`gate: ${RISK_ORDER.map((r) => `${r}=${posture(trust, r, policy)}`).join("  ")}`);

  // Sidecar integrity: the ledger replay must byte-match the on-disk state.json.
  const replayed = foldWarrants(actor, ledger.warrantsFor(actor, DOC_MAP_TASK));
  const match = serializeSidecar(replayed) === serializeSidecar(current);
  console.log(`SIDECAR REPLAY: ${match ? "PASS" : "FAIL"}`);
  if (!match) process.exit(1);
}

// ---------------------------------------------------------------------------
// replay — rebuild the sidecar from the ledger's doc.map warrants
// ---------------------------------------------------------------------------

function cmdReplay(rest: string[]): void {
  const { values: v } = parseArgs({
    args: rest,
    strict: true,
    options: { ...COMMON_OPTS, write: { type: "boolean" } },
  });
  const { ledgerPath, repoRoot, wikiDir, actor } = resolveCommon(v);
  const ledger = new FileLedger(ledgerPath);
  const rebuilt = foldWarrants(actor, ledger.warrantsFor(actor, DOC_MAP_TASK)); // throws naming first bad warrant

  if (v.write) {
    writeArtifacts(repoRoot, wikiDir, rebuilt, false);
    console.log(`replayed ${Object.keys(rebuilt.pages).length} page(s) from the ledger -> ${statePath(wikiDir)}`);
    return;
  }
  const current = loadSidecar(wikiDir);
  if (!current) {
    console.log("NO SIDECAR — rebuilt in memory; use --write to materialize it");
    return;
  }
  const match = serializeSidecar(rebuilt) === serializeSidecar(current);
  console.log(
    match
      ? "MATCH — sidecar is byte-identical to the ledger replay"
      : "MISMATCH — sidecar diverges from the ledger; use --write to rebuild",
  );
  if (!match) process.exit(1);
}

// ---------------------------------------------------------------------------
// inject — install / refresh the AGENTS.md trust fence
// ---------------------------------------------------------------------------

function cmdInject(rest: string[]): void {
  const { values: v } = parseArgs({
    args: rest,
    strict: true,
    options: { ...COMMON_OPTS, create: { type: "boolean" } },
  });
  // inject only READS the sidecar and WRITES the AGENTS.md fence — it never
  // opens the ledger, so --ledger is NOT required here (it stays an accepted
  // no-op flag via COMMON_OPTS for invocation symmetry). Resolve dirs inline
  // rather than through resolveCommon, which would demand --ledger.
  const repoRoot = resolve(v.dir ?? ".");
  const wikiDir = join(repoRoot, v.wiki ?? "openwiki");
  const current = loadSidecar(wikiDir);
  if (!current) fail("no sidecar state — run `openwiki-trust run` first");
  const agentsPath = join(repoRoot, "AGENTS.md");
  if (!existsSync(agentsPath) && v.create !== true) {
    fail("AGENTS.md not found — pass --create to create it with the trust fence");
  }
  try {
    writeFenceToAgents(repoRoot, current, true); // file exists or --create given: create/refresh
  } catch (err) {
    // A directory/unwritable AGENTS.md or corrupt markers must fail with a clear
    // message, never a raw EISDIR/EACCES stack.
    fail(`could not write the AGENTS.md fence (${err instanceof Error ? err.message : String(err)}) — fix AGENTS.md and retry`);
  }
  console.log(`fence written to ${agentsPath}`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  try {
    switch (cmd) {
      case "run":
        await cmdRun(rest);
        break;
      case "decay":
        await cmdDecay(rest);
        break;
      case "seal":
        await cmdSeal(rest);
        break;
      case "sample":
        await cmdSample(rest);
        break;
      case "status":
        cmdStatus(rest);
        break;
      case "replay":
        cmdReplay(rest);
        break;
      case "inject":
        cmdInject(rest);
        break;
      default:
        console.error(USAGE);
        process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
    }
  } catch (err) {
    // parseArgs throws on unknown/malformed flags; keep the exit path uniform.
    fail(err instanceof Error ? err.message : String(err));
  }
}

if (import.meta.main) {
  await main();
}
