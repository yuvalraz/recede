// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * recede-scout backfill — deterministic replay of ~90 days of merge history into
 * a FileLedger, one warrant per merge, with revert detection resealing REVERTED.
 * This is the substance of the 15-minute AHA (Phase 3.0).
 *
 * SPLIT (design decision 2): PURE builders (`inferTaskType`,
 * `buildBackfillWarrant`, `detectReverts`, `buildRevertReseal`) hold no I/O and no
 * clock — every record `ts` is INJECTED from history (pr.mergedAt / revert date).
 * IMPURE seam-orchestrators (`collectMergeHistory`, `runBackfill`) await the
 * scanner's `EvidenceSource` and fold into the ledger.
 *
 * DECISION 6 (Yuval OVERRIDE): backfill folds under the v0.2 POOLED profile
 * (`referencePolicyV02`) with an ALL-EQUAL placeholder weight table keyed by the
 * classes discovered across the merge history — NO authored magnitude (red-team
 * rule 1). Backfilled warrants POPULATE `evidence_refs` per check surface so the
 * pooled combiner has real per-class evidence to pool (red-team rule 7: pooled,
 * not flat-mean).
 *
 * I2 (A1/A2, the 091042a lesson):
 *  - A1: on a detected revert, STORE the full `replay()` result after appending
 *    the revert OutcomeRecord. Never incrementally `update()` a warrant twice.
 *  - A2: inject ONLY `ts`; NEVER `idle_ms`/drift/decay (status replays with zero
 *    decay, so any incremental decay fold would diverge and fail I2).
 */

import {
  unionChecks,
  classifyClass,
  strengthOf,
  tierOf,
  ALL_EQUAL_PLACEHOLDER,
  type EvidenceSource,
  type RepoRef,
  type RawPullRequest,
  type RawReview,
  type CheckSurface,
} from "./scanner.ts";
import {
  open,
  act,
  makeCheckRecord,
  seal,
  evRef,
  update,
  replay,
  coldStart,
  policyDigest,
  REF_WEIGHTING_V02,
  referencePolicyV02,
  type CheckKind,
  type OutcomeRecord,
  type Policy,
  type Verdict,
  type Warrant,
  type FileLedger,
} from "../../reference/ts/src/index.ts";
import { DEFAULT_TASK_RISK, defaultRiskFor } from "../cc10x/cc10x-adapter.ts";

// ---------------------------------------------------------------------------
// Produced types
// ---------------------------------------------------------------------------

/** One merged PR plus the evidence surfaces reconstructed at its merge SHA. */
export interface MergeBundle {
  pr: RawPullRequest;
  title: string;
  labels: string[];
  reviews: RawReview[];
  surfaces: CheckSurface[];
}

/** A detected revert: the revert PR and the PR number it reverts. */
export interface RevertRef {
  revertPrNumber: number;
  targetPrNumber: number;
  revertedAt: string;
}

/** A revert mapped to its (in-window) target, ready to reseal. */
export interface RevertReseal {
  revert: RevertRef;
}

/** A lane demoted by a detected revert, carried for INDEPENDENT self-check (M1). */
export interface RevertedLane {
  actor: string;
  task: string;
  /**
   * The lane's `sample_count` from the FORWARD fold, captured BEFORE the revert
   * reseal. The demotion property asserts the post-reseal `sample_count` is
   * unchanged (the single warrant collapsed, not doubled) — an independent
   * property, not the tautological replay==stored the revert lane always passes.
   */
  forwardSampleCount: number;
}

/** Honesty counts for a backfill run. */
export interface BackfillReport {
  reconstructed: number;
  forwardSealed: number;
  reverts: number;
  lanes: number;
  /**
   * Merged PRs SKIPPED because they carried a null `mergedAt` (L1). Surfaced so a
   * walk that silently loses merges is visible in the CLI summary rather than
   * vanishing.
   */
  dropped: number;
  /**
   * The lanes a detected revert demoted, with their forward-fold sample_count.
   * The CLI self-check verifies these by the demotion property (tier T0 +
   * unchanged sample_count), NOT by replay==stored (M1: tautological for revert
   * lanes, whose stored trust IS a replay result).
   */
  revertedLanes: RevertedLane[];
  /**
   * The EFFECTIVE policy the fold used (decision 6: v0.2 pooled, ALL-EQUAL
   * placeholder over the discovered classes). Returned so an I2 self-check can
   * `replay` under the SAME policy the ledger was folded with — the frozen
   * `recede-cc10x status` replays under v0.1 and cannot verify a v0.2 ledger.
   */
  policy: Policy;
}

/**
 * The fold-policy sidecar persisted NEXT TO a backfilled ledger
 * (`<ledger>.policy.json`, schema `recede-ledger-policy/1`). It carries what a
 * verifier needs to RECONSTRUCT the fold policy via `referencePolicyV02`
 * (weights + weighting tag + version) plus the policy digest to pin the
 * reconstruction. Chosen over an in-ledger tag line because the reference
 * FileLedger's line format has no foreign-kind tolerance — a tag line would
 * require a kernel change (forbidden); the sidecar is additive, and a ledger
 * without one defaults to the v0.1 coding policy (P3.2, decision-5/6
 * reconciliation).
 */
export interface PolicySidecar {
  schema: "recede-ledger-policy/1";
  id: string;
  version: string;
  weighting: string;
  evidence_weights: NonNullable<Policy["evidence_weights"]>;
  policy_digest: string;
}

/** Build the sidecar for a backfill's fold policy. PURE; v0.2-pooled only. */
export function policySidecar(policy: Policy): PolicySidecar {
  if (policy.weighting !== REF_WEIGHTING_V02) {
    throw new Error(
      `policySidecar: only the v0.2 pooled profile is reconstructible from a sidecar ` +
        `(expected weighting '${REF_WEIGHTING_V02}', got '${policy.weighting ?? "(v0.1 default)"}')`,
    );
  }
  return {
    schema: "recede-ledger-policy/1",
    id: policy.id,
    version: policy.version,
    weighting: policy.weighting,
    evidence_weights: policy.evidence_weights ?? {},
    policy_digest: policyDigest(policy),
  };
}


// ---------------------------------------------------------------------------
// PURE builders
// ---------------------------------------------------------------------------

/**
 * Keyword heuristic → coding lane, ORDERED (first match wins over the combined,
 * lowercased title + labels). Risk-carrying / more-specific lanes are listed
 * first so a generic keyword never steals a match. Unknown → `code.feature` @
 * `reversible.low` (decision 3: conservative-but-non-blocking; lanes are advisory
 * until wired). Pure: string-in, verdict-out, no clock.
 */
const TASK_RULES: ReadonlyArray<{ taskType: string; keywords: readonly string[] }> = [
  { taskType: "code.migrate", keywords: ["migrat", "schema", "backfill"] },
  { taskType: "release.publish", keywords: ["release", "publish", "deploy", "ship "] },
  { taskType: "docs.write", keywords: ["doc", "readme", "changelog"] },
  { taskType: "code.fix", keywords: ["fix", "bug", "hotfix", "patch", "revert"] },
  { taskType: "code.feature", keywords: ["feat", "feature", "add", "implement"] },
];

export function inferTaskType(title: string, labels: string[]): { taskType: string; risk: string } {
  const hay = [title, ...labels].join(" ").toLowerCase();
  for (const rule of TASK_RULES) {
    if (rule.keywords.some((kw) => hay.includes(kw))) {
      return { taskType: rule.taskType, risk: DEFAULT_TASK_RISK[rule.taskType as keyof typeof DEFAULT_TASK_RISK] };
    }
  }
  // Fallback: conservative default lane. defaultRiskFor pins the ratified risk.
  return { taskType: "code.feature", risk: defaultRiskFor("code.feature")! };
}

/**
 * Map a GitHub check/status conclusion to a Recede Verdict. Only an explicit
 * failure/error is FAIL; any indefinite/flaky state (neutral, cancelled,
 * timed_out, stale, skipped, pending, null) is INCONCLUSIVE — never FAIL
 * (red-team rule 6: a flaky check must not crater trust). Pure.
 */
function verdictOf(conclusion: string | null): Verdict {
  const c = (conclusion ?? "").toLowerCase();
  if (c === "success") return "PASS";
  if (c === "failure" || c === "error") return "FAIL";
  return "INCONCLUSIVE";
}

/** The kernel CheckKind (VERIFY|VALIDATE) for a scanner routing hint. */
function checkKindOf(kind: string): CheckKind {
  return kind === "VALIDATE" || kind === "checkpoint" ? "VALIDATE" : "VERIFY";
}

/**
 * Build one hash-covered evidence_ref for a check surface, reusing the scanner's
 * classifier + strength ladder so the v0.2 pooled combiner reads a real
 * (evClass, provTier). The locator is SHA-snapshotted; the evidence author is a
 * neutral "ci" (never the acting agent). No mutation marker — a reconstructed
 * check surface cannot prove assertion strength. Pure.
 */
function refForSurface(surface: CheckSurface): { evClass: string; ref: string; checkKind: CheckKind } {
  const { evClass, checkKind } = classifyClass(surface.name);
  const strength = strengthOf({
    discoveredAs: surface.kind === "check-run" ? "check-run" : "status",
    isRequired: false,
    isSigned: false,
  });
  const provTier = tierOf(strength);
  // evRef forbids '|' in any field. Legal GitHub matrix check NAMES carry '|'
  // (e.g. "build | test"), so the SYNTHETIC fallback locator must sanitize the
  // name too — otherwise a '|' in the name (H1) would throw and abort the whole
  // backfill. The '/' replacement keeps the locator human-readable.
  const safeName = surface.name.replaceAll("|", "/");
  const rawLocator = surface.detailsUrl ?? `${safeName}@${surface.sha}`;
  const locator = rawLocator.includes("|") ? `${safeName}@${surface.sha}` : rawLocator;
  const ref = evRef(evClass, provTier, "ci", surface.sha, locator);
  return { evClass, ref, checkKind: checkKindOf(checkKind) };
}

/**
 * Review states that carry a verdict signal worth folding into a warrant. A
 * COMMENTED / PENDING review is a conversation artifact, not an assertion, so it
 * is skipped (never a check surface).
 */
const REVIEW_VERDICT: Readonly<Record<string, Verdict>> = {
  APPROVED: "PASS",
  // CHANGES_REQUESTED / DISMISSED never FAIL a lane (red-team rule 6: a human's
  // request-for-changes is an indefinite signal, not proof the merge was wrong).
  CHANGES_REQUESTED: "INCONCLUSIVE",
  DISMISSED: "INCONCLUSIVE",
};

/**
 * Build a review-class evidence_ref at the merge SHA. Mirrors `refForSurface`:
 * neutral "ci" author, SHA-snapshotted locator, no mutation marker. The plan
 * (line 138) sources checks from unionChecks verdicts + RawReview state — this is
 * the RawReview half. Pure.
 */
function refForReview(review: RawReview, sha: string): string {
  const { evClass } = classifyClass("code-review");
  const provTier = tierOf(strengthOf({ discoveredAs: "review", isRequired: false, isSigned: false }));
  const locator = `review:${review.author.replaceAll("|", "/")}@${sha}`;
  return evRef(evClass, provTier, "ci", sha, locator);
}

export function buildBackfillWarrant(bundle: MergeBundle): Warrant {
  const pr = bundle.pr;
  const ts = pr.mergedAt;
  if (!ts) {
    throw new Error(`buildBackfillWarrant: PR #${pr.number} has no mergedAt — only merged PRs are backfillable`);
  }
  const { taskType, risk } = inferTaskType(bundle.title, bundle.labels);
  const sha = pr.mergeCommitSha ?? pr.headSha;

  const intent = open({
    actor: pr.author,
    task_type: taskType,
    proposed_action: bundle.title,
    declared_risk: risk,
    expected_effects: [],
    inputs: { pr: pr.number, sha },
    ts,
  });
  const action = act({
    intent,
    operations: [`merge #${pr.number} @ ${sha}`],
    result: { sha },
    ts,
  });
  const surfaceChecks = bundle.surfaces.map((surface) => {
    const { ref, checkKind } = refForSurface(surface);
    return makeCheckRecord({
      action,
      check_kind: checkKind,
      method: surface.name,
      verdict: verdictOf(surface.conclusion),
      confidence: 1,
      evidence_refs: [ref],
      ts,
    });
  });
  // Fold each verdict-carrying RawReview into its own review-class check surface
  // so the pooled combiner reads review as a distinct evidence class. APPROVED →
  // VALIDATE/PASS; CHANGES_REQUESTED/DISMISSED → INCONCLUSIVE (never FAIL).
  const reviewChecks = bundle.reviews
    .filter((rv) => REVIEW_VERDICT[rv.state.toUpperCase()] !== undefined)
    .map((rv) =>
      makeCheckRecord({
        action,
        check_kind: "VALIDATE",
        method: `review:${rv.author}`,
        verdict: REVIEW_VERDICT[rv.state.toUpperCase()],
        confidence: 1,
        evidence_refs: [refForReview(rv, sha)],
        ts,
      }),
    );
  const checks = [...surfaceChecks, ...reviewChecks];
  const prev = checks.length > 0 ? checks[checks.length - 1].id : action.id;
  const outcome = seal({
    warrant_ref: intent.id,
    actor: pr.author,
    result: "SUCCESS",
    ground_truth_source: "backfill:reconstructed",
    prev,
    human_touched: false,
    ts,
  });
  return { intent, action, checks, checkpoints: [], outcome };
}

/**
 * Detect reverts across the merge history and map each to the in-window PR it
 * reverts. Conservative heuristic (in priority order):
 *   1. `Revert "<original title>"` → the bundle whose title === the quoted title,
 *      merged strictly BEFORE the revert;
 *   2. a `#<number>` reference in a revert-titled PR → that PR number if present.
 * A revert with no in-window target is SKIPPED (not an error) — the revert PR
 * still lands as its own forward warrant elsewhere. Pure + order-independent
 * (candidates keyed by title/number; ties broken by the latest earlier merge).
 *
 * KNOWN LIMITATION (L2, unfixed): a double-revert (`Revert "Revert "X""`) marks
 * the ORIGINAL X as REVERTED even though the second revert effectively restores
 * it. The heuristic maps each revert to its immediate target and does not chain.
 */
export function detectReverts(bundles: MergeBundle[]): RevertReseal[] {
  const byNumber = new Map<number, MergeBundle>();
  for (const b of bundles) byNumber.set(b.pr.number, b);

  const reseals: RevertReseal[] = [];
  for (const b of bundles) {
    const revertedAt = b.pr.mergedAt;
    if (!revertedAt) continue;
    const quoted = b.title.match(/^revert\s+"(.+)"\s*(?:\(#\d+\))?$/i);
    let target: MergeBundle | undefined;
    if (quoted) {
      const innerTitle = quoted[1];
      // The newest candidate merged strictly before this revert.
      for (const cand of bundles) {
        if (cand.pr.number === b.pr.number) continue;
        if (cand.title !== innerTitle) continue;
        if (!cand.pr.mergedAt || cand.pr.mergedAt >= revertedAt) continue;
        if (!target || (cand.pr.mergedAt > (target.pr.mergedAt ?? ""))) target = cand;
      }
    }
    // C2: gate the #N fallback on a revert-SHAPED title (starts with "revert"),
    // NOT the word "revert" appearing anywhere. Prose like "Refactor to avoid
    // revert loops (see #40)" must NOT reseal #40.
    if (!target && /^revert\b/i.test(b.title)) {
      const hashRef = b.title.match(/#(\d+)/);
      if (hashRef) {
        const cand = byNumber.get(Number(hashRef[1]));
        if (cand && cand.pr.number !== b.pr.number) target = cand;
      }
    }
    if (target) {
      reseals.push({
        revert: { revertPrNumber: b.pr.number, targetPrNumber: target.pr.number, revertedAt },
      });
    }
  }
  return reseals;
}

/**
 * Build the superseding REVERTED OutcomeRecord for a reverted warrant. ts is the
 * REVERT date (injected from history); the honesty label records that the
 * reversal was reconstructed by detection. Pure. A1: the CALLER appends this and
 * then STORES a full replay() — it must NOT incrementally update() the warrant a
 * second time.
 */
export function buildRevertReseal(target: Warrant, revert: RevertRef): OutcomeRecord {
  return seal({
    warrant_ref: target.intent.id,
    actor: target.intent.actor,
    result: "REVERTED",
    ground_truth_source: "backfill:revert-detected",
    deferred_until: null,
    human_touched: false,
    prev: target.outcome?.id ?? target.intent.id,
    ts: revert.revertedAt,
  });
}

// ---------------------------------------------------------------------------
// IMPURE orchestrators (stubs — RED)
// ---------------------------------------------------------------------------

const DEFAULT_SINCE_DAYS = 90;

/**
 * Walk the merged-PR history into per-PR `MergeBundle`s. IMPURE: awaits the
 * scanner seam (`listPullRequests` + per-SHA `unionChecks(getCombinedStatus,
 * listCheckRunsForRef)` + `listReviews`). The `sinceDays` window is a gh-side
 * QUERY optimization only (via `since`) — it never enters a record, so record
 * `ts`s stay history-injected and determinism is unaffected. Bundles are sorted
 * deterministically by (mergedAt, number) so the fold order equals the ledger's
 * append/replay order (I2).
 */
export async function collectMergeHistory(
  source: EvidenceSource,
  repo: RepoRef,
  opts?: { sinceDays?: number },
): Promise<{ bundles: MergeBundle[]; dropped: number }> {
  const days = opts?.sinceDays ?? DEFAULT_SINCE_DAYS;
  // Window is a query hint for the live gh adapter; the FixtureEvidenceSource
  // ignores `since`, so offline tests stay deterministic. Not a record ts.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const prs = await source.listPullRequests(repo, { state: "merged", since });

  const bundles: MergeBundle[] = [];
  let dropped = 0;
  for (const pr of prs) {
    if (!pr.merged) continue;
    // A merged PR with no merge date cannot inject a deterministic ts, so it is
    // skipped — but COUNTED (L1), not silently lost.
    if (!pr.mergedAt) {
      dropped += 1;
      continue;
    }
    const sha = pr.mergeCommitSha ?? pr.headSha;
    const [checkRuns, combined, reviews] = await Promise.all([
      source.listCheckRunsForRef(repo, sha),
      source.getCombinedStatus(repo, sha),
      source.listReviews(repo, pr.number),
    ]);
    bundles.push({
      pr,
      title: pr.title ?? "",
      labels: pr.labels ?? [],
      reviews,
      surfaces: unionChecks(combined, checkRuns),
    });
  }
  bundles.sort((a, b) => {
    const ta = a.pr.mergedAt ?? "";
    const tb = b.pr.mergedAt ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.pr.number - b.pr.number;
  });
  return { bundles, dropped };
}

/**
 * Build the ALL-EQUAL placeholder v0.2 policy for the classes DISCOVERED across
 * a set of warrants' evidence (decision 6). Each discovered evClass (excluding
 * "unknown") gets every observed provTier set to the scanner's
 * `ALL_EQUAL_PLACEHOLDER` — NO authored magnitude (red-team rule 1). Pooling can
 * only ADD, so this satisfies rule 7 (pooled, not flat-mean). Pure over the
 * warrants.
 */
function allEqualPolicyFor(warrants: Warrant[]): Policy {
  const table: Record<string, Record<string, number>> = {};
  for (const w of warrants) {
    for (const c of w.checks) {
      for (const ref of c.evidence_refs) {
        const parts = ref.split("|");
        if (parts[0] !== "ev1") continue;
        const evClass = parts[1];
        const tier = parts[2];
        if (evClass === "unknown" || !evClass) continue;
        (table[evClass] ??= {})[tier] = ALL_EQUAL_PLACEHOLDER;
      }
    }
  }
  return referencePolicyV02(table);
}

/**
 * Replay ~90 days of merge history into the FileLedger: one warrant per merge,
 * folded under the v0.2 POOLED profile (decision 6), with reverts resealed
 * REVERTED. IMPURE (ledger writes) but CLOCK-FREE for record data — every `ts`
 * is injected from history, so a re-run over a fixed snapshot is byte-identical.
 *
 * I2 discipline:
 *  - forward fold: per lane, `update()` from the lane's last stored trust with
 *    `now` INJECTED from the outcome ts (never the clock) and ZERO decay (A2),
 *    then `putTrust`. Append order == fold order == replay order.
 *  - revert (A1): append the REVERTED OutcomeRecord (ts = revert date), then
 *    STORE the FULL `replay()` result for the affected lane — never a second
 *    incremental `update()` on the same warrant (which would double-count).
 */
export async function runBackfill(
  source: EvidenceSource,
  repo: RepoRef,
  ledger: FileLedger,
  opts?: { sinceDays?: number; policy?: Policy },
): Promise<BackfillReport> {
  // C1: backfill APPENDS to whatever ledger it is handed. A re-run on a ledger
  // that already holds records would double every record + sample_count, and the
  // I2 self-check would greenlight the doubled state (replay == doubled-stored).
  // Require a FRESH ledger — fail loud rather than silently corrupt trust.
  if (ledger.records().length > 0) {
    throw new Error("backfill requires a fresh ledger; the supplied ledger is non-empty");
  }

  const { bundles, dropped } = await collectMergeHistory(source, repo, { sinceDays: opts?.sinceDays });
  const warrants = bundles.map(buildBackfillWarrant);
  const policy = opts?.policy ?? allEqualPolicyFor(warrants);

  const byPr = new Map<number, Warrant>();
  const lanes = new Set<string>();

  // Forward fold: append records, fold each warrant into its lane's running trust.
  for (const w of warrants) {
    byPr.set(intentPrNumber(w), w);
    ledger.append(w.intent);
    if (w.action) ledger.append(w.action);
    for (const c of w.checks) ledger.append(c);
    if (w.outcome) ledger.append(w.outcome);

    const actor = w.intent.actor;
    const task = w.intent.task_type;
    lanes.add(`${actor} ${task}`);
    const prev = ledger.getTrust(actor, task) ?? coldStart(actor, task);
    // A2: inject ONLY `now` (the outcome ts) — no idle_ms/drift/decay.
    const next = update(prev, w, policy, { now: w.outcome?.ts }).state;
    ledger.putTrust(next);
  }

  // Reverts: reseal REVERTED at the revert date, then STORE a full replay (A1).
  const reseals = detectReverts(bundles);
  let reverts = 0;
  const revertedLanes: RevertedLane[] = [];
  for (const reseal of reseals) {
    const target = byPr.get(reseal.revert.targetPrNumber);
    if (!target) continue; // out-of-window target → skip, never crash
    const actor = target.intent.actor;
    const task = target.intent.task_type;
    // Capture the FORWARD-fold sample_count BEFORE the reseal — the demotion
    // property (M1) asserts it is unchanged after the reveal collapses the warrant.
    const forwardSampleCount = (ledger.getTrust(actor, task) ?? coldStart(actor, task)).sample_count;
    const outcome = buildRevertReseal(target, reseal.revert);
    ledger.append(outcome);
    const refolded = replay(actor, task, ledger.warrantsFor(actor, task), policy);
    ledger.putTrust(refolded);
    revertedLanes.push({ actor, task, forwardSampleCount });
    reverts += 1;
  }

  return {
    reconstructed: warrants.length,
    forwardSealed: 0,
    reverts,
    lanes: lanes.size,
    dropped,
    revertedLanes,
    policy,
  };
}

/** The PR number recorded in a backfill warrant's intent inputs (for revert mapping). */
function intentPrNumber(w: Warrant): number {
  // The intent's operation encodes `merge #<n> @ <sha>`; parse it back.
  const op = w.action?.operations[0] ?? "";
  const m = op.match(/#(\d+)/);
  return m ? Number(m[1]) : -1;
}
