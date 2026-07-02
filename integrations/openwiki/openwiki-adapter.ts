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
