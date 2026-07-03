#!/usr/bin/env node
// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Offline full-loop proof of the OpenWiki trust wrap. NO network, NO LLM, NO
 * OpenWiki install: the generator is a fixture (`fake-openwiki.ts`) that writes
 * pages, writes-then-deletes `_plan.md`, and drops `.last-update.json` — the
 * exact upstream behavior the wrapper exists to survive. We drive the real CLI
 * (`node cli.ts <cmd>` via spawnSync) against a throwaway git repo and watch a
 * page's trust go ε -> seal -> decay -> broken-sample, then prove the sidecar
 * replays byte-identically from the ledger alone.
 *
 *   node integrations/openwiki/demo.ts
 *
 * House convention: assert-based, exit 0, deterministic. Time decay over the
 * demo's own wall-clock elapsed is negligible-but-nonzero, so score beats use
 * computed-expected tolerance (never exact-equality against a hand-constant).
 * The assertion counter is snapshotted BEFORE the final guard (the guard is
 * itself an assert and would otherwise read N+1).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FileLedger, type Warrant } from "../../reference/ts/src/index.ts";
import {
  DOC_MAP_TASK,
  diffDecay,
  eventOf,
  FENCE_BEGIN,
  sealRaise,
  TRUST_CONSTANTS as C,
  type Sidecar,
} from "./openwiki-adapter.ts";
import { planFileName } from "./cli.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const FIXTURE = join(import.meta.dirname, "test", "fixtures", "fake-openwiki.ts");
const ACTOR = "openwiki"; // the CLI's default generator

const EXPECTED_ASSERTIONS = 52;
let assertions = 0;
function assert(cond: boolean, msg: string): void {
  assertions += 1;
  if (!cond) {
    console.error(`\n  x ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${msg}`);
  }
}

// --- process helpers -------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[], cwd: string): CliResult {
  const res = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function git(args: string[], cwd: string): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}
function commit(cwd: string, msg: string): void {
  git(["add", "-A"], cwd);
  git(["-c", "user.email=demo@recede.dev", "-c", "user.name=demo", "commit", "-q", "-m", msg], cwd);
}
function headSha(cwd: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
}

// --- fs helpers ------------------------------------------------------------

function treeSet(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.add(relative(root, abs));
    }
  };
  walk(root);
  return out;
}
const readState = (repo: string): Sidecar =>
  JSON.parse(readFileSync(join(repo, "openwiki", ".trust", "state.json"), "utf8")) as Sidecar;
const warrantsOf = (ledger: string): Warrant[] =>
  new FileLedger(ledger).warrantsFor(ACTOR, DOC_MAP_TASK);
const laneScore = (ledger: string): number =>
  new FileLedger(ledger).getTrust(ACTOR, DOC_MAP_TASK)?.score ?? 0;

/** A fresh throwaway git repo with two source files + an AGENTS.md. */
function scaffoldRepo(): { repo: string; ledger: string; head: string; agents0: string } {
  const repo = mkdtempSync(join(tmpdir(), "openwiki-demo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "parser.ts"), "export function parseAll() {}\n");
  writeFileSync(join(repo, "src", "utils.ts"), "export function helperFn() {}\n");
  const agents0 = "# Agents\n";
  writeFileSync(join(repo, "AGENTS.md"), agents0);
  git(["init", "-q"], repo);
  commit(repo, "init");
  return { repo, ledger: join(repo, ".trust-ledger.jsonl"), head: headSha(repo), agents0 };
}

const BAR = "=".repeat(74);
console.log(BAR);
console.log("OpenWiki x Recede — per-page trust, wrapped: offline full-loop proof");
console.log("(fixture generator; no network, no LLM, no OpenWiki install)");
console.log(BAR);

// ---------------------------------------------------------------------------
// [1] Arrange: throwaway repo, snapshot the tree.
// ---------------------------------------------------------------------------
const { repo, ledger, head, agents0 } = scaffoldRepo();
const treeBefore = treeSet(repo);

// ---------------------------------------------------------------------------
// [2] run --inject: generate the wiki, seal one doc.map warrant, fence AGENTS.md.
// ---------------------------------------------------------------------------
const runRes = cli(
  ["run", "--ledger", ledger, "--dir", repo, "--inject", "--", "node", FIXTURE, "openwiki", "--head", head],
  repo,
);
assert(runRes.code === 0, `run exited ${runRes.code}: ${runRes.stderr}`);
let state = readState(repo);
const pagePaths = Object.keys(state.pages).sort();
assert(pagePaths.length === 3, `expected 3 pages, got ${pagePaths.length}`);
assert(
  pagePaths.every((p) => state.pages[p].score === C.EPSILON),
  "every fresh page starts at the epsilon floor",
);
assert(
  pagePaths.every((p) => state.pages[p].band === "warning"),
  "a fresh epsilon page bands 'warning' (verify against sources)",
);
const planFiles = readdirSync(join(repo, "openwiki", ".trust", "plans"));
assert(planFiles.length === 1, "exactly one plan snapshot exists (no orphan from a pre-seal write)");
// The snapshot filename DERIVES from the run warrant's ts (not a second, drifting
// wall-clock read), and is written only post-seal — so a seal throw leaves no orphan.
const runWarrant = warrantsOf(ledger).find((w) => eventOf(w)?.kind === "run");
assert(
  !!runWarrant && planFiles[0] === planFileName(runWarrant.intent.ts) + ".md",
  "the plan snapshot filename derives from the run warrant's ts",
);
const agentsAfterRun = readFileSync(join(repo, "AGENTS.md"), "utf8");
assert(agentsAfterRun.split(FENCE_BEGIN).length - 1 === 1, "AGENTS.md has exactly one trust fence");
console.log("\n[2] run    -> 3 pages @ e=0.25 (warning); plan snapshotted; fence injected");

// ---------------------------------------------------------------------------
// [3] Write-boundary proof: only openwiki/**, TRUST.md, ledger are new; AGENTS
//     changed only by appending the fence (its original prefix is preserved).
// ---------------------------------------------------------------------------
const treeAfter = treeSet(repo);
const added = [...treeAfter].filter((p) => !treeBefore.has(p));
const inBoundary = (p: string): boolean =>
  p.startsWith("openwiki/") || p === "TRUST.md" || p === ".trust-ledger.jsonl";
const escapes = added.filter((p) => !inBoundary(p));
assert(escapes.length === 0, `writes escaped the boundary: ${escapes.join(", ")}`);
assert(agentsAfterRun.startsWith(agents0), "AGENTS.md original prefix preserved (fence only appended)");
console.log(`[3] boundary -> new paths all under openwiki/**, TRUST.md, ledger (${added.length} files)`);

// ---------------------------------------------------------------------------
// [4] seal: a human raises the parser page. (Seal BEFORE decay: diffDecay
//     floors at e, so a fresh e-page shows no observable diff-drop.)
// ---------------------------------------------------------------------------
const sealRes = cli(
  ["seal", "--ledger", ledger, "--dir", repo, "--page", "openwiki/parser.md", "--human", "yuval"],
  repo,
);
assert(sealRes.code === 0, `seal exited ${sealRes.code}: ${sealRes.stderr}`);
state = readState(repo);
const sealed = sealRaise(C.EPSILON); // 0.55
assert(state.pages["openwiki/parser.md"].score === sealed, `seal raises e -> ${sealed}`);
assert(state.pages["openwiki/parser.md"].band === "ok", "a sealed page bands 'ok'");
assert(state.pages["openwiki/parser.md"].sealedBy === "yuval", "the human seal is recorded");
console.log(`[4] seal   -> parser.md ${C.EPSILON} -> ${sealed} (warning -> ok), sealed by yuval`);

// ---------------------------------------------------------------------------
// [5] decay (targeted): touch src/parser.ts; only the parser-citing page drops.
// ---------------------------------------------------------------------------
writeFileSync(join(repo, "src", "parser.ts"), "export function parseAll() { return 1; }\n");
commit(repo, "modify parser");
const decayRes = cli(["decay", "--ledger", ledger, "--dir", repo], repo);
assert(decayRes.code === 0, `decay exited ${decayRes.code}: ${decayRes.stderr}`);
state = readState(repo);
const parserScore = state.pages["openwiki/parser.md"].score;
const expectDecayed = diffDecay(sealed); // 0.275; time decay lowers it negligibly
assert(parserScore < sealed, `decay dropped parser.md (${parserScore} < ${sealed})`);
assert(
  Math.abs(parserScore - expectDecayed) < 1e-4 && parserScore <= expectDecayed + 1e-12,
  `parser.md decayed to ~${expectDecayed} (computed diffDecay, time-decay tolerance), got ${parserScore}`,
);
assert(state.pages["openwiki/parser.md"].band === "warning", "the decayed page re-bands to 'warning'");
assert(state.pages["openwiki/utils.md"].score === C.EPSILON, "the untouched utils page stays floored at e");
assert(state.pages["openwiki/overview.md"].score === C.EPSILON, "the sourceless overview page stays floored at e");
console.log(`[5] decay  -> parser.md ${sealed} -> ~${expectDecayed} (ok -> warning); utils/overview stay @ e`);

// ---------------------------------------------------------------------------
// [6] sample (broken ref): delete src/utils.ts; the utils page bands 'action'
//     and the sample warrant seals FAILURE (the generator lane loses trust).
// ---------------------------------------------------------------------------
const laneBefore = laneScore(ledger);
rmSync(join(repo, "src", "utils.ts"));
commit(repo, "delete utils");
const sampleRes = cli(["sample", "--ledger", ledger, "--dir", repo, "--n", "3", "--seed", "7"], repo);
assert(sampleRes.code === 0, `sample exited ${sampleRes.code}: ${sampleRes.stderr}`);
state = readState(repo);
assert(state.pages["openwiki/utils.md"].band === "action", "a page citing a now-missing file bands 'action'");
const sampleWarrant = warrantsOf(ledger).find((w) => eventOf(w)?.kind === "sample");
assert(sampleWarrant?.outcome?.result === "FAILURE", "the broken-ref sample seals a FAILURE outcome");
const laneAfter = laneScore(ledger);
assert(laneAfter < laneBefore, `the generator lane lost trust (${laneAfter} < ${laneBefore})`);
console.log(`[6] sample -> utils.md action (missing file); sample=FAILURE; lane ${laneBefore.toFixed(3)} -> ${laneAfter.toFixed(3)}`);

// ---------------------------------------------------------------------------
// [7] replay: warrants are the only truth — rebuild the sidecar byte-identically.
// ---------------------------------------------------------------------------
const stateFile = join(repo, "openwiki", ".trust", "state.json");
const copy = join(repo, "state.copy.json");
copyFileSync(stateFile, copy);
rmSync(stateFile);
const replayRes = cli(["replay", "--ledger", ledger, "--dir", repo, "--write"], repo);
assert(replayRes.code === 0, `replay --write exited ${replayRes.code}: ${replayRes.stderr}`);
assert(
  readFileSync(stateFile, "utf8") === readFileSync(copy, "utf8"),
  "replay --write reproduces state.json byte-identically from the ledger alone",
);
rmSync(copy);
console.log("[7] replay -> state.json rebuilt byte-identically from warrants (state was deleted)");

// ---------------------------------------------------------------------------
// [7b] status + bare replay: the read surfaces the plan claimed (integrity
//      check @ this beat) but never exercised. status prints the per-page table
//      and the SIDECAR REPLAY integrity line; bare replay reports MATCH.
// ---------------------------------------------------------------------------
const statusRes = cli(["status", "--ledger", ledger, "--dir", repo], repo);
assert(statusRes.code === 0, `status exits 0 (got ${statusRes.code}: ${statusRes.stderr})`);
assert(/SIDECAR REPLAY: PASS/.test(statusRes.stdout), "status prints the SIDECAR REPLAY integrity line (PASS)");
assert(/openwiki\/parser\.md/.test(statusRes.stdout), "status prints a per-page table row");
const replayCheck = cli(["replay", "--ledger", ledger, "--dir", repo], repo);
assert(replayCheck.code === 0, `bare replay exits 0 when the sidecar matches (got ${replayCheck.code})`);
assert(/\bMATCH\b/.test(replayCheck.stdout), "bare replay reports MATCH against the on-disk sidecar");
console.log("[7b] status -> SIDECAR REPLAY: PASS + per-page table; bare replay -> MATCH");

// ---------------------------------------------------------------------------
// [8] fence idempotence: inject twice, AGENTS.md is byte-identical.
// ---------------------------------------------------------------------------
cli(["inject", "--ledger", ledger, "--dir", repo], repo);
const agentsOnce = readFileSync(join(repo, "AGENTS.md"), "utf8");
cli(["inject", "--ledger", ledger, "--dir", repo], repo);
const agentsTwice = readFileSync(join(repo, "AGENTS.md"), "utf8");
assert(agentsOnce === agentsTwice, "inject is idempotent — a second run does not change AGENTS.md");
// inject reads the sidecar + writes the fence only; it never opens the ledger,
// so it must work WITHOUT --ledger.
const injectNoLedger = cli(["inject", "--dir", repo], repo);
assert(injectNoLedger.code === 0, `inject works without --ledger (got ${injectNoLedger.code}: ${injectNoLedger.stderr})`);
console.log("[8] inject -> idempotent; works without --ledger (never opens the ledger)");

// ---------------------------------------------------------------------------
// [9] error paths: failed child seals nothing; --no-plan is an honest gap;
//     --no-last-update degrades the gitHead binding.
// ---------------------------------------------------------------------------
// [9a] failed generation -> non-zero passthrough, ledger untouched.
const failRepo = scaffoldRepo();
const before9a = warrantsOf(failRepo.ledger).length;
const failRes = cli(
  ["run", "--ledger", failRepo.ledger, "--dir", failRepo.repo, "--", "node", FIXTURE, "openwiki", "--head", failRepo.head, "--fail"],
  failRepo.repo,
);
assert(failRes.code === 3, `a failed child passes through its exit code (got ${failRes.code})`);
assert(warrantsOf(failRepo.ledger).length === before9a, "a failed run seals NO warrant");
assert(
  !existsSync(join(failRepo.repo, "openwiki", ".trust")),
  "a failed run leaves NO .trust scaffold (the 'nothing mutated' claim is now honest)",
);

// [9b] no _plan.md -> run succeeds; the plan snapshot is an honest 'absent' gap.
const noPlanRepo = scaffoldRepo();
const noPlanRes = cli(
  ["run", "--ledger", noPlanRepo.ledger, "--dir", noPlanRepo.repo, "--", "node", FIXTURE, "openwiki", "--head", noPlanRepo.head, "--no-plan"],
  noPlanRepo.repo,
);
assert(noPlanRes.code === 0, `run with no plan still succeeds (got ${noPlanRes.code})`);
const noPlanRun = warrantsOf(noPlanRepo.ledger).find((w) => eventOf(w)?.kind === "run");
const noPlanEvent = noPlanRun ? eventOf(noPlanRun) : undefined;
assert(
  noPlanEvent?.kind === "run" && noPlanEvent.planSnapshot === null,
  "the run event records planSnapshot: null (never fabricated)",
);
const planCheck = noPlanRun?.checks.find((c) => c.method === "openwiki:plan-snapshot");
assert(planCheck?.verdict === "INCONCLUSIVE", "the missing plan is an INCONCLUSIVE check (evidence gap, not failure)");

// [9c] no .last-update.json -> degraded-head binding recorded.
const degradedRepo = scaffoldRepo();
const degradedRes = cli(
  ["run", "--ledger", degradedRepo.ledger, "--dir", degradedRepo.repo, "--", "node", FIXTURE, "openwiki", "--head", degradedRepo.head, "--no-last-update"],
  degradedRepo.repo,
);
assert(degradedRes.code === 0, `run with no .last-update.json still succeeds (got ${degradedRes.code})`);
const degradedRun = warrantsOf(degradedRepo.ledger).find((w) => eventOf(w)?.kind === "run");
const degradedEvent = degradedRun ? eventOf(degradedRun) : undefined;
assert(
  degradedEvent?.kind === "run" && degradedEvent.gitHeadSource === "degraded-head",
  "a missing .last-update.json degrades the gitHead binding to git rev-parse HEAD",
);

// [9d] missing generator binary -> spawn emits 'error' (ENOENT) with NO exit
//      code, a distinct path from child-non-zero. run must fail fast with an
//      install hint and seal nothing.
const enoentRepo = scaffoldRepo();
const before9d = warrantsOf(enoentRepo.ledger).length;
const enoentRes = cli(
  ["run", "--ledger", enoentRepo.ledger, "--dir", enoentRepo.repo, "--", "openwiki-definitely-not-installed-xyz"],
  enoentRepo.repo,
);
assert(enoentRes.code !== 0, `a missing generator binary fails fast (got exit ${enoentRes.code})`);
assert(/not found|install/i.test(enoentRes.stderr), "the ENOENT failure carries an install hint");
assert(warrantsOf(enoentRepo.ledger).length === before9d, "a missing-binary run seals NO warrant");
assert(
  !existsSync(join(enoentRepo.repo, "openwiki", ".trust")),
  "a missing-binary run leaves NO .trust scaffold",
);
console.log(
  "[9] errors -> failed child + missing-binary(ENOENT) seal nothing; --no-plan honest-gap; --no-last-update degraded-head",
);

// ---------------------------------------------------------------------------
// [10] stale sidecar head: after a force-push/rebase/GC the recorded gitHead is
//      unknown to the repo. decay must distinguish that from "not a repo" and
//      point at the recovery path — not blame the repo.
// ---------------------------------------------------------------------------
const staleRepo = scaffoldRepo();
cli(
  ["run", "--ledger", staleRepo.ledger, "--dir", staleRepo.repo, "--", "node", FIXTURE, "openwiki", "--head", staleRepo.head],
  staleRepo.repo,
);
const staleStatePath = join(staleRepo.repo, "openwiki", ".trust", "state.json");
const staleSc = JSON.parse(readFileSync(staleStatePath, "utf8")) as Sidecar;
staleSc.gitHead = "0123456789abcdef0123456789abcdef01234567"; // valid-format, unknown to the repo
writeFileSync(staleStatePath, JSON.stringify(staleSc, null, 2) + "\n");
const staleDecay = cli(["decay", "--ledger", staleRepo.ledger, "--dir", staleRepo.repo], staleRepo.repo);
assert(staleDecay.code !== 0, `decay on a stale sidecar head fails (got ${staleDecay.code})`);
assert(
  /unknown revision|stale/i.test(staleDecay.stderr),
  "a stale head is reported as an unknown revision, not 'not a repo'",
);
assert(
  /replay --write|git fetch/i.test(staleDecay.stderr),
  "the stale-head error points at the recovery path (replay --write / git fetch)",
);
console.log("[10] stale-head decay -> 'unknown revision' + recovery hint (not conflated with not-a-repo)");

// ---------------------------------------------------------------------------
// [11] unwritable AGENTS.md (a directory): the fence write fails AFTER the
//      warrant is sealed and state.json/TRUST.md written. The trust event must
//      stand, the failure must be reported clearly (no raw stack), and the
//      operator must be told to re-run `inject`, not `run` (which double-seals).
// ---------------------------------------------------------------------------
const badAgentsRepo = scaffoldRepo();
rmSync(join(badAgentsRepo.repo, "AGENTS.md"));
mkdirSync(join(badAgentsRepo.repo, "AGENTS.md")); // AGENTS.md is now a DIRECTORY -> EISDIR on read
const badAgentsRes = cli(
  ["run", "--ledger", badAgentsRepo.ledger, "--dir", badAgentsRepo.repo, "--inject", "--", "node", FIXTURE, "openwiki", "--head", badAgentsRepo.head],
  badAgentsRepo.repo,
);
assert(badAgentsRes.code === 0, `a bad AGENTS.md does NOT fail the run — trust is sealed (got ${badAgentsRes.code}: ${badAgentsRes.stderr})`);
assert(/fence could not be updated/i.test(badAgentsRes.stderr), "the fence failure is reported clearly (not a raw EISDIR stack)");
assert(/re-run .*inject/i.test(badAgentsRes.stderr), "the message tells the operator to re-run inject, not run");
assert(warrantsOf(badAgentsRepo.ledger).length === 1, "the run warrant is sealed despite the fence failure");
assert(
  existsSync(join(badAgentsRepo.repo, "openwiki", ".trust", "state.json")),
  "state.json is written despite the fence failure (the operator is not misled into re-running run)",
);
console.log("[11] bad AGENTS.md -> warrant+sidecar intact; clear fence-failure message; re-run inject (not run)");

// Cleanup the throwaway repos (best-effort).
for (const dir of [repo, failRepo.repo, noPlanRepo.repo, degradedRepo.repo, enoentRepo.repo, staleRepo.repo, badAgentsRepo.repo]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
}

// ---------------------------------------------------------------------------
// [10] Guard: snapshot the counter BEFORE the guard assert (it is itself an
//      assert; printing the live counter would read N+1).
// ---------------------------------------------------------------------------
console.log("\n" + BAR);
const ran = assertions;
assert(ran === EXPECTED_ASSERTIONS, `expected ${EXPECTED_ASSERTIONS} assertions to run, got ${ran}`);
console.log(`  ${ran}/${EXPECTED_ASSERTIONS} assertions passed. Warrants are the only truth;`);
console.log("  the sidecar is a cache you can throw away and replay.");
console.log(BAR + "\n");
