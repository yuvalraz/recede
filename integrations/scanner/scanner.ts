// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * recede-scout — read-only evidence-discovery scanner (Phase 2).
 *
 * P2.0 establishes ONLY the data-source seam: the `Raw*` provider-shaped types,
 * the `EvidenceSource` transport interface, and the pure in-memory
 * `FixtureEvidenceSource` that drives the (later) pure classifier offline. NO
 * classification, union, map assembly, parsers, or real transport live here yet
 * (those are P2.1–P2.5).
 *
 * Purity note (Durable Decision 3): the seam is transport-only. Every method
 * returns provider-shaped, loosely-typed raw records; nothing here classifies,
 * labels, or unions — that is the pure layer's job in later phases.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { referencePolicyV02, type Policy } from "../../reference/ts/src/index.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The seam — RepoRef + Raw* provider-shaped types (verbatim from the plan)
// ---------------------------------------------------------------------------

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RawPullRequest {
  number: number;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  author: string;
  mergedAt: string | null;
  /**
   * OPTIONAL + ADDITIVE (P3.0). The PR title + labels drive backfill's task-type
   * inference and revert detection. Optional so the frozen P2 scan path (which
   * never reads them) is byte-unaffected; `parsePullRequests` populates them from
   * the gh payload, and fixtures may carry them verbatim.
   */
  title?: string;
  labels?: string[];
}

export interface RawReview {
  prNumber: number;
  state: string;
  author: string;
  submittedAt: string | null;
}

export interface RawWorkflowRun {
  id: number;
  name: string;
  path: string;
  headSha: string;
  conclusion: string | null;
  event: string;
}

export interface RawCheckRun {
  name: string;
  headSha: string;
  conclusion: string | null;
  status: string;
  detailsUrl: string | null;
  app: string | null;
}

export interface RawStatusContext {
  context: string;
  state: string;
  targetUrl: string | null;
}

export interface RawCombinedStatus {
  sha: string;
  state: string;
  statuses: RawStatusContext[];
}

export interface RawBranchProtection {
  branch: string;
  requiredStatusChecks: string[];
  requiresReview: boolean;
}

export interface RawDeployment {
  id: number;
  environment: string;
  sha: string;
  state: string;
}

export interface RawAttestation {
  subjectDigest: string;
  predicateType: string;
  bundleUrl: string | null;
}

export interface RawFile {
  path: string;
  ref: string;
  contentSha: string;
  text: string;
}

export interface RawSecurityAlert {
  id: string;
  kind: string;
  state: string;
  severity: string;
}

/**
 * A LISTED (not yet downloaded) run artifact off the artifacts-list endpoint
 * (P3.3). Drives artifact AUTO-discovery: `expired` artifacts are skipped (GitHub
 * retains artifacts ~90 days), and `digest` (`sha256:…`, present where the API
 * provides it — absent on older gh/API) drives attestation enumeration. A digest
 * is NEVER fabricated: when the field is absent it stays `undefined` and the
 * attestation path degrades honestly to `[]`.
 */
export interface RawRunArtifact {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  digest?: string;
}

/**
 * An unzipped run artifact: a map of file-path -> file-text (Locked decision 3).
 * `gh run download` performs the unzip, so this is the shape the pure artifact
 * parsers (P2.4) consume — ZERO new deps, no manual ZIP handling.
 */
export interface ArtifactFiles {
  name: string;
  files: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The pluggable data source (read-only; no egress beyond the adopter's providers)
// ---------------------------------------------------------------------------

/**
 * The data-source seam. Three concrete adapters implement it: the pure
 * `FixtureEvidenceSource` (this phase), and — in P2.5 — `GhApiEvidenceSource`
 * (shells `gh`) and the `McpEvidenceSource` scaffold. All methods are
 * read-only. `downloadRunArtifact` is included now so the seam is complete;
 * the gh-api/MCP implementations and the pure parsers land in later phases.
 */
export interface EvidenceSource {
  /**
   * The provenance tag stamped onto every `RepoScan`/map entry this source
   * produces. Optional + additive (P2.5): the frozen `FixtureEvidenceSource`,
   * `GhApiEvidenceSource`, and `McpEvidenceSource` each advertise it so
   * `collectScan` can carry provenance without a separate opt.
   */
  readonly discoveredVia?: "mcp" | "gh-api" | "fixture";
  listPullRequests(
    repo: RepoRef,
    opts?: { state?: "merged" | "open" | "all"; since?: string },
  ): Promise<RawPullRequest[]>;
  listReviews(repo: RepoRef, prNumber: number): Promise<RawReview[]>;
  listWorkflowRuns(repo: RepoRef, opts?: { headSha?: string }): Promise<RawWorkflowRun[]>;
  /** List a workflow run's artifacts (P3.3 auto-discovery seam; read-only). */
  listRunArtifacts(repo: RepoRef, runId: number): Promise<RawRunArtifact[]>;
  listCheckRunsForRef(repo: RepoRef, sha: string): Promise<RawCheckRun[]>;
  getCombinedStatus(repo: RepoRef, sha: string): Promise<RawCombinedStatus>;
  getBranchProtection(repo: RepoRef, branch: string): Promise<RawBranchProtection | null>;
  listDeployments(repo: RepoRef, opts?: { sha?: string }): Promise<RawDeployment[]>;
  listAttestations(repo: RepoRef, subjectDigest: string): Promise<RawAttestation[]>;
  getFileContent(repo: RepoRef, path: string, ref?: string): Promise<RawFile | null>;
  listSecurityAlerts(repo: RepoRef): Promise<RawSecurityAlert[]>;
  downloadRunArtifact(
    repo: RepoRef,
    runId: number,
    artifactName: string,
  ): Promise<ArtifactFiles | null>;
}

// ---------------------------------------------------------------------------
// Classification + strength ladder — PURE, source-agnostic (Durable Decision 3)
//
// All functions below are pure: no I/O, no clock, no Date/Math.random. They read
// primitives and read-only fields off their inputs and never mutate a passed-in
// array or object. Fully deterministic (I7-style).
// ---------------------------------------------------------------------------

/** The provenance-strength ladder label (strongest → weakest). */
export type StrengthLabel =
  | "signed-provenance"
  | "required-status-check"
  | "optional-check"
  | "self-reported";

/** Provenance tier, derived from the strength label via `tierOf`. */
export type ProvTier = "L1" | "L2" | "L3";

/** Routing hint for a P3 wire step (verifier/validate/gate/human). */
export type EvCheckKind = "VERIFY" | "VALIDATE" | "gate-only" | "checkpoint";

/**
 * A single discovered evidence source, mapped onto Recede's evClass/provTier
 * vocabulary. The field names deliberately pre-match `EvidenceInput`
 * (`integrations/cc10x/cc10x-adapter.ts`) so a P3 `/recede-wire` skill can build
 * an evRef verbatim from an entry. The optional `artifact` field (Locked
 * decision 3) is defined now but populated by the P2.4 parsers; because it is
 * optional the schemaVersion stays `recede-evidence-map/1`.
 */
export interface EvidenceMapEntry {
  repo: string; // "owner/name"
  sourceKey: string; // stable, deterministic id (sort key)
  evClass: string; // see classifyClass' taxonomy
  checkKind: EvCheckKind; // routing hint for a P3 wire step
  strength: StrengthLabel; // the provenance-strength ladder label
  provTier: ProvTier; // derived from strength (see tierOf)
  sha: string | null; // SHA the check-run/status was SNAPSHOTTED at; null for repo-level sources
  wiredToTrust: boolean; // does this source currently feed a Recede gate? Fresh adopter => always false
  locator: string; // URL/URI to the source (a P3 skill uses this verbatim as an evRef locator)
  discoveredVia: "mcp" | "gh-api" | "fixture";
  artifact?: {
    kind: "junit" | "coverage" | "mutation";
    testCount?: number;
    failures?: number;
    coveragePct?: number;
    mutationScore?: number;
    mutationAdequate?: boolean;
  };
}

/**
 * Keyword table for `classifyClass`, ORDERED by priority (first match wins). More
 * specific / narrower classes are listed before broader ones so a generic keyword
 * never steals a match:
 *   - `codeowners` first (its own file name).
 *   - `deploy` before `review` so `deploy-preview` maps to deploy, not review
 *     (the substring "review" hides inside "preview").
 *   - `e2e`/`integration` before `unit` so "integration test" is not mislabeled unit.
 * Matching is case-insensitive substring on the source name; deterministic.
 */
const CLASS_RULES: ReadonlyArray<{
  evClass: string;
  checkKind: EvCheckKind;
  keywords: readonly string[];
}> = [
  { evClass: "codeowners", checkKind: "checkpoint", keywords: ["codeowners"] },
  {
    evClass: "attestation",
    checkKind: "VERIFY",
    keywords: ["attestation", "slsa", "provenance", "sigstore", "cosign"],
  },
  {
    evClass: "e2e",
    checkKind: "VERIFY",
    keywords: ["playwright", "cypress", "selenium", "e2e", "end-to-end"],
  },
  {
    // Note: the bare "integration" keyword can also catch umbrella statuses like
    // `continuous-integration/*` (deferred, acceptable: L1-bounded on the
    // name-blind strength ladder, and classification is human-ratified before P3).
    evClass: "integration",
    checkKind: "VERIFY",
    keywords: ["integration", "int-test", "inttest"],
  },
  {
    evClass: "typecheck",
    checkKind: "VERIFY",
    keywords: ["typecheck", "type-check", "tsc", "mypy"],
  },
  {
    evClass: "sast",
    checkKind: "VALIDATE",
    keywords: ["codeql", "semgrep", "sast", "sonarqube", "sonarcloud", "sonar", "snyk"],
  },
  {
    evClass: "dast",
    checkKind: "VALIDATE",
    keywords: ["dast", "owasp-zap", "zap-scan", "zaproxy"],
  },
  { evClass: "coverage", checkKind: "VALIDATE", keywords: ["codecov", "coverage"] },
  {
    evClass: "lint",
    checkKind: "gate-only",
    keywords: ["eslint", "tslint", "prettier", "lint", "ruff", "flake8", "rubocop", "gofmt", "clippy"],
  },
  // "preview" is ordered before the review rule so bare `preview` / `pr-preview` /
  // `Vercel – Preview` classify as a deploy gate, not a review checkpoint (the
  // substring "review" hides inside "preview").
  { evClass: "deploy", checkKind: "gate-only", keywords: ["deploy", "release", "publish", "preview"] },
  { evClass: "review", checkKind: "checkpoint", keywords: ["code-review", "pr-review", "review"] },
  {
    evClass: "unit",
    checkKind: "VERIFY",
    keywords: ["vitest", "jest", "mocha", "pytest", "rspec", "phpunit", "junit", "unit"],
  },
];

/**
 * Map a check/workflow/source name to an `evClass` + a routing `checkKind`.
 * Deterministic, case-insensitive substring matching against `CLASS_RULES`
 * (first match wins). Any unrecognized name → `{ evClass: "unknown",
 * checkKind: "gate-only" }`.
 *
 * PURE: takes a string by value; mutates nothing.
 */
export function classifyClass(sourceName: string): { evClass: string; checkKind: EvCheckKind } {
  const name = sourceName.toLowerCase();
  for (const rule of CLASS_RULES) {
    if (rule.keywords.some((kw) => name.includes(kw))) {
      return { evClass: rule.evClass, checkKind: rule.checkKind };
    }
  }
  return { evClass: "unknown", checkKind: "gate-only" };
}

/**
 * Keyword table for `inferArtifactKind` (P3.3 auto-discovery), ORDERED by priority
 * (first match wins). The NARROWER signal outranks the broader one — mirrors
 * `CLASS_RULES`' narrow-before-broad convention:
 *   - `mutation` first: a Stryker/PIT artifact is often named
 *     "mutation-test-results", and the broad junit keyword "test-results" must
 *     never steal it.
 *   - `coverage` second: "codecov-junit"-style uploads are coverage, not junit.
 *   - `junit` last (its keywords are the broadest).
 * Matching is case-insensitive substring; deterministic.
 */
const ARTIFACT_KIND_RULES: ReadonlyArray<{
  kind: "junit" | "coverage" | "mutation";
  keywords: readonly string[];
}> = [
  { kind: "mutation", keywords: ["mutation", "stryker", "pitest"] },
  { kind: "coverage", keywords: ["coverage", "lcov", "codecov", "cobertura"] },
  { kind: "junit", keywords: ["junit", "test-results", "test-report", "surefire"] },
];

/**
 * Map a run-artifact NAME to the artifact kind the P2.4 parsers consume, or
 * `null` when the name carries no recognizable signal (such an artifact is
 * skipped by auto-discovery — never guessed). Deterministic, case-insensitive,
 * first-match priority per `ARTIFACT_KIND_RULES`. PURE: no I/O, mutates nothing.
 */
export function inferArtifactKind(name: string): "junit" | "coverage" | "mutation" | null {
  const n = name.toLowerCase();
  for (const rule of ARTIFACT_KIND_RULES) {
    if (rule.keywords.some((kw) => n.includes(kw))) return rule.kind;
  }
  return null;
}

/**
 * Label a source on the provenance-strength ladder. Required-ness (`isRequired`)
 * is JOINED from branch protection's required list by the caller and passed in —
 * it is NEVER guessed from the source name.
 *
 * Ladder (strongest first):
 *   - signed source (attestation-backed)          → "signed-provenance"
 *   - required check/status (in the required list) → "required-status-check"
 *   - a bare, unrequired legacy status context     → "self-reported"
 *   - any other unrequired source (check-run, etc) → "optional-check"
 *
 * PURE: reads the three input fields by value; mutates nothing.
 */
export function strengthOf(input: {
  discoveredAs: "check-run" | "status" | "attestation" | "deployment" | "review" | "codeowners";
  isRequired: boolean;
  isSigned: boolean;
}): StrengthLabel {
  // Strict `=== true`: P2.2+ will DERIVE isSigned/isRequired from attestation
  // presence / branch-protection membership. A future truthy-non-boolean (a
  // non-empty string, a truthy object) must NEVER inflate a source to L2/L3.
  if (input.isSigned === true) return "signed-provenance";
  if (input.isRequired === true) return "required-status-check";
  if (input.discoveredAs === "status") return "self-reported";
  return "optional-check";
}

/** Map a strength label to its provenance tier (per the plan's tierOf mapping). */
export function tierOf(label: StrengthLabel): ProvTier {
  switch (label) {
    case "signed-provenance":
      return "L3";
    case "required-status-check":
      return "L2";
    case "optional-check":
    case "self-reported":
      return "L1";
  }
}

// ---------------------------------------------------------------------------
// The two scan gotchas — PURE (Durable Decision 3; §"The two scan gotchas")
// ---------------------------------------------------------------------------

/**
 * A single unioned check surface: one entry per distinct check name at a given
 * SHA. `sha` is SNAPSHOTTED (gotcha 2) from the check-run's `headSha` or the
 * combined status's `sha`; `kind` records which list it came from after dedup.
 */
export interface CheckSurface {
  name: string;
  sha: string;
  conclusion: string | null;
  kind: "check-run" | "status";
  detailsUrl: string | null;
}

/**
 * Gotcha 1 — UNION the combined commit status with the check-runs list, deduped.
 *
 * Returns ALL check-runs (as `kind:"check-run"`) PLUS every combined-status
 * context whose name has NO matching check-run (as `kind:"status"`). A GitHub
 * Action result IS itself a check run, so a naive concat double-counts it; dedup
 * on NAME match makes an Action appear exactly once (as a check-run) and a legacy
 * status with no check-run appear once (as a status).
 *
 * CAVEAT: dedup is by NAME match ONLY. A third-party tool that posts BOTH a
 * check-run and a legacy commit status under DIFFERENT names is NOT deduped —
 * inherent to the GitHub data model, and matches `gh pr checks`'s own behavior.
 *
 * Gotcha 2 — each surface's `sha` is SNAPSHOTTED from the source it came from
 * (`checkRun.headSha` / `combined.sha`), never carried across SHAs.
 *
 * PURE + NON-MUTATING: builds a fresh array via `.map(...)` (never sorts the
 * passed-in `checkRuns`/`combined.statuses` in place — those may be shared by
 * reference across SHAs), then sorts that copy. Deterministic order: by name,
 * then kind. Input-order-independent.
 */
export function unionChecks(combined: RawCombinedStatus, checkRuns: RawCheckRun[]): CheckSurface[] {
  const checkRunNames = new Set(checkRuns.map((cr) => cr.name));
  const surfaces: CheckSurface[] = [
    ...checkRuns.map(
      (cr): CheckSurface => ({
        name: cr.name,
        sha: cr.headSha,
        conclusion: cr.conclusion,
        kind: "check-run",
        detailsUrl: cr.detailsUrl,
      }),
    ),
    ...combined.statuses
      .filter((s) => !checkRunNames.has(s.context))
      .map(
        (s): CheckSurface => ({
          name: s.context,
          sha: combined.sha,
          conclusion: s.state,
          kind: "status",
          detailsUrl: s.targetUrl,
        }),
      ),
  ];
  // `surfaces` is a fresh array; sorting it does not touch the inputs. Sort by a
  // composite `(name, kind)` CODE-UNIT key (mirrors the plain `.sort()` convention
  // in cc10x-adapter.ts:192). localeCompare is locale/ICU-sensitive — it collates
  // emoji before ASCII and reorders case — so it would break byte-stability for a
  // non-ASCII check name. Code-unit `<`/`>` is deterministic and byte-stable.
  return surfaces.sort((a, b) => {
    const ka = `${a.name} ${a.kind}`;
    const kb = `${b.name} ${b.kind}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Artifact parsers — PURE, targeted extraction (P2.4; Locked decision 3)
//
// Three targeted parsers behind one `parseArtifact` dispatch. Each is FAIL-SAFE:
// malformed/empty input returns `null`, NEVER throws — the pure core must not
// crash a scan on a garbled artifact. These are TARGETED extractors (regex /
// string / JSON field reads), NOT full-schema XML/coverage engines (scope guard,
// Locked decision 3). No I/O, no clock; deterministic.
// ---------------------------------------------------------------------------

/**
 * Declared-policy mutation-adequacy threshold — a NAMED, edit-me placeholder
 * (like `ALL_EQUAL_PLACEHOLDER`). A source's mutation score is "adequate" when it
 * is `>= MUTATION_ADEQUATE_THRESHOLD`. This is NOT an authored magnitude claim
 * about any adopter's suite; it is the single pinned default the adopter tunes in
 * a PR. On the 0–100 PERCENTAGE scale — the scale Stryker's `mutationScore`
 * reports (e.g. 85.3) and the scale the computed-from-files path yields
 * (`detected/valid*100`). 60 means "60% of mutants killed", not "0.6%".
 */
export const MUTATION_ADEQUATE_THRESHOLD = 60;

/** The populated shape of `EvidenceMapEntry.artifact` (the parseArtifact result). */
export type ArtifactEntry = NonNullable<EvidenceMapEntry["artifact"]>;

/**
 * Parse JUnit XML → summed test counts, or `null` if there is no `<testsuite>`.
 * Targeted extraction: match every `<testsuite ...>` OPENING tag and SUM its
 * `tests`/`failures`/`errors`/`skipped` attributes. The `(?=[\s/>])` lookahead
 * excludes the `<testsuites>` wrapper (its aggregate would double-count the
 * children). Missing attribute → 0. NOT a DOM parser.
 */
export function parseJUnit(
  xml: string,
): { tests: number; failures: number; errors: number; skipped: number } | null {
  const tags = xml.match(/<testsuite(?=[\s/>])[^>]*>/gi);
  if (!tags || tags.length === 0) return null;
  const attr = (tag: string, name: string): number => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"(\\d+)"`, "i"));
    return m ? Number(m[1]) : 0;
  };
  const sum = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const tag of tags) {
    sum.tests += attr(tag, "tests");
    sum.failures += attr(tag, "failures");
    sum.errors += attr(tag, "errors");
    sum.skipped += attr(tag, "skipped");
  }
  return sum;
}

/**
 * Parse coverage → line coverage percent, or `null` if undetectable. Detects the
 * format by content: a `{`-leading string is a coverage-summary JSON (read
 * `total.lines.pct`); otherwise LCOV (sum `LF:` lines-found and `LH:` lines-hit,
 * `linesPct = LH/LF*100`). `LF:0` (nothing to cover) → `null` (no division by zero).
 */
export function parseCoverage(text: string): { linesPct: number } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { total?: { lines?: { pct?: unknown } } };
      const pct = j?.total?.lines?.pct;
      if (typeof pct === "number") return { linesPct: pct };
    } catch {
      // not JSON after all → fall through to null
    }
    return null;
  }
  let lf = 0;
  let lh = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    const mLF = line.match(/^LF:(\d+)/);
    if (mLF) {
      lf += Number(mLF[1]);
      seen = true;
      continue;
    }
    const mLH = line.match(/^LH:(\d+)/);
    if (mLH) {
      lh += Number(mLH[1]);
      seen = true;
    }
  }
  if (!seen || lf === 0) return null;
  return { linesPct: (lh / lf) * 100 };
}

/**
 * Parse Stryker mutation JSON → `{ mutationScore, adequate }`, or `null` if no
 * score is derivable / the JSON is malformed. Prefers the top-level
 * `mutationScore` field; otherwise computes it from `files[].mutants[].status`
 * (detected = Killed+Timeout; valid = detected + Survived + NoCoverage;
 * `score = detected/valid*100`). `adequate = mutationScore >= MUTATION_ADEQUATE_THRESHOLD`.
 */
export function parseMutation(json: string): { mutationScore: number; adequate: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as { mutationScore?: unknown; files?: unknown };

  let score: number | null = null;
  if (typeof obj.mutationScore === "number") {
    score = obj.mutationScore;
  } else if (obj.files !== null && typeof obj.files === "object") {
    let detected = 0;
    let valid = 0;
    for (const file of Object.values(obj.files as Record<string, unknown>)) {
      const mutants = (file as { mutants?: unknown }).mutants;
      if (!Array.isArray(mutants)) continue;
      for (const m of mutants) {
        const status = (m as { status?: unknown }).status;
        if (status === "Killed" || status === "Timeout") {
          detected += 1;
          valid += 1;
        } else if (status === "Survived" || status === "NoCoverage") {
          valid += 1;
        }
      }
    }
    if (valid > 0) score = (detected / valid) * 100;
  }

  if (score === null) return null;
  return { mutationScore: score, adequate: score >= MUTATION_ADEQUATE_THRESHOLD };
}

/**
 * Dispatch: pick the relevant file(s) from an unzipped `ArtifactFiles` by a
 * path/extension heuristic and route to the matching parser, mapping the result to
 * the `EvidenceMapEntry.artifact` shape. Returns `null` when no candidate file
 * parses (fail-safe). Candidates are tried in insertion order; the first that
 * parses wins, so a matching-but-unparseable sibling (e.g. an `index.html`) never
 * defeats the real data file.
 */
export function parseArtifact(
  kind: "junit" | "coverage" | "mutation",
  files: ArtifactFiles,
): ArtifactEntry | null {
  const candidates = (pred: (path: string) => boolean): string[] =>
    Object.entries(files.files)
      .filter(([p]) => pred(p.toLowerCase()))
      .map(([, text]) => text);

  if (kind === "junit") {
    for (const text of candidates((p) => p.endsWith(".xml") || p.includes("junit"))) {
      const r = parseJUnit(text);
      if (r) return { kind: "junit", testCount: r.tests, failures: r.failures };
    }
    return null;
  }

  if (kind === "coverage") {
    for (const text of candidates(
      (p) => p.endsWith(".info") || (p.includes("coverage") && p.endsWith(".json")),
    )) {
      const r = parseCoverage(text);
      if (r) return { kind: "coverage", coveragePct: r.linesPct };
    }
    return null;
  }

  for (const text of candidates((p) => (p.includes("mutation") || p.includes("stryker")) && p.endsWith(".json"))) {
    const r = parseMutation(text);
    if (r) return { kind: "mutation", mutationScore: r.mutationScore, mutationAdequate: r.adequate };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixture-set shape — hand-authored synthetic data keyed by (method, repo, args)
// ---------------------------------------------------------------------------

/** All fixtures for a single "owner/repo", keyed by the args each method varies on. */
export interface RepoFixture {
  pullRequests: RawPullRequest[];
  reviews: Record<number, RawReview[]>; // by prNumber
  workflowRuns: RawWorkflowRun[];
  checkRuns: Record<string, RawCheckRun[]>; // by sha
  combinedStatus: Record<string, RawCombinedStatus>; // by sha
  branchProtection: Record<string, RawBranchProtection>; // by branch
  deployments: RawDeployment[];
  attestations: Record<string, RawAttestation[]>; // by subjectDigest
  files: Record<string, RawFile>; // by path
  securityAlerts: RawSecurityAlert[];
  artifacts: Record<string, ArtifactFiles>; // by `${runId}:${artifactName}`
  /** OPTIONAL + ADDITIVE (P3.3): listable run artifacts by runId — drives auto-discovery. */
  runArtifacts?: Record<number, RawRunArtifact[]>;
}

/** The full injected fixture set, keyed by "owner/repo". */
export type FixtureSet = Record<string, RepoFixture>;

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

// ---------------------------------------------------------------------------
// FixtureEvidenceSource — pure, in-memory, no I/O (drives the pure core in tests)
// ---------------------------------------------------------------------------

/**
 * A PURE `EvidenceSource` backed by an injected in-memory `FixtureSet` keyed by
 * (method, repo, args). No network, no subprocess, no filesystem — so it drives
 * the pure classifier/map layer offline in CI. Absent data returns `[]`, `null`,
 * or an empty combined status, matching how the real adapters degrade.
 */
export class FixtureEvidenceSource implements EvidenceSource {
  readonly discoveredVia = "fixture" as const;
  readonly #fixtures: FixtureSet;

  constructor(fixtures: FixtureSet) {
    this.#fixtures = fixtures;
  }

  #repoFixture(repo: RepoRef): RepoFixture | undefined {
    return this.#fixtures[repoKey(repo)];
  }

  async listPullRequests(
    repo: RepoRef,
    opts?: { state?: "merged" | "open" | "all"; since?: string },
  ): Promise<RawPullRequest[]> {
    const prs = this.#repoFixture(repo)?.pullRequests ?? [];
    const state = opts?.state ?? "all";
    if (state === "all") return prs;
    return prs.filter((pr) => (state === "merged" ? pr.merged : !pr.merged));
  }

  async listReviews(repo: RepoRef, prNumber: number): Promise<RawReview[]> {
    return this.#repoFixture(repo)?.reviews[prNumber] ?? [];
  }

  async listWorkflowRuns(repo: RepoRef, opts?: { headSha?: string }): Promise<RawWorkflowRun[]> {
    const runs = this.#repoFixture(repo)?.workflowRuns ?? [];
    if (opts?.headSha) return runs.filter((r) => r.headSha === opts.headSha);
    return runs;
  }

  async listRunArtifacts(repo: RepoRef, runId: number): Promise<RawRunArtifact[]> {
    return this.#repoFixture(repo)?.runArtifacts?.[runId] ?? [];
  }

  async listCheckRunsForRef(repo: RepoRef, sha: string): Promise<RawCheckRun[]> {
    return this.#repoFixture(repo)?.checkRuns[sha] ?? [];
  }

  async getCombinedStatus(repo: RepoRef, sha: string): Promise<RawCombinedStatus> {
    return this.#repoFixture(repo)?.combinedStatus[sha] ?? { sha, state: "pending", statuses: [] };
  }

  async getBranchProtection(repo: RepoRef, branch: string): Promise<RawBranchProtection | null> {
    return this.#repoFixture(repo)?.branchProtection[branch] ?? null;
  }

  async listDeployments(repo: RepoRef, opts?: { sha?: string }): Promise<RawDeployment[]> {
    const deployments = this.#repoFixture(repo)?.deployments ?? [];
    if (opts?.sha) return deployments.filter((d) => d.sha === opts.sha);
    return deployments;
  }

  async listAttestations(repo: RepoRef, subjectDigest: string): Promise<RawAttestation[]> {
    return this.#repoFixture(repo)?.attestations[subjectDigest] ?? [];
  }

  async getFileContent(repo: RepoRef, path: string, _ref?: string): Promise<RawFile | null> {
    return this.#repoFixture(repo)?.files[path] ?? null;
  }

  async listSecurityAlerts(repo: RepoRef): Promise<RawSecurityAlert[]> {
    return this.#repoFixture(repo)?.securityAlerts ?? [];
  }

  async downloadRunArtifact(
    repo: RepoRef,
    runId: number,
    artifactName: string,
  ): Promise<ArtifactFiles | null> {
    return this.#repoFixture(repo)?.artifacts[`${runId}:${artifactName}`] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Map assembly + starter Policy — PURE (P2.3; the FROZEN P2 → P3 handoff)
//
// buildEvidenceMap and emitStarterPolicy are pure: no I/O, no clock, no
// Date/Math.random. Determinism is structural (Durable Decision 7): output is
// sorted by code-unit `(repo, sourceKey)` and `generatedAt` is null unless a
// `now` is injected at the CLI boundary (P2.5). All comparisons are code-unit
// `<`/`>` (NEVER localeCompare) so a non-ASCII check name can't break byte-stability.
// ---------------------------------------------------------------------------

/** Generator stamp embedded in the map (opts.generator overrides). */
const SCOUT_GENERATOR = "recede-scout@0.2.0";

/**
 * The all-equal starter-table placeholder (Locked decision 1). ONE pinned value
 * in [0,1] used for EVERY discovered (class,tier) entry, so byte-stability is
 * explicit and NO source is weighted above another (red-team rule 1). The adopter
 * edits these numbers in a PR — the scanner authors zero claims.
 */
export const ALL_EQUAL_PLACEHOLDER = 0.5;

/**
 * A collected scan for one repo: the RAW material the impure `collectScan` (P2.5)
 * gathers off the seam, consumed here by the pure assembler. `surfaces` are the
 * unioned checks (already SHA-snapshotted by `unionChecks`); `requiredChecks` is
 * the branch-protection required list joined into `strengthOf`; `attestations`
 * are the signed-provenance sources.
 */
/**
 * A raw run artifact bound to a check surface (P2.4). `linkSurfaceName` is the
 * check-surface NAME whose entry this artifact describes (e.g. the `unit-tests`
 * check that produced a JUnit report). `linkSha` is REQUIRED — it restricts the
 * match to one snapshotted SHA so a stale artifact can never attach to a newer
 * run's entry (gotcha 2). An artifact always comes from a workflow run tied to a
 * SHA, so the P2.5 collector always knows it; making it non-optional means a
 * future collector cannot bypass the SHA guard. The impure collector (P2.5) fills
 * this from `gh run download`; the pure assembler parses `files` and attaches the
 * result to every matching entry.
 */
export interface ScanArtifact {
  files: ArtifactFiles;
  kind: "junit" | "coverage" | "mutation";
  linkSurfaceName: string;
  linkSha: string;
}

export interface RepoScan {
  repo: RepoRef;
  discoveredVia: "mcp" | "gh-api" | "fixture";
  surfaces: CheckSurface[];
  requiredChecks: string[];
  attestations: RawAttestation[];
  /**
   * OPTIONAL raw artifacts to parse + attach (P2.4). When ABSENT, the emitted map
   * is byte-identical to the P2.3 no-artifact contract — the frozen contract does
   * not move for the no-artifact case.
   */
  artifacts?: ScanArtifact[];
  /**
   * OPTIONAL + ADDITIVE (P3.3): auto-discovery telemetry, present ONLY when
   * `collectScan` ran the auto path (no explicit `--artifact` requests supplied).
   * `found` counts every listed run artifact (incl. expired / kind-less);
   * `attached` counts the artifacts actually downloaded + bound to the scan.
   * NOT part of the emitted map — `buildEvidenceMap` never reads it, so the
   * frozen `recede-evidence-map/1` bytes are unaffected.
   */
  autoDiscovery?: { found: number; attached: number };
}

/** The frozen public artifact contract, `schemaVersion: "recede-evidence-map/1"`. */
export interface EvidenceMap {
  schemaVersion: "recede-evidence-map/1";
  generator: string;
  generatedAt: string | null;
  repos: string[];
  sources: EvidenceMapEntry[];
  counts: {
    totalSources: number;
    wiredToTrust: number;
    byStrength: Record<StrengthLabel, number>;
    byClass: Record<string, number>;
    withArtifact: number;
    mutationAdequate: number;
  };
}

/** Code-unit string comparator (byte-stable; NOT locale-sensitive). */
function codeUnitCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A partially-built entry, carrying the collision key + locator used to disambiguate. */
interface PendingEntry {
  entry: EvidenceMapEntry;
  baseKey: string;
  /** The originating check-surface name (undefined for attestation entries); used to link artifacts. */
  surfaceName?: string;
}

/**
 * Parse each `ScanArtifact` and attach it to every matching entry within THIS
 * scan: match by check-surface NAME *and* by the entry's snapshotted SHA (gotcha 2
 * is now always enforced — `linkSha` is required, so a stale artifact can never
 * attach to a newer run's entry). A malformed/empty artifact parses to `null` and
 * is silently skipped (fail-safe). Runs ONLY when `scan.artifacts` is present, so
 * an artifact-free scan is untouched (frozen contract preserved). PURE: mutates
 * only the local pendings it is handed.
 *
 * P3 concern: a single entry carries ONE artifact — if two kinds link the same
 * surface+SHA, last-write wins. Multi-signal-per-surface is out of scope for the
 * frozen single-artifact schema.
 */
function attachArtifacts(pendings: PendingEntry[], artifacts: ScanArtifact[]): void {
  for (const art of artifacts) {
    const parsed = parseArtifact(art.kind, art.files);
    if (!parsed) continue;
    for (const p of pendings) {
      if (p.surfaceName !== art.linkSurfaceName) continue;
      if (p.entry.sha !== art.linkSha) continue;
      p.entry.artifact = parsed;
    }
  }
}

function pendingFromSurface(scan: RepoScan, surface: CheckSurface): PendingEntry {
  const repo = repoKey(scan.repo);
  const { evClass, checkKind } = classifyClass(surface.name);
  const isRequired = scan.requiredChecks.includes(surface.name);
  const strength = strengthOf({
    discoveredAs: surface.kind === "check-run" ? "check-run" : "status",
    isRequired,
    isSigned: false,
  });
  const entry: EvidenceMapEntry = {
    repo,
    sourceKey: "", // assigned after collision grouping
    evClass,
    checkKind,
    strength,
    provTier: tierOf(strength),
    sha: surface.sha,
    wiredToTrust: false, // fresh adopter: discovered, never assumed (Durable Decision 8)
    locator: surface.detailsUrl ?? "",
    discoveredVia: scan.discoveredVia,
  };
  return {
    entry,
    baseKey: `${repo}|${surface.kind}|${evClass}|${surface.sha}|${surface.name}`,
    surfaceName: surface.name,
  };
}

function pendingFromAttestation(scan: RepoScan, att: RawAttestation): PendingEntry {
  const repo = repoKey(scan.repo);
  // The REAL attestations API carries no top-level predicate_type (it lives inside
  // the — often absent — inline bundle), so predicateType is frequently "". The
  // entry IS an attestation by construction (isSigned is hardcoded true below), so
  // an empty predicateType falls back to attestation/VERIFY instead of degrading
  // to unknown/gate-only.
  const { evClass, checkKind } =
    att.predicateType === ""
      ? { evClass: "attestation", checkKind: "VERIFY" as EvCheckKind }
      : classifyClass(att.predicateType);
  const strength = strengthOf({ discoveredAs: "attestation", isRequired: false, isSigned: true });
  const entry: EvidenceMapEntry = {
    repo,
    sourceKey: "",
    evClass,
    checkKind,
    strength,
    provTier: tierOf(strength),
    sha: null, // attestation is subject-digest bound, not SHA-snapshotted
    wiredToTrust: false,
    locator: att.bundleUrl ?? att.subjectDigest,
    discoveredVia: scan.discoveredVia,
  };
  return { entry, baseKey: `${repo}|attestation|${evClass}|-|${att.subjectDigest}` };
}

/**
 * Assign each entry its final `sourceKey`. A base key uniquely identifies a source
 * by `(repo, kind, evClass, sha, name)`; when two entries would still collide (same-
 * name matrix shards at one SHA), append a DETERMINISTIC index — the colliding group
 * is ordered by `(locator, canonical entry)` code-unit, so the suffix is
 * input-order-independent. Same-name check-runs therefore never collapse to one key.
 */
function assignSourceKeys(pendings: PendingEntry[]): void {
  const groups = new Map<string, PendingEntry[]>();
  for (const p of pendings) {
    const g = groups.get(p.baseKey);
    if (g) g.push(p);
    else groups.set(p.baseKey, [p]);
  }
  for (const [baseKey, group] of groups) {
    if (group.length === 1) {
      group[0].entry.sourceKey = baseKey;
      continue;
    }
    const ordered = [...group].sort((a, b) => {
      const byLoc = codeUnitCmp(a.entry.locator, b.entry.locator);
      if (byLoc !== 0) return byLoc;
      return codeUnitCmp(JSON.stringify(a.entry), JSON.stringify(b.entry));
    });
    ordered.forEach((p, i) => {
      p.entry.sourceKey = `${baseKey}#${i}`;
    });
  }
}

/**
 * PURE assembly of `RepoScan[]` into the frozen `recede-evidence-map/1` contract.
 * Byte-identical across runs and input-order-independent (sources sorted by
 * code-unit `(repo, sourceKey)`). `generatedAt` is `null` unless `opts.now` is
 * injected at the CLI boundary. Counts are exact; `withArtifact`/`mutationAdequate`
 * are 0 until P2.4 populates `entry.artifact`.
 */
export function buildEvidenceMap(
  scans: RepoScan[],
  opts?: { now?: string; generator?: string },
): EvidenceMap {
  const pendings: PendingEntry[] = [];
  for (const scan of scans) {
    const scanPendings: PendingEntry[] = [];
    for (const surface of scan.surfaces) scanPendings.push(pendingFromSurface(scan, surface));
    for (const att of scan.attestations) scanPendings.push(pendingFromAttestation(scan, att));
    // Attach artifacts WITHIN the scan (by surface name / SHA) before flattening, so
    // linkage never crosses repos. Skipped entirely when `scan.artifacts` is absent —
    // the artifact-free path stays byte-identical to the frozen P2.3 contract.
    if (scan.artifacts) attachArtifacts(scanPendings, scan.artifacts);
    pendings.push(...scanPendings);
  }
  assignSourceKeys(pendings);

  const sources = pendings
    .map((p) => p.entry)
    .sort((a, b) => codeUnitCmp(a.repo, b.repo) || codeUnitCmp(a.sourceKey, b.sourceKey));

  const repos = [...new Set(sources.map((s) => s.repo))].sort(codeUnitCmp);

  const byStrength: Record<StrengthLabel, number> = {
    "signed-provenance": 0,
    "required-status-check": 0,
    "optional-check": 0,
    "self-reported": 0,
  };
  const byClass: Record<string, number> = {};
  let wiredToTrust = 0;
  let withArtifact = 0;
  let mutationAdequate = 0;
  for (const s of sources) {
    byStrength[s.strength] += 1;
    byClass[s.evClass] = (byClass[s.evClass] ?? 0) + 1;
    if (s.wiredToTrust) wiredToTrust += 1;
    if (s.artifact) withArtifact += 1;
    if (s.artifact?.mutationAdequate === true) mutationAdequate += 1;
  }

  return {
    schemaVersion: "recede-evidence-map/1",
    generator: opts?.generator ?? SCOUT_GENERATOR,
    generatedAt: opts?.now ?? null,
    repos,
    sources,
    counts: { totalSources: sources.length, wiredToTrust, byStrength, byClass, withArtifact, mutationAdequate },
  };
}

/**
 * Emit a starter `Policy` ONLY via the audited `referencePolicyV02` constructor
 * (Durable Decision 4) — the scanner never hand-builds a Policy. Guarantees:
 * `never_recede` stays `["irreversible.critical"]`, `version:"0.2.0"`, the v0.2
 * weighting tag, and a correctly-pinned digest that DIFFERS from the default.
 *
 *  - `mode:"empty"` → `referencePolicyV02({})` (no keys, no magnitudes).
 *  - `mode:"all-equal"` (default) → one key per DISCOVERED evClass (excluding
 *    `"unknown"`), each observed tier set to the SAME `ALL_EQUAL_PLACEHOLDER`.
 *    All-equal authors ZERO claims (red-team rule 1). `evidence_requirements` is
 *    NOT emitted (P3).
 */
export function emitStarterPolicy(
  map: EvidenceMap,
  opts?: { mode?: "empty" | "all-equal"; id?: string },
): Policy {
  const mode = opts?.mode ?? "all-equal";
  const table: Record<string, Partial<Record<string, number>>> = {};

  if (mode === "all-equal") {
    const classes = [...new Set(map.sources.map((s) => s.evClass))]
      .filter((c) => c !== "unknown")
      .sort(codeUnitCmp);
    for (const cls of classes) {
      const tiers = [...new Set(map.sources.filter((s) => s.evClass === cls).map((s) => s.provTier))].sort(
        codeUnitCmp,
      );
      const tierWeights: Partial<Record<string, number>> = {};
      for (const tier of tiers) tierWeights[tier] = ALL_EQUAL_PLACEHOLDER;
      table[cls] = tierWeights;
    }
  }

  const policy = referencePolicyV02(table);
  return opts?.id ? { ...policy, id: opts.id } : policy;
}

// ---------------------------------------------------------------------------
// gh-api parse layer — PURE (P2.5). Maps `gh` JSON (already JSON.parsed) into the
// `Raw*` seam types. Factored OUT of the subprocess call so the mapping is
// unit-testable offline (see test/gh-api-parse.test.ts) — the adapter methods are
// then a thin `execFile → JSON.parse → parseFoo` seam. Fail-loud on a wrong-shape
// payload: a garbled gh response must NEVER read as an empty inventory ("no
// evidence"). Missing OPTIONAL fields degrade gracefully (null / "").
// ---------------------------------------------------------------------------

function asArray(data: unknown, what: string): unknown[] {
  if (!Array.isArray(data)) throw new Error(`gh ${what}: expected an array, got ${typeof data}`);
  return data;
}

function asObject(data: unknown, what: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`gh ${what}: expected an object, got ${Array.isArray(data) ? "array" : typeof data}`);
  }
  return data as Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strOr = (v: unknown, dflt: string): string => (typeof v === "string" ? v : dflt);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Parse `gh api repos/{o}/{r}/pulls?state=…` → `RawPullRequest[]`. merged = merged_at present. */
export function parsePullRequests(data: unknown): RawPullRequest[] {
  return asArray(data, "pulls").map((raw): RawPullRequest => {
    const pr = asObject(raw, "pull");
    const head = (pr.head ?? {}) as Record<string, unknown>;
    const user = (pr.user ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(pr.labels)
      ? pr.labels
          .map((l) => (l && typeof l === "object" ? strOr((l as Record<string, unknown>).name, "") : ""))
          .filter((n) => n.length > 0)
      : [];
    return {
      number: num(pr.number),
      merged: str(pr.merged_at) !== null,
      mergeCommitSha: str(pr.merge_commit_sha),
      headSha: strOr(head.sha, ""),
      author: strOr(user.login, ""),
      mergedAt: str(pr.merged_at),
      title: strOr(pr.title, ""),
      labels,
    };
  });
}

/** Parse `gh api …/pulls/{n}/reviews` → `RawReview[]` (stamps the prNumber). */
export function parseReviews(data: unknown, prNumber: number): RawReview[] {
  return asArray(data, "reviews").map((raw): RawReview => {
    const r = asObject(raw, "review");
    const user = (r.user ?? {}) as Record<string, unknown>;
    return {
      prNumber,
      state: strOr(r.state, ""),
      author: strOr(user.login, ""),
      submittedAt: str(r.submitted_at),
    };
  });
}

/** Parse `gh api …/actions/runs` → `RawWorkflowRun[]` (reads the `workflow_runs` envelope). */
export function parseWorkflowRuns(data: unknown): RawWorkflowRun[] {
  const env = asObject(data, "workflow runs");
  return asArray(env.workflow_runs ?? [], "workflow_runs").map((raw): RawWorkflowRun => {
    const run = asObject(raw, "workflow run");
    return {
      id: num(run.id),
      name: strOr(run.name, ""),
      path: strOr(run.path, ""),
      headSha: strOr(run.head_sha, ""),
      conclusion: str(run.conclusion),
      event: strOr(run.event, ""),
    };
  });
}

/** Parse `gh api …/actions/runs/{id}/artifacts` → `RawRunArtifact[]` (reads the `artifacts` envelope). */
export function parseRunArtifacts(data: unknown): RawRunArtifact[] {
  const env = asObject(data, "run artifacts");
  return asArray(env.artifacts ?? [], "artifacts").map((raw): RawRunArtifact => {
    const a = asObject(raw, "run artifact");
    // `digest` is present on newer API responses only; absent → undefined. NEVER
    // fabricated — a missing digest simply skips attestation enumeration.
    const digest = str(a.digest);
    return {
      id: num(a.id),
      name: strOr(a.name, ""),
      sizeBytes: num(a.size_in_bytes),
      expired: a.expired === true,
      ...(digest !== null ? { digest } : {}),
    };
  });
}

/**
 * Merge a `gh api --paginate --slurp` response for an OBJECT-envelope endpoint
 * (P3.3). `--slurp` wraps each page's envelope OBJECT in one top-level JSON
 * ARRAY; this flat-merges the nested `key` arrays across the page envelopes and
 * returns ONE synthetic envelope (scalar fields — e.g. combined status `sha`/
 * `state` — carried from the FIRST page) so the existing single-envelope parsers
 * consume it unchanged. Fail-loud: a non-array shape, and a page envelope whose
 * `key` is MISSING or null, name the pagination cause — a garbled response or a
 * renamed envelope key must NEVER read as an empty inventory. Items that carry an
 * `id` (runs, artifacts, check-runs) are deduped across page boundaries
 * (first-occurrence-wins — pages can shift under a live listing); id-less items
 * pass through untouched. PURE.
 */
export function mergeSlurpPages(data: unknown, key: string, what: string): Record<string, unknown> {
  if (!Array.isArray(data)) {
    throw new Error(
      `gh ${what}: --slurp pagination expected an ARRAY of page envelopes, got ` +
        `${data === null ? "null" : typeof data} — the endpoint response shape does not match slurp output`,
    );
  }
  const merged: unknown[] = [];
  const seenIds = new Set<number | string>();
  let first: Record<string, unknown> = {};
  data.forEach((page, i) => {
    const env = asObject(page, `${what} page ${i}`);
    if (i === 0) first = env;
    if (!(key in env) || env[key] === null) {
      throw new Error(
        `gh ${what}: --slurp pagination page ${i} has no '${key}' array — a missing/renamed ` +
          `envelope key must never read as an empty inventory`,
      );
    }
    for (const item of asArray(env[key], `${what}.${key}`)) {
      const id =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>).id
          : undefined;
      if (typeof id === "number" || typeof id === "string") {
        if (seenIds.has(id)) continue; // page-boundary duplicate: first occurrence wins
        seenIds.add(id);
      }
      merged.push(item);
    }
  });
  return { ...first, [key]: merged };
}

/** Parse `gh api …/commits/{sha}/check-runs` → `RawCheckRun[]` (reads the `check_runs` envelope). */
export function parseCheckRuns(data: unknown): RawCheckRun[] {
  const env = asObject(data, "check runs");
  return asArray(env.check_runs ?? [], "check_runs").map((raw): RawCheckRun => {
    const cr = asObject(raw, "check run");
    const app = cr.app === null || cr.app === undefined ? null : (cr.app as Record<string, unknown>);
    return {
      name: strOr(cr.name, ""),
      headSha: strOr(cr.head_sha, ""),
      conclusion: str(cr.conclusion),
      status: strOr(cr.status, ""),
      detailsUrl: str(cr.details_url),
      app: app ? str(app.slug) : null,
    };
  });
}

/** Parse `gh api …/commits/{sha}/status` → `RawCombinedStatus`. */
export function parseCombinedStatus(data: unknown): RawCombinedStatus {
  const cs = asObject(data, "combined status");
  const statuses = asArray(cs.statuses ?? [], "statuses").map((raw): RawStatusContext => {
    const s = asObject(raw, "status context");
    return { context: strOr(s.context, ""), state: strOr(s.state, ""), targetUrl: str(s.target_url) };
  });
  return { sha: strOr(cs.sha, ""), state: strOr(cs.state, ""), statuses };
}

/**
 * Parse `gh api …/branches/{branch}/protection` → `RawBranchProtection`. The
 * absence of the endpoint (404 → no protection) is handled by the ADAPTER as a
 * `null` return; this function maps a PRESENT protection object. Missing
 * `required_status_checks.contexts` → `[]`; absent review block → `requiresReview:false`.
 */
export function parseBranchProtection(data: unknown, branch: string): RawBranchProtection {
  const bp = asObject(data, "branch protection");
  const rsc = (bp.required_status_checks ?? null) as Record<string, unknown> | null;
  const contexts = rsc && Array.isArray(rsc.contexts) ? rsc.contexts.filter((c): c is string => typeof c === "string") : [];
  return {
    branch,
    requiredStatusChecks: contexts,
    requiresReview: bp.required_pull_request_reviews !== undefined && bp.required_pull_request_reviews !== null,
  };
}

/** Parse `gh api …/deployments` → `RawDeployment[]`. */
export function parseDeployments(data: unknown): RawDeployment[] {
  return asArray(data, "deployments").map((raw): RawDeployment => {
    const d = asObject(raw, "deployment");
    return {
      id: num(d.id),
      environment: strOr(d.environment, ""),
      sha: strOr(d.sha, ""),
      // LOW-4: the deployment object has no top-level `state`; the current status lives
      // on a separate .../deployments/{id}/statuses call, so this reads "unknown" today.
      // Verify + wire the status call against real gh when deployment evidence deepens (P3).
      state: strOr(d.state, "unknown"),
    };
  });
}

/**
 * Decode an INLINE attestation bundle's `dsseEnvelope.payload` (base64 JSON
 * in-toto statement) and read its `predicateType`. PURE + fail-safe: any
 * malformed shape/base64/JSON degrades to `""` — never throws, never fabricates.
 */
function predicateTypeFromBundle(bundle: unknown): string {
  try {
    if (bundle === null || typeof bundle !== "object") return "";
    const envelope = (bundle as Record<string, unknown>).dsseEnvelope;
    if (envelope === null || typeof envelope !== "object") return "";
    const payload = (envelope as Record<string, unknown>).payload;
    if (typeof payload !== "string") return "";
    const stmt = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown;
    if (stmt === null || typeof stmt !== "object") return "";
    const pt = (stmt as Record<string, unknown>).predicateType;
    return typeof pt === "string" ? pt : "";
  } catch {
    return "";
  }
}

/**
 * Parse a `gh api …/attestations/{subject_digest}` response → `RawAttestation[]`.
 * The subject digest is passed in (it keyed the query). LIVE-VERIFIED shape: a
 * real response item is `{bundle, bundle_url, initiator, repository_id}` — there
 * is NO top-level `predicate_type` (it lives inside `bundle.dsseEnvelope.payload`,
 * and `bundle` can be null). So: prefer a top-level `predicate_type` when present
 * (older/alternate shapes), else decode the inline bundle payload, else `""`
 * (classification falls back to `attestation` downstream — see
 * `pendingFromAttestation`).
 */
export function parseAttestations(data: unknown, subjectDigest: string): RawAttestation[] {
  const env = asObject(data, "attestations");
  return asArray(env.attestations ?? [], "attestations").map((raw): RawAttestation => {
    const a = asObject(raw, "attestation");
    const topLevel = str(a.predicate_type);
    return {
      subjectDigest,
      predicateType: topLevel ?? predicateTypeFromBundle(a.bundle),
      bundleUrl: str(a.bundle_url),
    };
  });
}

/**
 * Parse `gh api …/contents/{path}` → `RawFile`, base64-decoding the `content`.
 * The git `ref` is passed in (the response does not echo it). Returns the file
 * with its decoded text.
 */
export function parseFileContent(data: unknown, path: string, ref: string): RawFile {
  const f = asObject(data, "file content");
  const raw = strOr(f.content, "");
  // gh returns base64 with embedded newlines; Buffer ignores them.
  const text = f.encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
  return { path, ref, contentSha: strOr(f.sha, ""), text };
}

/** Parse a `gh api …/{code-scanning|dependabot}/alerts` array → `RawSecurityAlert[]`. */
export function parseSecurityAlerts(data: unknown, kind: string): RawSecurityAlert[] {
  return asArray(data, "security alerts").map((raw): RawSecurityAlert => {
    const a = asObject(raw, "security alert");
    const rule = (a.rule ?? {}) as Record<string, unknown>;
    const advisory = (a.security_advisory ?? {}) as Record<string, unknown>;
    const id = a.number !== undefined ? String(a.number) : strOr(a.id, "");
    return {
      id,
      kind,
      state: strOr(a.state, ""),
      severity: strOr(rule.severity ?? advisory.severity, "unknown"),
    };
  });
}

// ---------------------------------------------------------------------------
// GhApiEvidenceSource — impure transport over the authenticated `gh` CLI (P2.5)
//
// Each method shells the already-authenticated `gh` CLI via `node:child_process`
// `execFile('gh', [...argv])` — an ARG ARRAY, never a shell string, so a repo
// name can never be interpreted as a shell token (no command injection). The
// owner/repo are additionally validated against a strict character class before
// they reach an API path (defense-in-depth against path traversal). Read-only:
// no egress beyond the adopter's own gh-authed provider. Non-zero `gh` exit fails
// LOUD with a clear message — it NEVER silently returns empty that would read as
// "no evidence". The one soft case is branch protection, whose 404 legitimately
// means "no protection configured" → `null`.
// ---------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Thrown by `McpEvidenceSource` — the MCP transport is a scaffold in this env. */
export class NotConnectedError extends Error {
  constructor(method: string) {
    super(
      `McpEvidenceSource.${method}: github-mcp-server is not connected in this environment. ` +
        `Use GhApiEvidenceSource (shells the authenticated 'gh' CLI) instead.`,
    );
    this.name = "NotConnectedError";
  }
}

/** The subprocess seam — `execFile` promisified. Injectable so the transport is
 * unit-testable with a stub (no real `gh` spawn, no network) in CI. */
export type GhExec = (
  file: string,
  args: readonly string[],
  opts: { maxBuffer: number },
) => Promise<{ stdout: string }>;

export class GhApiEvidenceSource implements EvidenceSource {
  readonly discoveredVia = "gh-api" as const;
  readonly #exec: GhExec;

  constructor(exec: GhExec = execFileAsync as unknown as GhExec) {
    this.#exec = exec;
  }

  /** Validate a single owner/repo path segment (defense-in-depth vs traversal). */
  #seg(value: string, what: string): string {
    if (!SAFE_SEGMENT.test(value)) throw new Error(`unsafe ${what} '${value}' — expected [A-Za-z0-9._-]+`);
    return value;
  }

  #slug(repo: RepoRef): string {
    return `${this.#seg(repo.owner, "owner")}/${this.#seg(repo.repo, "repo")}`;
  }

  /**
   * Run `gh <args>` (arg array, no shell), returning stdout; fail loud on error.
   * When `soft404` is set, a GitHub 404/Not-Found OR an absent-artifact stderr
   * ("no valid artifacts found to download", the common 90-day-expiry case that
   * `gh run download` reports instead of a 404) is treated as "absent" → null.
   */
  async #gh(args: readonly string[], opts?: { soft404?: boolean }): Promise<string | null> {
    try {
      const { stdout } = await this.#exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: unknown };
      const stderr = e.stderr ?? "";
      if (
        opts?.soft404 &&
        (/HTTP 404/i.test(stderr) || /Not Found/i.test(stderr) || /no valid artifacts/i.test(stderr))
      ) {
        // A GitHub 404 here MAY mean "inaccessible" (private/insufficient scope) rather
        // than "absent"; either way we under-report (the source's strength downgrades,
        // e.g. L2→L1, or it drops) — a SILENT but SAFE under-count, never an over-claim.
        // `no valid artifacts` is `gh run download`'s absent/expired-artifact signal
        // (the common 90-day-expiry case), which it emits INSTEAD of an HTTP 404.
        return null;
      }
      throw new Error(`gh ${args.join(" ")} failed (${e.code ?? "?"}): ${stderr || e.message}`);
    }
  }

  /**
   * Run a `gh api <path>` read and JSON.parse it.
   *
   * Bare `--paginate` is safe ONLY for top-level-ARRAY endpoints (/pulls,
   * /reviews, /deployments): gh concatenates each page's array into one and a
   * single JSON.parse works. OBJECT-envelope endpoints (check-runs, combined
   * status, actions/runs, run artifacts, attestations) go through `#apiSlurp`
   * instead (P3.3): `--paginate --slurp` wraps the page envelopes in one JSON
   * array and `mergeSlurpPages` flat-merges the nested arrays — full pagination,
   * no single-page cap. The parse is wrapped so a concatenated-JSON failure
   * rethrows naming the pagination cause rather than a bare SyntaxError.
   */
  async #api(path: string, opts?: { soft404?: boolean; paginate?: boolean }): Promise<unknown> {
    const args = opts?.paginate ? ["api", path, "--paginate"] : ["api", path];
    const out = await this.#gh(args, opts);
    if (out === null) return null;
    try {
      return JSON.parse(out) as unknown;
    } catch (err) {
      throw new Error(
        `gh api ${path}: could not JSON.parse the response — likely a pagination fault: this ` +
          `endpoint emitted concatenated JSON across pages. Object-envelope endpoints must ` +
          `use --paginate --slurp (#apiSlurp). Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Run a fully-paginated `gh api <path> --paginate --slurp` read of an
   * OBJECT-envelope endpoint and merge the page envelopes' nested `key` arrays
   * via `mergeSlurpPages` into ONE synthetic envelope (P3.3 — replaces the old
   * single-page `per_page=100` cap). Returns `null` only on a soft 404.
   * Fail-loud: an unparseable or non-array shape names the pagination cause.
   */
  async #apiSlurp(
    path: string,
    key: string,
    what: string,
    opts?: { soft404?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const out = await this.#gh(["api", path, "--paginate", "--slurp"], opts);
    if (out === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(out) as unknown;
    } catch (err) {
      throw new Error(
        `gh api ${path}: could not JSON.parse the --slurp pagination output (expected one JSON ` +
          `array of page envelopes). Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return mergeSlurpPages(parsed, key, what);
  }

  async listPullRequests(
    repo: RepoRef,
    opts?: { state?: "merged" | "open" | "all"; since?: string },
  ): Promise<RawPullRequest[]> {
    // The REST list has no "merged" state; fetch closed and filter on merged_at.
    const restState = opts?.state === "open" ? "open" : opts?.state === "merged" ? "closed" : "all";
    // Top-level ARRAY endpoint → --paginate is safe (gh concatenates pages into one array).
    const data = await this.#api(`repos/${this.#slug(repo)}/pulls?state=${restState}&per_page=100`, {
      paginate: true,
    });
    let prs = parsePullRequests(data);
    if (opts?.state === "merged") prs = prs.filter((p) => p.merged);
    if (opts?.since) prs = prs.filter((p) => !p.mergedAt || p.mergedAt >= opts.since!);
    return prs;
  }

  async listReviews(repo: RepoRef, prNumber: number): Promise<RawReview[]> {
    if (!Number.isInteger(prNumber)) throw new Error(`unsafe prNumber '${prNumber}'`);
    // Top-level ARRAY endpoint → --paginate is safe.
    const data = await this.#api(`repos/${this.#slug(repo)}/pulls/${prNumber}/reviews?per_page=100`, {
      paginate: true,
    });
    return parseReviews(data, prNumber);
  }

  async listWorkflowRuns(repo: RepoRef, opts?: { headSha?: string }): Promise<RawWorkflowRun[]> {
    // OBJECT-envelope endpoint ({total_count,workflow_runs[]}): fully paginated
    // via --paginate --slurp (P3.3); per_page=100 sets the page SIZE only.
    // Scope note: slurping this endpoint exceeded the plan's "two endpoints" line;
    // it is safe because collectScan always calls it head_sha-filtered (bounded).
    const q = opts?.headSha ? `?head_sha=${this.#seg(opts.headSha, "headSha")}&per_page=100` : "?per_page=100";
    const data = await this.#apiSlurp(`repos/${this.#slug(repo)}/actions/runs${q}`, "workflow_runs", "workflow runs");
    return parseWorkflowRuns(data);
  }

  async listRunArtifacts(repo: RepoRef, runId: number): Promise<RawRunArtifact[]> {
    if (!Number.isInteger(runId)) throw new Error(`unsafe runId '${runId}'`);
    // OBJECT-envelope endpoint ({total_count,artifacts[]}): fully paginated (P3.3).
    const data = await this.#apiSlurp(
      `repos/${this.#slug(repo)}/actions/runs/${runId}/artifacts?per_page=100`,
      "artifacts",
      "run artifacts",
    );
    return parseRunArtifacts(data);
  }

  async listCheckRunsForRef(repo: RepoRef, sha: string): Promise<RawCheckRun[]> {
    // OBJECT-envelope endpoint ({total_count,check_runs[]}): fully paginated via
    // --paginate --slurp (P3.3) — a SHA with >100 check-runs is no longer truncated.
    const data = await this.#apiSlurp(
      `repos/${this.#slug(repo)}/commits/${this.#seg(sha, "sha")}/check-runs?per_page=100`,
      "check_runs",
      "check runs",
    );
    return parseCheckRuns(data);
  }

  async getCombinedStatus(repo: RepoRef, sha: string): Promise<RawCombinedStatus> {
    // OBJECT-envelope endpoint ({sha,state,statuses[]}): fully paginated via
    // --paginate --slurp (P3.3); `sha`/`state` carry from the first page envelope,
    // the statuses arrays flat-merge across pages.
    const data = await this.#apiSlurp(
      `repos/${this.#slug(repo)}/commits/${this.#seg(sha, "sha")}/status?per_page=100`,
      "statuses",
      "combined status",
    );
    return parseCombinedStatus(data);
  }

  async getBranchProtection(repo: RepoRef, branch: string): Promise<RawBranchProtection | null> {
    const data = await this.#api(`repos/${this.#slug(repo)}/branches/${this.#seg(branch, "branch")}/protection`, {
      soft404: true,
    });
    // soft404 → null legitimately means "no branch protection configured" here.
    return data === null ? null : parseBranchProtection(data, branch);
  }

  async listDeployments(repo: RepoRef, opts?: { sha?: string }): Promise<RawDeployment[]> {
    const q = opts?.sha ? `?sha=${this.#seg(opts.sha, "sha")}&per_page=100` : "?per_page=100";
    // Top-level ARRAY endpoint → --paginate is safe.
    const data = await this.#api(`repos/${this.#slug(repo)}/deployments${q}`, { paginate: true });
    return parseDeployments(data);
  }

  async listAttestations(repo: RepoRef, subjectDigest: string): Promise<RawAttestation[]> {
    // subjectDigest may contain a ':' (sha256:…); it is a query arg, never a path segment.
    const digest = encodeURIComponent(subjectDigest);
    // OBJECT-envelope endpoint ({attestations[]}): fully paginated via
    // --paginate --slurp (P3.3). soft404 → [] (no attestations for the digest).
    const data = await this.#apiSlurp(`repos/${this.#slug(repo)}/attestations/${digest}`, "attestations", "attestations", {
      soft404: true,
    });
    return data === null ? [] : parseAttestations(data, subjectDigest);
  }

  async getFileContent(repo: RepoRef, path: string, ref?: string): Promise<RawFile | null> {
    // MEDIUM-3: encodeURIComponent leaves '.' literal, so a '..' segment would survive
    // and let a caller-supplied path traverse out of the repo. Reject it at the boundary.
    if (path.split("/").some((seg) => seg === "..")) {
      throw new Error(`unsafe path '${path}' — a '..' segment is not allowed`);
    }
    const q = ref ? `?ref=${this.#seg(ref, "ref")}` : "";
    // The file path is a URL path; encode each segment but keep the slashes.
    const encPath = path.split("/").map(encodeURIComponent).join("/");
    const data = await this.#api(`repos/${this.#slug(repo)}/contents/${encPath}${q}`, { soft404: true });
    // soft404 → null means "file absent" (e.g. no CODEOWNERS); a 404 could also be
    // "inaccessible" — either way the surface is simply not discovered (safe under-report).
    return data === null ? null : parseFileContent(data, path, ref ?? "");
  }

  async listSecurityAlerts(repo: RepoRef): Promise<RawSecurityAlert[]> {
    // Code-scanning alerts; top-level ARRAY endpoint → --paginate is safe. 404 when
    // Advanced Security is off → soft404 → [] (none configured, a safe under-report).
    const data = await this.#api(`repos/${this.#slug(repo)}/code-scanning/alerts?per_page=100`, {
      soft404: true,
      paginate: true,
    });
    return data === null ? [] : parseSecurityAlerts(data, "code-scanning");
  }

  /**
   * Download a run artifact with `gh run download <runId> -n <name> --dir <tmp>`
   * (gh performs the unzip → ZERO new deps, no manual ZIP handling), then read the
   * extracted files into `ArtifactFiles` (path → text). Returns `null` if the
   * artifact is absent. The tmp dir is created under the OS tmp and removed after read.
   */
  async downloadRunArtifact(repo: RepoRef, runId: number, artifactName: string): Promise<ArtifactFiles | null> {
    if (!Number.isInteger(runId)) throw new Error(`unsafe runId '${runId}'`);
    // MEDIUM-2: `artifactName` is passed as the value of gh's `-n` flag. A value that
    // begins with '-' could be misparsed by gh's own flag parser as another option,
    // so reject a leading dash (and an empty name) at the boundary.
    if (artifactName.startsWith("-") || artifactName === "") {
      throw new Error(`unsafe artifactName '${artifactName}' — must not be empty or start with '-'`);
    }
    const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, relative, sep } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "recede-scout-"));
    try {
      const out = await this.#gh(
        ["run", "download", String(runId), "-R", this.#slug(repo), "-n", artifactName, "--dir", dir],
        { soft404: true },
      );
      if (out === null) return null;
      const files: Record<string, string> = {};
      const walk = (base: string): void => {
        for (const name of readdirSync(base)) {
          const abs = join(base, name);
          if (statSync(abs).isDirectory()) walk(abs);
          else files[relative(dir, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
        }
      };
      walk(dir);
      if (Object.keys(files).length === 0) return null;
      return { name: artifactName, files };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// McpEvidenceSource — interface-conformant SCAFFOLD (Locked decision 2)
//
// github-mcp-server is NOT connected in this environment, so every method throws
// `NotConnectedError` pointing at `GhApiEvidenceSource`. The output contract is
// transport-agnostic, so a real MCP implementation drops in later with no rework.
// Do NOT build real MCP wiring here.
// ---------------------------------------------------------------------------

export class McpEvidenceSource implements EvidenceSource {
  readonly discoveredVia = "mcp" as const;

  listPullRequests(): Promise<RawPullRequest[]> {
    throw new NotConnectedError("listPullRequests");
  }
  listReviews(): Promise<RawReview[]> {
    throw new NotConnectedError("listReviews");
  }
  listWorkflowRuns(): Promise<RawWorkflowRun[]> {
    throw new NotConnectedError("listWorkflowRuns");
  }
  listRunArtifacts(): Promise<RawRunArtifact[]> {
    throw new NotConnectedError("listRunArtifacts");
  }
  listCheckRunsForRef(): Promise<RawCheckRun[]> {
    throw new NotConnectedError("listCheckRunsForRef");
  }
  getCombinedStatus(): Promise<RawCombinedStatus> {
    throw new NotConnectedError("getCombinedStatus");
  }
  getBranchProtection(): Promise<RawBranchProtection | null> {
    throw new NotConnectedError("getBranchProtection");
  }
  listDeployments(): Promise<RawDeployment[]> {
    throw new NotConnectedError("listDeployments");
  }
  listAttestations(): Promise<RawAttestation[]> {
    throw new NotConnectedError("listAttestations");
  }
  getFileContent(): Promise<RawFile | null> {
    throw new NotConnectedError("getFileContent");
  }
  listSecurityAlerts(): Promise<RawSecurityAlert[]> {
    throw new NotConnectedError("listSecurityAlerts");
  }
  downloadRunArtifact(): Promise<ArtifactFiles | null> {
    throw new NotConnectedError("downloadRunArtifact");
  }
}

// ---------------------------------------------------------------------------
// collectScan — impure orchestration of the seam reads into a RepoScan (P2.5)
//
// This is the ONLY impure part of the map pipeline. It awaits the seam's I/O and
// FOLDS the reads into the frozen `RepoScan` the PURE `buildEvidenceMap` consumes:
//   - merged PRs → per-PR SNAPSHOT SHA (mergeCommitSha ?? headSha) → union of
//     check-runs + combined status at that SHA (gotcha 1), each surface SHA-stamped
//     (gotcha 2, enforced by `unionChecks`).
//   - an approving review on a PR → a synthesized `code-review` surface at the same
//     SHA (so reviews are DISCOVERED, mapped by the frozen classifier as `review`).
//   - branch protection (default branch) → `requiredChecks` (drives strength). When
//     it requires review, `code-review`/`CODEOWNERS` join the required set so the
//     synthesized checkpoint surfaces label as `required-status-check` (the
//     documented CODEOWNERS+review edge case) — WITHOUT touching the frozen pure layer.
//   - a CODEOWNERS file → a synthesized `CODEOWNERS` surface.
//   - deployments → one `deploy/<env>` surface each.
//   - artifacts (P3.3): EXPLICIT caller-supplied requests are downloaded via the
//     seam and attached with `linkSha` set (gotcha 2). When the caller supplies
//     NONE, artifacts are AUTO-discovered: each workflow run's artifacts at the
//     snapshotted SHAs are listed, kinds inferred by name (`inferArtifactKind`),
//     expired + kind-less ones skipped. A scan that yields no artifacts stays
//     artifact-free and byte-identical to the P2.3 contract.
//   - attestations (P3.3): auto-discovered artifacts' `digest` fields drive
//     `listAttestations(repo, subjectDigest)`; a digest-less response degrades
//     honestly to `attestations: []` (never a fabricated digest).
//
// `discoveredVia` is read off the source (each adapter advertises its provenance).
// ---------------------------------------------------------------------------

/** A caller-named artifact to download + attach within a scan (SHA-bound, gotcha 2). */
export interface ArtifactRequest {
  runId: number;
  name: string;
  kind: "junit" | "coverage" | "mutation";
  linkSurfaceName: string;
  linkSha: string;
}

/**
 * Parse a `--artifact` CLI value `runId:name:kind:surface:sha` → `ArtifactRequest`.
 * This is the P2 MANUAL delivery path that feeds decision-3's artifact pipeline
 * (auto-discovery is P3). `kind` ∈ junit|coverage|mutation; `surface` + `sha`
 * bind the parsed artifact to the check surface it evidences (gotcha 2).
 */
export function parseArtifactSpec(spec: string): ArtifactRequest {
  const parts = spec.split(":");
  if (parts.length !== 5) {
    throw new Error(`--artifact '${spec}' must be runId:name:kind:surface:sha (5 colon-separated fields)`);
  }
  const [runIdStr, name, kind, linkSurfaceName, linkSha] = parts;
  const runId = Number(runIdStr);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(`--artifact runId '${runIdStr}' must be a positive integer`);
  }
  if (kind !== "junit" && kind !== "coverage" && kind !== "mutation") {
    throw new Error(`--artifact kind '${kind}' must be one of junit|coverage|mutation`);
  }
  if (!name || !linkSurfaceName || !linkSha) throw new Error(`--artifact '${spec}' has an empty field`);
  return { runId, name, kind, linkSurfaceName, linkSha };
}

export async function collectScan(
  source: EvidenceSource,
  repo: RepoRef,
  opts?: {
    prState?: "merged" | "open" | "all";
    since?: string;
    branch?: string;
    artifacts?: ArtifactRequest[];
  },
): Promise<RepoScan> {
  const discoveredVia = source.discoveredVia ?? "gh-api";
  const branch = opts?.branch ?? "main";
  const surfaces: CheckSurface[] = [];
  const requiredSet = new Set<string>();

  const bp = await source.getBranchProtection(repo, branch);
  if (bp) for (const c of bp.requiredStatusChecks) requiredSet.add(c);

  const prs = await source.listPullRequests(repo, {
    state: opts?.prState ?? "merged",
    since: opts?.since,
  });
  // The snapshot SHAs checks were fetched at — auto-discovery (below) only
  // enumerates runs at these SHAs, because an artifact can only attach to a
  // surface that exists at its linkSha (gotcha 2); other runs would download
  // artifacts that can never attach.
  const snapshotShas = new Set<string>();
  for (const pr of prs) {
    const sha = pr.mergeCommitSha ?? pr.headSha;
    snapshotShas.add(sha);
    const [checkRuns, combined, reviews] = await Promise.all([
      source.listCheckRunsForRef(repo, sha),
      source.getCombinedStatus(repo, sha),
      source.listReviews(repo, pr.number),
    ]);
    surfaces.push(...unionChecks(combined, checkRuns));
    if (reviews.some((r) => r.state === "APPROVED")) {
      surfaces.push({ name: "code-review", sha, conclusion: "APPROVED", kind: "status", detailsUrl: null });
    }
  }

  const codeowners = await source.getFileContent(repo, "CODEOWNERS", branch);
  if (codeowners) {
    surfaces.push({
      name: "CODEOWNERS",
      sha: codeowners.contentSha,
      conclusion: "present",
      kind: "status",
      detailsUrl: null,
    });
  }
  if (bp?.requiresReview) {
    requiredSet.add("code-review");
    if (codeowners) requiredSet.add("CODEOWNERS");
  }

  const deployments = await source.listDeployments(repo);
  for (const d of deployments) {
    surfaces.push({
      name: `deploy/${d.environment}`,
      sha: d.sha,
      conclusion: d.state,
      kind: "status",
      detailsUrl: null,
    });
  }

  // Artifact requests: EXPLICIT caller-supplied requests take full precedence —
  // when `opts.artifacts` is supplied (even empty) auto-discovery does NOT run.
  // Otherwise (P3.3) AUTO-discover: enumerate each snapshot SHA's workflow runs
  // (head_sha-FILTERED at the API — never the repo's full run history), list each
  // run's artifacts, infer kinds by name, skip expired + kind-less ones, and bind
  // requests with linkSha from the run's headSha (gotcha 2). The link surface
  // NAME cannot be `run.name` (that is the WORKFLOW name, e.g. "CI"; check-run
  // surfaces carry JOB names, e.g. "unit-tests"): it is derived from the
  // check-run surface at the run's headSha whose Actions detailsUrl embeds the
  // run id (…/actions/runs/{runId}/job/{jobId}) — first match, deterministically
  // sorted. `run.name` is the fallback ONLY when no detailsUrl-matched surface
  // exists; a run whose artifact could attach to NO surface is skipped entirely
  // (visible as found > attached).
  const requests: ArtifactRequest[] = [...(opts?.artifacts ?? [])];
  const digests = new Set<string>();
  let autoDiscovery: RepoScan["autoDiscovery"];
  if (opts?.artifacts === undefined) {
    let found = 0;
    // HIGH-3: per-SHA head_sha-filtered listing keeps the walk bounded by the PR
    // snapshot set — which also makes --paginate --slurp on the runs endpoint safe
    // (the plan's "two endpoints, stop-and-flag" scope note is honored: the slurp
    // can only ever page over one SHA's runs, never the full history).
    const runs: RawWorkflowRun[] = [];
    for (const sha of [...snapshotShas].sort()) {
      runs.push(...(await source.listWorkflowRuns(repo, { headSha: sha })));
    }
    for (const run of runs) {
      const marker = `/actions/runs/${run.id}/`;
      const linked = [
        ...new Set(
          surfaces
            .filter(
              (s) =>
                s.kind === "check-run" &&
                s.sha === run.headSha &&
                s.detailsUrl !== null &&
                s.detailsUrl.includes(marker),
            )
            .map((s) => s.name),
        ),
      ].sort();
      const linkSurfaceName =
        linked.length > 0
          ? linked[0]
          : surfaces.some((s) => s.sha === run.headSha && s.name === run.name)
            ? run.name
            : null;
      for (const art of await source.listRunArtifacts(repo, run.id)) {
        found += 1;
        // Deliberate skip: attestations outlive artifacts, but an EXPIRED artifact is
        // unverifiable — its digest is not consulted (evidence recall reduced, honest).
        if (art.expired) continue;
        // Attestation enumeration (P3.3 item 2): attestations attach to build
        // ARTIFACT digests. Collect each available digest; when the response
        // carries NO digest field (older gh/API) we degrade honestly —
        // attestations stay [] below, a digest is never fabricated.
        if (art.digest) digests.add(art.digest);
        // Kind inference is name-only; a misnamed junit/coverage artifact parses null
        // downstream and is dropped — no cross-kind fallback parse (deferred; visible
        // as a lower withArtifact count).
        const kind = inferArtifactKind(art.name);
        if (kind === null) continue;
        if (linkSurfaceName === null) continue; // zero-match: could never attach — skipped
        requests.push({ runId: run.id, name: art.name, kind, linkSurfaceName, linkSha: run.headSha });
      }
    }
    autoDiscovery = { found, attached: 0 };
  }

  const artifacts: ScanArtifact[] = [];
  for (const req of requests) {
    const files = await source.downloadRunArtifact(repo, req.runId, req.name);
    if (files) {
      artifacts.push({ files, kind: req.kind, linkSurfaceName: req.linkSurfaceName, linkSha: req.linkSha });
    } else if (opts?.artifacts !== undefined) {
      // The operator named this request by hand — say WHICH one died (absent/expired).
      console.error(
        `recede-scout: --artifact ${req.runId}:${req.name} downloaded nothing (absent or expired) — skipped`,
      );
    }
  }
  if (autoDiscovery) autoDiscovery.attached = artifacts.length;

  // Digest-driven attestation enumeration (auto path only — explicit requests
  // carry no digest). Deterministic order: digests sorted code-unit.
  const attestations: RawAttestation[] = [];
  for (const digest of [...digests].sort()) {
    attestations.push(...(await source.listAttestations(repo, digest)));
  }

  return {
    repo,
    discoveredVia,
    surfaces,
    requiredChecks: [...requiredSet],
    attestations,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(autoDiscovery ? { autoDiscovery } : {}),
  };
}
