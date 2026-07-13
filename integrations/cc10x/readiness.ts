// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The readiness matrix — pure core + markdown render (`recede-readiness/1`).
 *
 * Turns a trust ledger + its fold policy (+ optionally an evidence map) into
 * the landscape view: rows are (actor, task_type) lanes, columns are the
 * policy's risk classes, and each cell answers posture (the pure gate(),
 * verbatim), WHY (the single binding constraint), and the cheapest move
 * (declared-policy arithmetic through the REAL kernel reducers — never a
 * prediction). Everything here is PURE (I7): no I/O, no clock — `generatedAt`
 * is stamped at the CLI boundary only. The markdown render is disposable;
 * the JSON artifact is the product.
 *
 * Binding rules carried from the plan: NO cross-lane aggregate anywhere
 * (summary = counts only), never_recede cells render distinctly with move
 * "none — floor by design (I3)", every move string cites the policy
 * id@version+digest and states the no-decay assumption, and the evidence map
 * is embedded repo-level only (its entries carry no lane key — a per-lane
 * join would be fabricated).
 */

import {
  coldStart,
  foldSignal,
  gate,
  matrixCell,
  policyDigest,
  replay,
  strategyFor,
  tierFor,
  tierIndex,
  descOf,
  effectiveWeight,
  evRef,
  isTestClass,
  parseEvRef,
  pooledConfidence,
  REF_WEIGHTING_V02,
  RISK_ORDER,
  TIERS,
  type CheckRecord,
  type Ledger,
  type Policy,
  type Signal,
  type Tier,
  type TrustState,
  type Warrant,
} from "../../reference/ts/src/index.ts";
import type { EvidenceMap } from "../scanner/scanner.ts";

// ---------------------------------------------------------------------------
// The frozen schema — recede-readiness/1 (plan §4). Additive evolution only.
// ---------------------------------------------------------------------------

export const READINESS_SCHEMA = "recede-readiness/1";

export interface BindingConstraint { kind: "earned" | "never_recede_floor" | "matrix_ceiling" | "sample_cap" | "score_floor" | "score_and_samples" | "demotion_hold"; detail: string; }
export interface CheapestMove { kind: "none_earned" | "none_floor" | "none_ceiling" | "clean_cycles" | "unreachable"; clean_cycles: number | null; per_cycle_confidence: number | null; evidence_alternative: string | null; detail: string; }
export interface ReadinessCell { risk: string; posture: "autonomous" | "checkpoint"; altitude: string | null; never_recede: boolean; binding: BindingConstraint; move: CheapestMove; }
// `tiers` counts DECLARED descriptor tiers, not anti-gaming-EFFECTIVE tiers
// (the effective story lives in evidence_alternative).
export interface LaneEvidence { classes: Record<string, number>; tiers: Record<string, number>; undescribed_checks: number; }
export interface ReadinessLane { actor: string; task_type: string; tier: Tier; score: number; confidence: number; sample_count: number; updated: string | null; i2: "PASS" | "FAIL"; outcomes: Record<string, number>; reconstructed: boolean; ground_truth_sources: Record<string, number>; evidence: LaneEvidence; cells: ReadinessCell[]; }
export interface Readiness { schemaVersion: "recede-readiness/1"; generator: string; generatedAt: string | null; policy: { id: string; version: string; digest: string }; risk_classes: string[]; lanes: ReadinessLane[]; summary: { lanes: number; cells: number; autonomous: number; checkpoint_brief: number; checkpoint_full: number; never_recede: number }; evidence_map: { generator: string; repos: string[]; counts: EvidenceMap["counts"] } | null; }

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Code-unit string comparator (byte-stable; NOT locale-sensitive). */
function codeUnitCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `sha256:<first-12 hex>` — the short digest form the render + moves cite. */
function shortDigest(d: string): string {
  return d.startsWith("sha256:") ? `sha256:${d.slice(7, 19)}` : d.slice(0, 12);
}

function cite(policy: Policy): string {
  return `declared policy ${policy.id}@${policy.version} (digest ${shortDigest(policyDigest(policy))})`;
}

/**
 * Column order: RISK_ORDER members present in the matrix, then any extra
 * matrix keys code-unit sorted, then any never_recede risks not already listed.
 */
export function riskColumns(policy: Policy): string[] {
  const cols = RISK_ORDER.filter((r) => r in policy.matrix);
  const extras = Object.keys(policy.matrix)
    .filter((r) => !cols.includes(r))
    .sort(codeUnitCmp);
  cols.push(...extras);
  const floors = policy.never_recede.filter((r) => !cols.includes(r)).sort(codeUnitCmp);
  cols.push(...floors);
  return cols;
}

/** The lowest tier whose matrix cell is AUTONOMOUS for this risk, or null. */
export function minAutonomousTier(policy: Policy, risk: string): Tier | null {
  for (const t of TIERS) {
    if (matrixCell(policy, risk, t).kind === "AUTONOMOUS") return t;
  }
  return null;
}

/**
 * The lane's per-cycle confidence: the last COUNTED warrant's folded
 * confidence under the ledger's OWN fold policy (the same seam update() uses).
 * Fallback when the lane has no counted warrant: 1 (labeled by the caller).
 */
export function perCycleConfidence(warrants: Warrant[], policy: Policy): number {
  const strat = strategyFor(policy);
  for (let i = warrants.length - 1; i >= 0; i--) {
    const s = strat.signalOf(warrants[i], policy);
    if (s.counts) return s.confidence;
  }
  return 1;
}

/** The default simulation cap; beyond it a move is reported `unreachable`. */
const MAX_CLEAN_CYCLES = 200;

/**
 * PURE unified clean-cycle simulation: fold the synthetic clean signal
 * `{ raw: +1, confidence: c, counts: true }` through the REAL foldSignal and
 * declare the flip when the REAL gate() goes autonomous for this risk — the
 * loop exit checks the exact thing the k-claim is about, so it holds even
 * under a non-monotone adopter matrix (no tier-monotonicity assumption). The
 * simulated tier is re-derived via tierFor each fold, matching update()'s
 * clean-fold semantics (the forced-demotion clamp is ONE fold only, so a
 * demotion hold naturally yields k=1). Minimal by construction: the first k
 * where gate() flips is returned. No decay is applied — the pure core has no
 * clock; every move string states the assumption.
 */
export function cleanCyclesTo(trust: TrustState, risk: string, c: number, policy: Policy, maxCycles?: number): number | null {
  const cap = maxCycles ?? MAX_CLEAN_CYCLES;
  const s: Signal = { raw: 1, confidence: c, near_miss: false, force_demote: false, counts: true };
  let score = trust.score;
  let confidence = trust.confidence;
  let n = trust.sample_count;
  for (let k = 1; k <= cap; k++) {
    const folded = foldSignal(score, confidence, n, s, policy);
    score = folded.score;
    confidence = folded.confidence;
    n += 1;
    const sim: TrustState = { ...trust, tier: tierFor(score, n, policy), score, confidence, sample_count: n };
    if (gate(sim, risk, policy).autonomous) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Binding constraint (plan §5.1) — first hit wins, in this order
// ---------------------------------------------------------------------------

function demotionHoldDetail(trust: TrustState, derived: Tier): string {
  return (
    `stored tier ${trust.tier} is held below the derived tier ${derived} by a forced ` +
    `demotion; the next clean fold re-derives it`
  );
}

export function bindingConstraintOf(trust: TrustState, risk: string, policy: Policy, hasNegativeEvidence: boolean): BindingConstraint {
  // 1. The I3 floor always binds first — gate() checkpoints here at every tier.
  if (policy.never_recede.includes(risk)) {
    return {
      kind: "never_recede_floor",
      detail: `never_recede: '${risk}' retains a checkpoint at every tier (I3)`,
    };
  }
  // 2. Already autonomous.
  if (gate(trust, risk, policy).autonomous) {
    return { kind: "earned", detail: `tier ${trust.tier} is autonomous for risk '${risk}'` };
  }
  // 3. No tier reaches autonomous under the declared matrix.
  const tStar = minAutonomousTier(policy, risk);
  if (tStar === null) {
    return {
      kind: "matrix_ceiling",
      detail: `no tier in the declared matrix is autonomous for risk '${risk}'`,
    };
  }
  // 4. Forced-demotion hold: stored tier below the derived tier (trust.ts clamps
  //    ONE fold only; the next clean fold re-derives via tierFor). The hold
  //    explains ONLY cells whose target the derived tier actually reaches —
  //    otherwise re-deriving the tier changes nothing for this cell and the
  //    real constraint (step 5) binds instead.
  const derived = tierFor(trust.score, trust.sample_count, policy);
  if (tierIndex(trust.tier) < tierIndex(derived) && tierIndex(derived) >= tierIndex(tStar) && hasNegativeEvidence) {
    return { kind: "demotion_hold", detail: demotionHoldDetail(trust, derived) };
  }
  // 5. Compare the two halves of tierFor separately against i* = tierIndex(T*).
  const i = tierIndex(tStar);
  const w = policy.weights;
  let scoreTier = 0;
  for (let j = TIERS.length - 1; j >= 0; j--) {
    if (trust.score >= w.score_tier_floor[j]) {
      scoreTier = j;
      break;
    }
  }
  let sampleTier = 0;
  for (let j = TIERS.length - 1; j >= 0; j--) {
    if (trust.sample_count >= w.confidence_samples_per_tier[j]) {
      sampleTier = j;
      break;
    }
  }
  const needN = w.confidence_samples_per_tier[i];
  const needScore = w.score_tier_floor[i];
  const sampleDetail =
    `I5 sample cap: ${needN - trust.sample_count} more samples needed ` +
    `(n=${trust.sample_count} of ${needN} for ${tStar})`;
  const scoreDetail = `score ${trust.score.toFixed(3)} below the ${needScore} floor for ${tStar}`;
  if (sampleTier < i && scoreTier >= i) return { kind: "sample_cap", detail: sampleDetail };
  if (scoreTier < i && sampleTier >= i) return { kind: "score_floor", detail: scoreDetail };
  if (scoreTier < i && sampleTier < i) {
    return { kind: "score_and_samples", detail: `${scoreDetail}; ${sampleDetail}` };
  }
  // Both halves clear T* yet the gate checkpoints: the stored tier is being held
  // below the derived tier (e.g. a VALIDATE-FAIL demotion the negative-evidence
  // flag did not capture). Same hold, same k=1 remedy.
  return { kind: "demotion_hold", detail: demotionHoldDetail(trust, derived) };
}

// ---------------------------------------------------------------------------
// Cheapest move (plan §5.2) — declared-policy arithmetic, never a prediction
// ---------------------------------------------------------------------------

const NONE: Pick<CheapestMove, "clean_cycles" | "per_cycle_confidence" | "evidence_alternative"> = {
  clean_cycles: null,
  per_cycle_confidence: null,
  evidence_alternative: null,
};

export function cheapestMoveOf(binding: BindingConstraint, trust: TrustState, risk: string, policy: Policy, ctx: { perCycleConf: number; evidenceAlternative: string | null }): CheapestMove {
  switch (binding.kind) {
    case "never_recede_floor":
      return { kind: "none_floor", ...NONE, detail: "none — floor by design (I3)" };
    case "earned": {
      const tStar = minAutonomousTier(policy, risk);
      return {
        kind: "none_earned",
        ...NONE,
        detail: `none — tier ${trust.tier} ≥ ${tStar} sustains autonomy for '${risk}' under ${cite(policy)}`,
      };
    }
    case "matrix_ceiling":
      return {
        kind: "none_ceiling",
        ...NONE,
        detail: `none — no tier is autonomous for risk '${risk}' under ${cite(policy)}`,
      };
    default: {
      // demotion_hold / sample_cap / score_floor / score_and_samples all route
      // through the ONE clean-cycle simulation (minimality is test-proven).
      const c = ctx.perCycleConf;
      const k = cleanCyclesTo(trust, risk, c, policy);
      if (k === null) {
        return {
          kind: "unreachable",
          clean_cycles: null,
          per_cycle_confidence: c,
          evidence_alternative: ctx.evidenceAlternative,
          detail:
            `not reachable within ${MAX_CLEAN_CYCLES} clean cycles at per-cycle confidence ` +
            `${c.toFixed(3)} under ${cite(policy)} — raise evidence confidence; assumes no idle decay`,
        };
      }
      return {
        kind: "clean_cycles",
        clean_cycles: k,
        per_cycle_confidence: c,
        evidence_alternative: ctx.evidenceAlternative,
        detail:
          `${k} clean cycles at per-cycle confidence ${c.toFixed(3)} flips this cell to ` +
          `autonomous under ${cite(policy)}; assumes no idle decay`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The v0.2 evidence alternative (the blueprint leverage line, generalized)
// ---------------------------------------------------------------------------

interface AltCandidate {
  cls: string;
  edit: string;
  wFrom: number;
  wTo: number;
  cFrom: number;
  cTo: number;
}

function lastCountedWarrant(warrants: Warrant[], policy: Policy): Warrant | null {
  const strat = strategyFor(policy);
  for (let i = warrants.length - 1; i >= 0; i--) {
    if (strat.signalOf(warrants[i], policy).counts) return warrants[i];
  }
  return null;
}

/** First parseable ev1 ref on a check, with its raw fields (digest + locator). */
function firstRef(c: CheckRecord): { d: NonNullable<ReturnType<typeof parseEvRef>>; digest: string; locator: string } | null {
  for (const ref of c.evidence_refs) {
    const d = parseEvRef(ref);
    if (d) {
      const p = ref.split("|");
      return { d, digest: p[4], locator: p[5] };
    }
  }
  return null;
}

/**
 * The single honest declared-weight edit with the largest pooled-confidence
 * gain, computed ONLY under a v0.2 policy with declared evidence_weights, and
 * ALWAYS through the real `effectiveWeight` — never around the anti-gaming
 * gates (a test class lifted to L2 without mut=1 gains nothing, correctly).
 * Skips a class when the declared table has no L2 weight (never invent one).
 */
function altCandidateOf(warrants: Warrant[], policy: Policy): AltCandidate | null {
  if (policy.weighting !== REF_WEIGHTING_V02 || !policy.evidence_weights) return null;
  const w = lastCountedWarrant(warrants, policy);
  if (!w) return null;
  const cFrom = pooledConfidence(w, policy);
  const candidates: AltCandidate[] = [];
  for (const c of w.checks) {
    if (c.verdict !== "PASS") continue;
    const ref = firstRef(c);
    if (!ref) continue;
    const { d, digest, locator } = ref;
    // Form THE one honest edit for this class.
    let edit: string;
    let tier = d.tier;
    let author = d.author;
    let mutation = d.mutation;
    if (isTestClass(d.evClass) && !d.mutation) {
      // Demoted by the assertion-strength gate -> attach mutation evidence.
      edit = "with mutation evidence (mut=1)";
      mutation = true;
    } else if (d.author === w.intent.actor) {
      // Demoted by the author-independence gate -> evidence authored by CI.
      edit = "authored by CI, not the actor (author=ci)";
      author = "ci";
    } else if (d.tier === "L1") {
      // Declared L1 -> lift to L2, only if the table declares an L2 weight.
      if (policy.evidence_weights[d.evClass]?.["L2"] === undefined) continue;
      edit = "raised L1→L2 (make it a required status check)";
      tier = "L2";
    } else {
      continue; // effective tier already above L1 — no honest single edit.
    }
    const editedCheck: CheckRecord = {
      ...c,
      evidence_refs: [evRef(d.evClass, tier, author, digest, locator, { mutation })],
    };
    const editedWarrant: Warrant = {
      ...w,
      checks: w.checks.map((x) => (x === c ? editedCheck : x)),
    };
    const cTo = pooledConfidence(editedWarrant, policy);
    if (cTo <= cFrom) continue; // the gates held — no gain, no claim.
    candidates.push({
      cls: d.evClass,
      edit,
      wFrom: effectiveWeight(c, w, policy),
      wTo: effectiveWeight(editedCheck, editedWarrant, policy),
      cFrom,
      cTo,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.cTo - a.cTo || codeUnitCmp(a.cls, b.cls));
  return candidates[0];
}

// ---------------------------------------------------------------------------
// buildReadiness — the pure artifact builder
// ---------------------------------------------------------------------------

const SIMULATED_KINDS = new Set<BindingConstraint["kind"]>([
  "demotion_hold",
  "sample_cap",
  "score_floor",
  "score_and_samples",
]);

export function buildReadiness(ledger: Ledger, policy: Policy, opts?: { map?: EvidenceMap; generator?: string; now?: string }): Readiness {
  const risks = riskColumns(policy);

  // Lanes: first-seen via INTENT records (the cmdStatus walk), then code-unit
  // sorted by (actor, task_type) so the artifact is append-order-independent.
  const seen = new Set<string>();
  const keys: { actor: string; task: string }[] = [];
  for (const r of ledger.records()) {
    if (r.kind !== "INTENT") continue;
    const key = `${r.actor} ${r.task_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ actor: r.actor, task: r.task_type });
  }
  keys.sort((a, b) => codeUnitCmp(a.actor, b.actor) || codeUnitCmp(a.task, b.task));

  const lanes: ReadinessLane[] = keys.map(({ actor, task }) => {
    const stored = ledger.getTrust(actor, task) ?? coldStart(actor, task);
    const warrants = ledger.warrantsFor(actor, task);

    // I2: replay() == stored, same tolerance as cmdStatus.
    const replayed = replay(actor, task, warrants, policy);
    const i2 =
      stored.tier === replayed.tier &&
      Math.abs(stored.score - replayed.score) < 1e-9 &&
      Math.abs(stored.confidence - replayed.confidence) < 1e-9 &&
      stored.sample_count === replayed.sample_count
        ? "PASS"
        : "FAIL";

    // Outcomes + honesty labels (verbatim strings; backfill: marks reconstruction).
    const outcomes: Record<string, number> = {};
    const groundTruth: Record<string, number> = {};
    let hasNegativeEvidence = false;
    for (const w of warrants) {
      if (w.outcome) {
        outcomes[w.outcome.result] = (outcomes[w.outcome.result] ?? 0) + 1;
        groundTruth[w.outcome.ground_truth_source] =
          (groundTruth[w.outcome.ground_truth_source] ?? 0) + 1;
        if (w.outcome.result === "REVERTED") hasNegativeEvidence = true;
      }
      if (w.checkpoints.some((cp) => cp.decision === "REJECT" || cp.decision === "MODIFY")) {
        hasNegativeEvidence = true;
      }
    }
    const reconstructed = Object.keys(groundTruth).some((s) => s.startsWith("backfill:"));

    // Per-lane evidence from the LEDGER's own evidence_refs (the honest source;
    // the map carries no lane key and is never joined here).
    const classes: Record<string, number> = {};
    const tiers: Record<string, number> = {};
    let undescribed = 0;
    for (const w of warrants) {
      for (const c of w.checks) {
        const d = descOf(c);
        if (!d) {
          undescribed += 1;
          continue;
        }
        if (c.verdict !== "PASS") continue;
        classes[d.evClass] = (classes[d.evClass] ?? 0) + 1;
        tiers[d.tier] = (tiers[d.tier] ?? 0) + 1;
      }
    }

    const counted = lastCountedWarrant(warrants, policy) !== null;
    const c = perCycleConfidence(warrants, policy);
    const alt = altCandidateOf(warrants, policy);

    const cells: ReadinessCell[] = risks.map((risk) => {
      const g = gate(stored, risk, policy);
      const binding = bindingConstraintOf(stored, risk, policy, hasNegativeEvidence);
      let evidenceAlternative: string | null = null;
      if (alt && SIMULATED_KINDS.has(binding.kind)) {
        const k = cleanCyclesTo(stored, risk, c, policy);
        const kPrime = cleanCyclesTo(stored, risk, alt.cTo, policy);
        if (k !== null && kPrime !== null) {
          evidenceAlternative =
            `raising ${alt.cls} ${alt.edit} (declared w ${alt.wFrom.toFixed(3)}→${alt.wTo.toFixed(3)}) ` +
            `lifts per-cycle pooled confidence ${alt.cFrom.toFixed(3)}→${alt.cTo.toFixed(3)}: ` +
            `${k} → ${kPrime} clean cycles`;
        }
      }
      let move = cheapestMoveOf(binding, stored, risk, policy, {
        perCycleConf: c,
        evidenceAlternative,
      });
      if (!counted && (move.kind === "clean_cycles" || move.kind === "unreachable")) {
        move = {
          ...move,
          detail: `${move.detail}; assumes fully-confident clean evidence (no counted warrant in this lane)`,
        };
      }
      return {
        risk,
        posture: g.autonomous ? ("autonomous" as const) : ("checkpoint" as const),
        altitude: g.autonomous ? null : (g.altitude ?? null),
        never_recede: policy.never_recede.includes(risk),
        binding,
        move,
      };
    });

    return {
      actor,
      task_type: task,
      tier: stored.tier,
      score: stored.score,
      confidence: stored.confidence,
      sample_count: stored.sample_count,
      updated: stored.updated ?? null,
      i2,
      outcomes,
      reconstructed,
      ground_truth_sources: groundTruth,
      evidence: { classes, tiers, undescribed_checks: undescribed },
      cells,
    };
  });

  // Summary = COUNTS ONLY. Postures partition the cells: never_recede is its
  // own bucket, excluded from checkpoint_full (render precedent, plan §6).
  const summary = {
    lanes: lanes.length,
    cells: 0,
    autonomous: 0,
    checkpoint_brief: 0,
    checkpoint_full: 0,
    never_recede: 0,
  };
  for (const lane of lanes) {
    for (const cell of lane.cells) {
      summary.cells += 1;
      if (cell.never_recede) summary.never_recede += 1;
      else if (cell.posture === "autonomous") summary.autonomous += 1;
      else if (cell.altitude === "brief") summary.checkpoint_brief += 1;
      else summary.checkpoint_full += 1;
    }
  }

  return {
    schemaVersion: READINESS_SCHEMA,
    generator: opts?.generator ?? "recede-cc10x@0.1.0",
    generatedAt: opts?.now ?? null,
    policy: { id: policy.id, version: policy.version, digest: policyDigest(policy) },
    risk_classes: risks,
    lanes,
    summary,
    evidence_map: opts?.map
      ? { generator: opts.map.generator, repos: opts.map.repos, counts: opts.map.counts }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Markdown render (plan §6) — plain ASCII markdown; markdown IS the UI
// ---------------------------------------------------------------------------

/** Escape `|` in text interpolated into |-delimited table rows. */
function escPipe(s: string): string {
  return s.replaceAll("|", "\\|");
}

export function renderMarkdown(r: Readiness): string {
  const L: string[] = [];
  L.push("# Recede readiness matrix", "");
  L.push(
    `policy ${r.policy.id}@${r.policy.version} (digest ${shortDigest(r.policy.digest)}) · ` +
      `generated ${r.generatedAt ?? "(unstamped)"}`,
  );
  const s = r.summary;
  L.push(
    `${s.lanes} lanes · ${s.cells} cells: ${s.autonomous} autonomous · ` +
      `${s.checkpoint_brief} checkpoint(brief) · ${s.checkpoint_full} checkpoint(full) · ` +
      `${s.never_recede} never-recede`,
  );
  L.push("(counts, never averaged — per-lane posture only)", "");

  if (r.lanes.length === 0) {
    L.push("no lanes recorded yet", "");
  } else {
    // Risk classes are org-defined strings — escape them like every other cell.
    const header = ["lane", "tier", "score", "conf", "n", "updated", "i2", ...r.risk_classes.map(escPipe)];
    L.push(`| ${header.join(" | ")} |`);
    L.push(`|${header.map(() => "---").join("|")}|`);
    const footnotes: { n: number; binding: string; move: string; alt: string | null }[] = [];
    for (const lane of r.lanes) {
      const cells = lane.cells.map((cell) => {
        if (cell.never_recede) return "NEVER";
        if (cell.posture === "autonomous") return "auto";
        const n = footnotes.length + 1;
        footnotes.push({
          n,
          binding: cell.binding.detail,
          move: cell.move.detail,
          alt: cell.move.evidence_alternative,
        });
        return `cp(${escPipe(String(cell.altitude))}) [${n}]`;
      });
      const label = `${escPipe(`${lane.actor} · ${lane.task_type}`)}${lane.reconstructed ? " *" : ""}`;
      L.push(
        `| ${label} | ${lane.tier} | ${lane.score.toFixed(3)} | ${lane.confidence.toFixed(3)} | ` +
          `${lane.sample_count} | ${lane.updated ?? "-"} | ${lane.i2} | ${cells.join(" | ")} |`,
      );
    }
    L.push("");
    L.push("NEVER = never-recede floor: checkpoint at every tier by design (I3). Move: none.");
    L.push("* = reconstructed lane (backfilled ground truth, unsealed history).");
    L.push("");
    for (const f of footnotes) {
      L.push(`[${f.n}] binding: ${f.binding}.`);
      L.push(`    move: ${f.move}.`);
      if (f.alt) L.push(`    alternative: ${f.alt}.`);
    }
    if (footnotes.length > 0) L.push("");
    for (const lane of r.lanes) {
      const described = Object.values(lane.evidence.classes).reduce((a, b) => a + b, 0);
      L.push(
        `Evidence (per lane, from the ledger): ${lane.actor} · ${lane.task_type} — ` +
          `${described} evidence descriptors; ${lane.evidence.undescribed_checks} checks self-reported.`,
      );
    }
    L.push("");
  }

  if (r.evidence_map) {
    const by = Object.entries(r.evidence_map.counts.byStrength)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    L.push(
      `Evidence map (repo-level, per-source — not joinable per-lane): ` +
        `${r.evidence_map.counts.totalSources} sources, ` +
        `${r.evidence_map.counts.wiredToTrust} wired to trust; byStrength: ${by}.`,
    );
    L.push("");
  }

  L.push("Weights are declared policy, edit freely — not a prediction.");
  const ok = r.lanes.filter((l) => l.i2 === "PASS").length;
  L.push(
    `I2 replay integrity: ${ok === r.lanes.length ? "PASS" : "FAIL"} (${ok}/${r.lanes.length} lanes).`,
  );
  return L.join("\n") + "\n";
}
