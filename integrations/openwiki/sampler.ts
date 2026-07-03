// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Mechanical claim sampler for the OpenWiki trust wrap.
 *
 * Two jobs: pick WHICH pages to re-verify (`samplePages`, staleness-weighted —
 * the longer a page has gone untouched, the likelier it is drawn), and check
 * WHETHER a page's cited refs still hold at HEAD (`verifyPage`). Verification
 * is mechanical only: file-part existence, plus a symbol grep when the ref
 * carries a `#fragment`. No LLM, no network.
 *
 * `ClaimVerifier` is the pluggable seam: `MechanicalVerifier` is the
 * production implementation; an LLM claim-checker is the named upgrade path.
 * `anyMissing` stays MECHANICAL regardless of the verifier — a custom verifier
 * upgrades claim verification, never the missing-cited-file ground truth
 * (which is what drives the "action" band).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PageState, SampleResult, Sidecar } from "./openwiki-adapter.ts";

/**
 * The pluggable claim-verification seam. `ref` is a repo-relative source ref
 * as extracted by the adapter (`path/to/file.ext` or `path/to/file.ext#symbol`);
 * `pagePath` is the citing wiki page (context an LLM verifier would use; the
 * mechanical one ignores it). May be sync or async.
 */
export interface ClaimVerifier {
  verify(pagePath: string, ref: string): { ok: boolean; evidence: string } | Promise<{ ok: boolean; evidence: string }>;
}

/** Split a ref into its file part and optional #symbol fragment. */
function splitRef(ref: string): { filePart: string; symbol: string } {
  const hash = ref.indexOf("#");
  return hash === -1
    ? { filePart: ref, symbol: "" }
    : { filePart: ref.slice(0, hash), symbol: ref.slice(hash + 1) };
}

/**
 * The default, production verifier: purely mechanical, at HEAD (the working
 * tree the CLI runs against). Missing file part -> broken AND names the file;
 * `#symbol` on an existing file -> substring grep of the file's content.
 * ponytail: substring grep, not AST resolution — an LLM/AST ClaimVerifier is
 * the upgrade path; the seam exists so this ceiling is swappable, not fixable.
 */
export class MechanicalVerifier implements ClaimVerifier {
  readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  verify(_pagePath: string, ref: string): { ok: boolean; evidence: string } {
    const { filePart, symbol } = splitRef(ref);
    const abs = join(this.repoRoot, filePart);
    if (!existsSync(abs)) return { ok: false, evidence: `missing: ${filePart}` };
    if (symbol) {
      return readFileSync(abs, "utf8").includes(symbol)
        ? { ok: true, evidence: `ok: ${ref}` }
        : { ok: false, evidence: `broken: ${ref} (symbol not found)` };
    }
    return { ok: true, evidence: `ok: ${ref}` };
  }
}

/**
 * Draw up to `n` page paths, weighted by staleness (`nowMs - lastEventMs + 1`),
 * without replacement. Deterministic under an injected `rand` (the CLI passes
 * a seeded PRNG for `--seed`); defaults to `Math.random`. Returns [] for an
 * empty sidecar or n <= 0; caps at the page count.
 */
export function samplePages(sidecar: Sidecar, n: number, nowMs: number, rand: () => number = Math.random): string[] {
  const candidates = Object.values(sidecar.pages).map((p) => ({
    path: p.path,
    // +1 keeps brand-new pages drawable; Math.max(0, ...) clamps clock skew
    // (a future lastEventMs would give a negative weight and break the
    // cumulative walk below — same skew class the decay fold clamps).
    weight: Math.max(0, nowMs - p.lastEventMs) + 1,
  }));
  const count = Math.min(Math.max(0, Math.floor(n)), candidates.length);
  const picks: string[] = [];
  while (picks.length < count) {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let r = rand() * total;
    let idx = candidates.length - 1; // rand() === 1 edge: fall through to the last
    for (let i = 0; i < candidates.length; i++) {
      r -= candidates[i].weight;
      if (r < 0) {
        idx = i;
        break;
      }
    }
    picks.push(candidates[idx].path);
    candidates.splice(idx, 1);
  }
  return picks;
}

/**
 * Re-verify one page's cited refs at HEAD and aggregate into a SampleResult.
 * `refsBroken` counts the verifier's failed verdicts; `anyMissing` is computed
 * mechanically here (any ref whose FILE part is absent) so the action-band
 * trigger cannot be spoofed by a lenient custom verifier. Symbol-only misses
 * count as broken refs, not missing files.
 */
export async function verifyPage(repoRoot: string, page: PageState, verifier?: ClaimVerifier): Promise<SampleResult> {
  const v = verifier ?? new MechanicalVerifier(repoRoot);
  let refsBroken = 0;
  let anyMissing = false;
  const evidence: string[] = [];
  for (const ref of page.sources) {
    if (!existsSync(join(repoRoot, splitRef(ref).filePart))) anyMissing = true;
    const res = await v.verify(page.path, ref);
    if (!res.ok) refsBroken += 1;
    evidence.push(res.evidence);
  }
  return { page: page.path, refsChecked: page.sources.length, refsBroken, anyMissing, evidence };
}
