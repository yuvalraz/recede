// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The v0.2 pooled noisy-OR weighting profile (`recede/ref-weighting-v0.2`).
 *
 * SPEC §9 marks the weighting as a *reference*, not normative. v0.1 collapses a
 * Warrant's checks to a flat MEAN confidence, which lets a single weak VALIDATE
 * drag a strong VERIFY below its own weight (the P0 pathology). v0.2 fixes that:
 * it derives a per-check declared weight (VERIFY is now weightable, no longer
 * pinned at 1.0), dedups PASS evidence by class, and pools independent classes
 * with a noisy-OR combiner `1 - Π(1 - w_i)`. Adding evidence can only ADD.
 *
 * It REUSES the byte-frozen v0.1 `signalOf` for raw/near_miss/force_demote/counts
 * and overrides ONLY `Signal.confidence`, and only on the positive side — so the
 * negative fold path (I4), forced demotion, and sample_count (I5) are identical
 * to v0.1. Every function here is pure (I7): a function of (Warrant, Policy)
 * only, with no I/O and no clock. Weights are DECLARED POLICY, not predictions.
 */

import type { Policy } from "./policy.ts";
import { defaultPolicy } from "./policy.ts";
import type { CheckRecord, Warrant } from "./records.ts";
import { clamp01, signalOf as signalOfV01, type Signal } from "./weighting.ts";
import { REF_WEIGHTING_V02 } from "./weighting-tags.ts";

// ---------------------------------------------------------------------------
// evidence_ref grammar (hash-covered element of CheckRecord.evidence_refs)
// ---------------------------------------------------------------------------

/**
 * A parsed evidence descriptor. `tier` is the parsed provenance tier (the
 * builder's `provTier` argument); `mutation` records the `;mut=1` marker.
 */
export interface EvDesc {
  evClass: string;
  tier: string;
  author: string;
  mutation: boolean;
}

/**
 * Build a hash-covered evidence_ref:
 *   `ev1|<evClass>|<provTier>|<author>|<artifactDigest>|<locator>[|mut=1]`
 * The assertion-strength marker is its OWN `|`-delimited field (a 7th `mut=1`
 * field), NOT a suffix glued to the locator — so a locator that happens to
 * contain the literal text `;mut=1` can never spoof the marker. The whole string
 * is an element of `CheckRecord.evidence_refs`, so it is bound into the record id
 * (tamper-evident). Locators must not contain `|`; use `:` / `/` separators.
 */
export function evRef(
  evClass: string,
  provTier: string,
  author: string,
  artifactDigest: string,
  locator: string,
  opts?: { mutation?: boolean },
): string {
  // Enforce the "no `|` in fields" precondition the grammar depends on. A bare `|`
  // smuggled into any content field would either forge the `mut=1` 7th field or
  // shift every trailing field (corrupting tier+author) and defeat the anti-gaming
  // gates — so refuse to build the ref at all (fail loud). The mutation flag is a
  // boolean arg (not attacker content), so it needs no guard.
  const fields: Record<string, string> = { evClass, provTier, author, artifactDigest, locator };
  for (const [name, value] of Object.entries(fields)) {
    if (value.includes("|")) {
      throw new Error(`evRef field '${name}' must not contain '|': ${JSON.stringify(value)}`);
    }
  }
  const base = `ev1|${evClass}|${provTier}|${author}|${artifactDigest}|${locator}`;
  return opts?.mutation ? `${base}|mut=1` : base;
}

/**
 * Parse one evidence_ref. Returns null for anything that is not an ev1 ref.
 * `mutation` is read STRUCTURALLY from the dedicated 7th field (`mut=1`), never
 * from a substring scan of the locator — incidental `;mut=1` in the locator is
 * opaque content and does not set the assertion-strength marker.
 */
export function parseEvRef(ref: string): EvDesc | null {
  const p = ref.split("|");
  if (p[0] !== "ev1") return null;
  // Accept ONLY the two well-formed shapes: length 6 (mutation=false) or length 7
  // whose 7th field is EXACTLY the marker (mutation=true). Anything else — length 5,
  // length >=8 (a field glued after a real marker), or a length-7 non-marker — is a
  // forged/corrupt ref and returns null rather than reading a spoofed mutation flag.
  if (p.length === 6) return { evClass: p[1], tier: p[2], author: p[3], mutation: false };
  if (p.length === 7 && p[6] === "mut=1") return { evClass: p[1], tier: p[2], author: p[3], mutation: true };
  return null;
}

/**
 * The first parseable ev1 descriptor on a CheckRecord, or null.
 *
 * ponytail: One logical evidence class PER check. The PRIMARY (sort-first,
 * deterministic) descriptor drives that check's weight; any additional
 * evidence_refs are the hash-covered AUDIT trail — multiple artifacts backing
 * the ONE logical check — not additional pooled classes. Class-level pooling is
 * CROSS-check (`pooledConfidence` dedups distinct classes across checks): to pool
 * two classes, emit one check per class. Upgrade path if a future adapter needs
 * multi-class-per-check: add within-check pooling here (fold every parseable ref,
 * not just the sort-first). Not built now — YAGNI.
 */
export function descOf(c: CheckRecord): EvDesc | null {
  for (const ref of c.evidence_refs) {
    const d = parseEvRef(ref);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// weight derivation + anti-gaming gates
// ---------------------------------------------------------------------------

/** No descriptor => weakest self-reported weight. */
export const UNKNOWN_WEIGHT = 0.1;

const TEST_CLASSES = new Set(["unit", "integration", "e2e"]);

/** Whether an evidence class is a test class subject to the assertion-strength gate. */
export function isTestClass(evClass: string): boolean {
  return TEST_CLASSES.has(evClass);
}

/**
 * The effective per-check weight under a v0.2 policy. Derived from the check's
 * declared evidence class + provenance tier via `policy.evidence_weights`, with
 * two anti-gaming gates that demote the tier to L1:
 *  - assertion-strength: a test-class check WITHOUT mutation evidence (`;mut=1`)
 *    cannot claim a high tier — a passing test proves nothing unless it can fail.
 *  - author-independence: evidence authored by the acting agent itself is weak.
 * VERIFY uses the pure declared weight (the stored `confidence: 1` is IGNORED,
 * so VERIFY is now weightable). VALIDATE scales the weight by caller confidence.
 */
export function effectiveWeight(c: CheckRecord, w: Warrant, policy: Policy): number {
  const d = descOf(c);
  let tier = d?.tier ?? "L1";
  if (d && isTestClass(d.evClass) && !d.mutation) tier = "L1"; // assertion-strength gate
  if (d && d.author === w.intent.actor) tier = "L1"; // author-independence gate
  const weight = policy.evidence_weights?.[d?.evClass ?? ""]?.[tier] ?? UNKNOWN_WEIGHT;
  // Belt: clamp the per-class weight to [0,1] so the noisy-OR invariant (pool >=
  // max single-class weight; monotone; pool <= 1) holds for ANY declared input.
  // A declared weight > 1 would otherwise make `1 - Π(1 - w)` non-monotone (two
  // classes at 1.5 -> pool 0.75 < 1.0), reintroducing the flat-mean pathology.
  return clamp01(c.check_kind === "VALIDATE" ? weight * c.confidence : weight);
}

// ---------------------------------------------------------------------------
// class-deduped noisy-OR pool
// ---------------------------------------------------------------------------

/**
 * Pooled corroboration confidence: `1 - Π(1 - w_i)` over PASS checks, deduped by
 * evidence class (the strongest weight in each class wins). Only PASS checks
 * corroborate. Noisy-OR is commutative, and dedup keeps a Map keyed by class, so
 * the result is order-independent (I7). Properties: `pool >= max single-class
 * weight`; monotone non-decreasing as PASS checks are added; redundant same-class
 * checks do not inflate.
 */
export function pooledConfidence(w: Warrant, policy: Policy): number {
  const byClass = new Map<string, number>();
  for (const c of w.checks) {
    if (c.verdict !== "PASS") continue; // only PASS corroborates
    const key = descOf(c)?.evClass ?? "unknown";
    byClass.set(key, Math.max(byClass.get(key) ?? 0, effectiveWeight(c, w, policy)));
  }
  let comp = 1;
  for (const wt of byClass.values()) comp *= 1 - wt; // independent classes compound
  return clamp01(1 - comp);
}

// ---------------------------------------------------------------------------
// v0.2 signal + reference policy
// ---------------------------------------------------------------------------

/**
 * v0.2 Signal extraction: reuse v0.1 for direction/disposition and override ONLY
 * the confidence, and only on the positive side. Negative and no-evidence signals
 * are inherited verbatim, so I4 (negative asymmetry / forced demotion), near-miss,
 * and sample_count (I5) are byte-identical to v0.1 — the pool never softens a
 * negative. The pooled confidence flows into foldSignal's positive step exactly
 * where the v0.1 mean did.
 */
export function signalOfV02(w: Warrant, policy: Policy): Signal {
  const base = signalOfV01(w);
  if (!base.counts || base.raw < 0) return base;
  return { ...base, confidence: pooledConfidence(w, policy) };
}

/**
 * A reference v0.2 policy: the byte-frozen defaults with `version: "0.2.0"`, the
 * v0.2 weighting tag, and the given declared `evidence_weights` table. Adding
 * these fields changes the policy_digest (correctly pinned, I6); the 0.1.0
 * default that leaves them undefined is unaffected.
 */
export function referencePolicyV02(evidenceWeights: Policy["evidence_weights"]): Policy {
  // Suspenders: reject a declared weight outside [0,1] at construction. An adopter
  // declaring w > 1 (or negative) has a bug — throw loud rather than silently
  // reinterpret (clamp) their policy. The clamp in effectiveWeight is the belt for
  // any policy object that bypasses this constructor.
  for (const [evClass, tiers] of Object.entries(evidenceWeights ?? {})) {
    for (const [tier, weight] of Object.entries(tiers ?? {})) {
      if (typeof weight === "number" && (weight < 0 || weight > 1)) {
        throw new Error(
          `evidence weight out of range [0,1]: ${evClass}.${tier} = ${weight}`,
        );
      }
    }
  }
  return {
    ...defaultPolicy(),
    version: "0.2.0",
    weighting: REF_WEIGHTING_V02,
    evidence_weights: evidenceWeights,
  };
}
