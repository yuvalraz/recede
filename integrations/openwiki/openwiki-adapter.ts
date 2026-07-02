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

/** Path-like token with an extension and an optional #symbol fragment. */
const REF_RE = /[\w./-]+\.\w+(#[\w$.]+)?/g;

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
    if (token.startsWith("/") || token.includes("://")) continue; // absolute / URL
    if (m.index >= 3 && markdown.slice(m.index - 3, m.index) === "://") continue; // URL tail
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
 */
export function foldEvent(prev: Sidecar, event: WikiEvent, warrantId: string, ts: string): Sidecar {
  const next: Sidecar = { generator: prev.generator, gitHead: prev.gitHead, pages: {}, updated: ts };
  for (const [path, p] of Object.entries(prev.pages)) next.pages[path] = { ...p };
  const tsMs = Date.parse(ts);

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
      const changed = new Set(event.changedFiles);
      for (const p of Object.values(next.pages)) {
        const sourceMatch = p.sources.some((s) => changed.has(s.split("#", 1)[0]));
        // Conservative rule: a page citing nothing decays on ANY diff — we
        // cannot prove the change is unrelated to it.
        const sourceless = p.sources.length === 0 && event.changedFiles.length > 0;
        if (sourceMatch || sourceless) p.score = diffDecay(p.score);
        p.score = timeDecay(p.score, event.nowMs - p.lastEventMs);
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
