// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Recede <- OpenWiki reference integration (a WRAP, not a fork of OpenWiki).
 *
 * OpenWiki generates a wiki from a codebase; nothing in it knows whether a page
 * is still TRUE. This adapter is the overlay that gives every generated page a
 * trust trajectory under Recede: pages start at the epsilon floor on
 * generation, decay when the code beneath them moves, and rise ONLY on a
 * human seal. Each wiki event (run / decay / seal / sample) seals one
 * `doc.map` warrant in the ledger; the per-page sidecar is a DERIVED cache,
 * reconstructible byte-identically from the warrant chain alone.
 *
 * This module is the pure mapping core: event model, trust math, sidecar
 * fold/replay, and warrant sealing. The CLI (Phase 3) owns all process/fs/git
 * I/O. Warrants are the only truth; every fold uses warrant timestamps (never
 * wall clock), which is what makes `replay` byte-identical.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  act,
  check,
  coldStart,
  defaultPolicy,
  makeCheckRecord,
  open,
  seal,
  update,
  type CheckRecord,
  type CheckSpec,
  type Ledger,
  type Policy,
  type TrustState,
  type Warrant,
} from "../../reference/ts/src/index.ts";

// ---------------------------------------------------------------------------
// Constants + trust math (pure)
// ---------------------------------------------------------------------------

export const DOC_MAP_TASK = "doc.map";
export const DOC_MAP_RISK = "reversible.low";
export const EVENT_PREFIX = "openwiki-event:";

// ponytail: point constants; RP-1-style drift-fit intervals are the upgrade path.
export const TRUST_CONSTANTS = {
  EPSILON: 0.25, // generated-but-unsealed floor and starting score
  SEAL_GAIN: 0.4, // seal: score += SEAL_GAIN * (1 - score)
  DIFF_DECAY_MULT: 0.5, // source diff: score = max(EPSILON, score * DIFF_DECAY_MULT)
  TIME_HALF_LIFE_MS: 2592000000, // 30 days, mirrors reference policy decay
  OK_FLOOR: 0.35, // score >= OK_FLOOR (and no adverse sample) => "ok"
  BROKEN_RATIO_ACTION: 0.2, // sample: brokenRatio > 0.2 (or any missing file) => "action"
} as const;

export type Band = "ok" | "warning" | "action";

export interface SampleFinding {
  brokenRatio: number;
  anyMissing: boolean;
}

const BAND_SEVERITY: Record<Band, number> = { ok: 0, warning: 1, action: 2 };

/** Clamp a page score into the total range [EPSILON, 1]. */
function clampScore(score: number): number {
  return Math.min(1, Math.max(TRUST_CONSTANTS.EPSILON, score));
}

/** Human seal: raise the score by SEAL_GAIN of the remaining headroom. */
export function sealRaise(score: number): number {
  return clampScore(score + TRUST_CONSTANTS.SEAL_GAIN * (1 - score));
}

/** Source diff under a page: multiplicative drop, floored at EPSILON. */
export function diffDecay(score: number): number {
  return clampScore(score * TRUST_CONSTANTS.DIFF_DECAY_MULT);
}

/** Idle time: relax toward EPSILON with a 30-day half-life. */
export function timeDecay(score: number, elapsedMs: number): number {
  const factor = Math.pow(0.5, elapsedMs / TRUST_CONSTANTS.TIME_HALF_LIFE_MS);
  return clampScore(
    TRUST_CONSTANTS.EPSILON + (score - TRUST_CONSTANTS.EPSILON) * factor,
  );
}

/**
 * Band a page: score alone reaches only ok|warning; "action" requires sample
 * evidence (a missing cited file, or > BROKEN_RATIO_ACTION broken refs).
 * Severity is max(scoreBand, sampleBand).
 */
export function bandFor(score: number, sample?: SampleFinding | null): Band {
  const scoreBand: Band = score >= TRUST_CONSTANTS.OK_FLOOR ? "ok" : "warning";
  let sampleBand: Band = "ok";
  if (sample) {
    if (sample.anyMissing || sample.brokenRatio > TRUST_CONSTANTS.BROKEN_RATIO_ACTION) {
      sampleBand = "action";
    } else if (sample.brokenRatio > 0) {
      sampleBand = "warning";
    }
  }
  return BAND_SEVERITY[sampleBand] > BAND_SEVERITY[scoreBand] ? sampleBand : scoreBand;
}

// ---------------------------------------------------------------------------
// Source-ref extraction (mechanical, existence-filtered)
// ---------------------------------------------------------------------------

/**
 * Path-like token with an extension and an optional #symbol fragment. The
 * fragment must END on [\w$]: '.' and '-' are legal interior symbol chars but
 * a trailing one is sentence punctuation, not part of the symbol.
 * Known non-goal: Windows-style backslash refs (src\parser.ts) never match —
 * wiki pages cite POSIX-style repo-relative paths.
 */
const REF_RE = /[\w./-]+\.\w+(#[\w$.-]*[\w$])?/g;

/**
 * Extract repo-relative source refs from a wiki page's markdown: path-like
 * tokens containing a "/", kept only when their file part (before any
 * "#symbol" fragment) exists under repoRoot. Absolute paths and URLs are
 * rejected; duplicates dedupe preserving first-seen order.
 */
export function extractSources(markdown: string, repoRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(REF_RE)) {
    const token = m[0];
    if (!token.includes("/")) continue; // bare words like foo.bar
    // Absolute paths — and URLs: ':' is outside REF_RE's class, so a URL's
    // match starts at its "//" and this reject swallows the tail too.
    if (token.startsWith("/")) continue;
    // Non-canonical segments: '..' escapes the tree; '.' and '' (from './x',
    // 'x/./y', 'x//y') resolve on disk via join() but are kept verbatim and
    // never match git's canonical paths in decay changedFiles — silent
    // under-decay. Exact-segment test: '..' inside a filename stays legal.
    const segments = token.split("/");
    if (segments.includes("..") || segments.includes(".") || segments.includes("")) continue;
    const filePart = token.split("#", 1)[0];
    if (!existsSync(join(repoRoot, filePart))) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event model + sidecar
// ---------------------------------------------------------------------------

export interface SampleResult {
  page: string;
  refsChecked: number;
  refsBroken: number;
  anyMissing: boolean;
  evidence: string[];
}

export interface PageState {
  path: string;
  sources: string[];
  gitHead: string;
  contentDigest: string;
  score: number;
  band: Band;
  lastWarrant: string;
  sealedBy: string | null;
  lastSample: SampleFinding | null;
  lastEventMs: number;
}

export interface Sidecar {
  generator: string;
  gitHead: string;
  pages: Record<string, PageState>;
  updated: string;
}

/**
 * The per-event payload that rides VERBATIM in `IntentRecord.expected_effects[0]`
 * (prefixed with EVENT_PREFIX) — the only replay-recoverable carrier, since
 * `inputs`/`result` persist as digests. `runId` (a UUID per event) sits inside
 * the intent's content-hash preimage, guaranteeing unique warrant ids even for
 * structurally identical events. Decay carries its own `nowMs` so elapsed-time
 * math replays deterministically — folds never read the wall clock.
 */
export type WikiEvent =
  | {
      kind: "run";
      runId: string;
      gitHead: string;
      gitHeadSource: "last-update" | "degraded-head";
      planSnapshot: string | null;
      pages: { path: string; sources: string[]; contentDigest: string }[];
      removed: string[];
    }
  | { kind: "decay"; runId: string; fromHead: string; toHead: string; changedFiles: string[]; nowMs: number }
  | { kind: "seal"; runId: string; pages: string[]; human: string }
  | { kind: "sample"; runId: string; results: SampleResult[] };

/** A deterministic zero state — the fold origin for both CLI and replay. */
export function emptySidecar(generator: string): Sidecar {
  return { generator, gitHead: "", pages: {}, updated: "" };
}

/**
 * Fold ONE event into the sidecar. Pure: returns a new object, never mutates
 * `prev`. Both the incremental CLI folds and `foldWarrants` replay go through
 * this single function — that is the whole byte-identical-replay guarantee.
 * All timestamps come from the warrant (`ts` = intent.ts) or from inside the
 * event (`nowMs` for decay elapsed time); wall clock is never consulted.
 *
 * PRODUCER CONTRACT: the fold is outcome-insensitive for run events BY
 * DESIGN — appending an event asserts its effects really happened. Never seal
 * a run warrant describing pages a failed run did not write; the Phase-3 CLI
 * enforces this (child non-zero => seal nothing, mutate nothing).
 */
export function foldEvent(prev: Sidecar, event: WikiEvent, warrantId: string, ts: string): Sidecar {
  const next: Sidecar = { generator: prev.generator, gitHead: prev.gitHead, pages: {}, updated: ts };
  for (const [path, p] of Object.entries(prev.pages)) next.pages[path] = { ...p };
  const tsMs = Date.parse(ts);
  // A corrupt intent.ts would otherwise write NaN into lastEventMs silently
  // and surface only at the NEXT decay fold — blaming the wrong warrant.
  // Fail here, naming the warrant that actually carries the corruption.
  if (!Number.isFinite(tsMs)) {
    throw new Error(`non-finite intent ts in warrant ${warrantId}`);
  }

  switch (event.kind) {
    case "run": {
      for (const removed of event.removed) delete next.pages[removed];
      for (const pg of event.pages) {
        next.pages[pg.path] = {
          path: pg.path,
          sources: [...pg.sources],
          gitHead: event.gitHead,
          contentDigest: pg.contentDigest,
          score: TRUST_CONSTANTS.EPSILON,
          band: bandFor(TRUST_CONSTANTS.EPSILON),
          lastWarrant: warrantId,
          sealedBy: null,
          lastSample: null,
          lastEventMs: tsMs,
        };
      }
      next.gitHead = event.gitHead;
      break;
    }
    case "decay": {
      // Guard the time-base FIELD, not a derived elapsed: `null - number`
      // coerces null to 0 (finite) and numeric strings coerce through
      // subtraction, so a corrupt-ledger nowMs (null / missing / "123") would
      // fold silently past an elapsed-only check, no-op this decay, and poison
      // lastEventMs for the next one.
      if (typeof event.nowMs !== "number" || !Number.isFinite(event.nowMs)) {
        throw new Error(`non-finite decay nowMs in warrant ${warrantId}`);
      }
      const changed = new Set(event.changedFiles);
      for (const p of Object.values(next.pages)) {
        const sourceMatch = p.sources.some((s) => changed.has(s.split("#", 1)[0]));
        // Conservative rule: a page citing nothing decays on ANY diff — we
        // cannot prove the change is unrelated to it.
        const sourceless = p.sources.length === 0 && event.changedFiles.length > 0;
        if (sourceMatch || sourceless) p.score = diffDecay(p.score);
        // Negative elapsed (clock skew) clamps to 0 — decay may never RAISE a
        // score (0.5^negative > 1).
        p.score = timeDecay(p.score, Math.max(0, event.nowMs - p.lastEventMs));
        p.lastEventMs = event.nowMs;
        p.lastWarrant = warrantId;
        p.band = bandFor(p.score, p.lastSample);
      }
      next.gitHead = event.toHead;
      break;
    }
    case "seal": {
      for (const path of event.pages) {
        const p = next.pages[path];
        if (!p) continue; // CLI refuses unknown pages pre-seal; the fold stays total for replay
        p.score = sealRaise(p.score);
        p.sealedBy = event.human;
        p.lastSample = null;
        p.band = bandFor(p.score);
        p.lastWarrant = warrantId;
        p.lastEventMs = tsMs;
      }
      break;
    }
    case "sample": {
      for (const r of event.results) {
        const p = next.pages[r.page];
        if (!p) continue;
        p.lastSample = {
          brokenRatio: r.refsChecked ? r.refsBroken / r.refsChecked : 0,
          anyMissing: r.anyMissing,
        };
        p.band = bandFor(p.score, p.lastSample);
        p.lastWarrant = warrantId;
        p.lastEventMs = tsMs;
      }
      break;
    }
  }
  return next;
}

/**
 * Recover the WikiEvent that rode in a warrant's `expected_effects[0]`.
 * Returns undefined for warrants that are not openwiki events; throws (naming
 * the warrant id) when the payload carries the prefix but is not valid JSON.
 * Valid-JSON-but-corrupt SHAPES (null/string nowMs, corrupt counts) parse
 * fine here — foldEvent's field guards are what reject those at fold time.
 */
export function eventOf(w: Warrant): WikiEvent | undefined {
  const payload = w.intent.expected_effects[0];
  if (!payload || !payload.startsWith(EVENT_PREFIX)) return undefined;
  try {
    return JSON.parse(payload.slice(EVENT_PREFIX.length)) as WikiEvent;
  } catch {
    throw new Error(`malformed openwiki event payload in warrant ${w.intent.id}`);
  }
}

/**
 * Rebuild the sidecar from the warrant chain alone. Uses the SAME foldEvent
 * as the incremental path with (intent.id, intent.ts), so the result is
 * byte-identical to the incrementally maintained state.
 */
export function foldWarrants(generator: string, warrants: Warrant[]): Sidecar {
  let sidecar = emptySidecar(generator);
  const seen = new Set<string>();
  for (const w of warrants) {
    // A dangling outcome-less intent (crash between the intent append and the
    // outcome append) was never folded incrementally — replay must skip it
    // too, or the two fold paths diverge. FAILURE-sealed warrants DO fold:
    // a failed sample's findings are real evidence.
    if (!w.outcome) continue;
    // Duplicated ledger lines (same intent id) must not double-fold.
    if (seen.has(w.intent.id)) continue;
    seen.add(w.intent.id);
    const event = eventOf(w);
    if (!event) continue;
    sidecar = foldEvent(sidecar, event, w.intent.id, w.intent.ts);
  }
  return sidecar;
}

// ---------------------------------------------------------------------------
// Policy + check builders
// ---------------------------------------------------------------------------

/**
 * The docs policy: the reference policy (matrix + weighting unchanged) with a
 * docs-flavored id/version. Kept as a function so the pure gate always sees a
 * fresh, digest-stable Policy.
 */
export function docPolicy(): Policy {
  return { ...defaultPolicy(), id: "recede.openwiki.docs", version: "0.1.0" };
}

/**
 * Checks for a `run` event. Degraded gitHead binding and a missed plan
 * snapshot are evidence GAPS, not failures: the check THROWS so it records
 * INCONCLUSIVE (conf 0) — the outcome still seals SUCCESS but the lane signal
 * drops from +1.0 to +0.3 (reference weighting).
 */
export function runChecks(sig: {
  childExit: number;
  pageCount: number;
  gitHeadSource: "last-update" | "degraded-head";
  planSnapshot: "captured" | "absent";
}): CheckSpec[] {
  return [
    check.verify("openwiki:child-exit", () => sig.childExit === 0),
    check.verify("openwiki:wiki-valid", () => sig.pageCount > 0),
    check.verify("openwiki:githead-binding", () => {
      if (sig.gitHeadSource !== "last-update") throw new Error("degraded-head: evidence gap, not failure");
      return true;
    }),
    check.verify("openwiki:plan-snapshot", () => {
      if (sig.planSnapshot !== "captured") throw new Error("plan snapshot absent: evidence gap, not failure");
      return true;
    }),
  ];
}

/** Checks for a `decay` event: mechanical recording; evidence rides in the name. */
export function decayChecks(sig: { changedFiles: number; affectedPages: number }): CheckSpec[] {
  return [
    check.verify(
      `openwiki:decay:changed=${sig.changedFiles}:affected=${sig.affectedPages}`,
      () => sig.changedFiles >= 0 && sig.affectedPages >= 0,
    ),
  ];
}

/**
 * Checks for a `sample` event: one VERIFY per sampled page, failing when the
 * finding alone reaches the action band — a broken wiki costs the generator
 * lane trust (FAIL check => FAILURE outcome => negative signal). Intended.
 */
export function sampleChecks(results: SampleResult[]): CheckSpec[] {
  return results.map((r) =>
    check.verify(`openwiki:sample:${r.page}`, () => {
      const finding: SampleFinding = {
        brokenRatio: r.refsChecked ? r.refsBroken / r.refsChecked : 0,
        anyMissing: r.anyMissing,
      };
      return bandFor(1, finding) !== "action";
    }),
  );
}

/** Checks for a `seal` event: a human VALIDATE; the human id rides in the name. */
export function sealChecks(human: string): CheckSpec[] {
  return [check.validate(`openwiki:human-seal:${human}`, () => ({ ok: true, confidence: 0.95 }))];
}

// ---------------------------------------------------------------------------
// Warrant sealing (core ops — deliberately NOT Recede.run())
// ---------------------------------------------------------------------------

/**
 * Seal one wiki event as a `doc.map` warrant through the core ops directly
 * (open -> act -> checks -> seal -> update -> putTrust), mirroring
 * recede.ts's run() minus the gate/checkpoint step. This is recorder posture:
 * Recede.run() fires a checkpoint whenever the gate demands one, and the
 * default autoApprove() would FABRICATE a human APPROVE on every mechanical
 * event at T0. The gate still manifests where it belongs — in the fence
 * language, `status` posture, and the CI template (consumers of trust).
 *
 * PRODUCER CONTRACT: appending an event asserts the effects really happened —
 * the fold is outcome-insensitive for run events by design. Never seal a run
 * warrant describing pages a failed run did not write (the Phase-3 CLI
 * enforces this: child non-zero => seal nothing).
 *
 * CALLER CONVENTION: every event MUST carry a fresh, unique `runId` —
 * warrant ids are content-addressed, so two events with identical payloads
 * dedup into ONE warrant id by design; `runId` is what keeps structurally
 * identical events distinct in the ledger.
 */
export async function sealEventWarrant(opts: {
  ledger: Ledger;
  policy: Policy;
  generator: string;
  event: WikiEvent;
  intent: string;
  checks: CheckSpec[];
  groundTruth: string;
  humanTouched?: boolean;
  now?: () => string;
}): Promise<{ warrant: Warrant; before: TrustState; after: TrustState }> {
  // Reject invalid events BEFORE they are stringified into the ledger. Two
  // distinct corrupt shapes: JSON.stringify maps NaN/±Infinity to null, while
  // an undefined-valued key is DROPPED entirely — either way nothing would
  // throw until fold time, and the corrupt warrant would be sealed (and
  // replayed) forever. foldEvent's field guards catch both shapes again on
  // the replay path.
  if (opts.event.kind === "decay" && !Number.isFinite(opts.event.nowMs)) {
    throw new Error(`decay event ${opts.event.runId}: nowMs must be finite, got ${opts.event.nowMs}`);
  }
  // Sample results share the band math: a NaN refsBroken is incomparable
  // (NaN > 0.2 === false), so it would seal SUCCESS, serialize to null, and
  // replay as a CLEAN sample. Counts must be finite, non-negative, and
  // consistent (refsBroken <= refsChecked).
  if (opts.event.kind === "sample") {
    for (const r of opts.event.results) {
      const bad = (n: number) => typeof n !== "number" || !Number.isFinite(n) || n < 0;
      if (bad(r.refsChecked) || bad(r.refsBroken) || r.refsBroken > r.refsChecked) {
        throw new Error(
          `sample event ${opts.event.runId}: result for ${r.page} has invalid counts ` +
            `(refsChecked=${r.refsChecked}, refsBroken=${r.refsBroken})`,
        );
      }
    }
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const before =
    opts.ledger.getTrust(opts.generator, DOC_MAP_TASK) ?? coldStart(opts.generator, DOC_MAP_TASK);

  // The event rides VERBATIM in expected_effects[0]: persisted as-is AND
  // covered by the intent's content hash (inputs would persist digest-only).
  const intent = open({
    actor: opts.generator,
    task_type: DOC_MAP_TASK,
    proposed_action: opts.intent,
    declared_risk: DOC_MAP_RISK,
    expected_effects: [EVENT_PREFIX + JSON.stringify(opts.event)],
    ts: now(),
  });
  opts.ledger.append(intent);

  const action = act({
    intent,
    operations: [`openwiki:${opts.event.kind}`],
    result: { kind: opts.event.kind },
    ts: now(),
  });
  opts.ledger.append(action);

  const checkRecords: CheckRecord[] = [];
  for (const spec of opts.checks) {
    const res = await spec.run({ intent: opts.intent, input: undefined, output: undefined });
    const rec = makeCheckRecord({
      action,
      check_kind: res.check_kind,
      method: res.name,
      verdict: res.verdict,
      confidence: res.confidence,
      evidence_refs: res.evidence_refs,
      ts: now(),
    });
    opts.ledger.append(rec);
    checkRecords.push(rec);
  }

  const anyFail = checkRecords.some((c) => c.verdict === "FAIL");
  const outcome = seal({
    warrant_ref: intent.id,
    actor: opts.generator,
    result: anyFail ? "FAILURE" : "SUCCESS",
    ground_truth_source: opts.groundTruth,
    human_touched: opts.humanTouched ?? false,
    prev: checkRecords[checkRecords.length - 1]?.id ?? action.id,
    ts: now(),
  });
  opts.ledger.append(outcome);

  const warrant: Warrant = { intent, action, checks: checkRecords, checkpoints: [], outcome };
  // Gap-review advisory (binding): update() takes opts.now as a STRING —
  // `{ now }` (the function) would type-strip silently and corrupt
  // TrustState.updated on JSON serialization. Always call it: `{ now: now() }`.
  const { state: after } = update(before, warrant, opts.policy, { now: now() });
  opts.ledger.putTrust(after);

  return { warrant, before, after };
}
