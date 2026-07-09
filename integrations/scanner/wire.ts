// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * recede-scout wire — the deterministic config emitter (Phase 3.2). Turns a
 * ratified v0.2 Policy + the discovered evidence map into the three adopter
 * artifacts `/recede-wire` presents for a PR:
 *
 *   - `recede.policy.ts`                       (emitPolicyTs)
 *   - `checks/<evClass>.ts` CheckSpec adapters (emitCheckAdapters)
 *   - `.github/workflows/recede-record.yml`    (emitRecordWorkflow)
 *
 * Every function is PURE (data in, string out; no I/O, no clock). The A4 gate:
 * `emitPolicyTs` routes the policy back through `referencePolicyV02`, so a
 * malformed / out-of-range weight fails loud BEFORE anything is emitted. No
 * emitter ever invents a weight magnitude (red-team rule 1) — the only numbers
 * in an emitted policy are the ones the validated input policy already carries.
 *
 * SERIALIZATION SHAPE (documented choice): `recede.policy.ts` is emitted as a
 * `referencePolicyV02(<weights literal>)` CALL, not a literal Policy object.
 * That shape round-trips by construction (version/weighting/matrix regenerate
 * from the audited constructor) and re-runs the A4 range validation at IMPORT
 * time — a post-emit hand-edit that pushes a weight out of [0,1] fails loud
 * when the module loads. The cost: only pure reference-v0.2 policies are
 * emittable; anything else is refused rather than silently flattened.
 *
 * DECISION 2: `emitRecordWorkflow` emits a CLI-invoking workflow — the shipped
 * `recede-cc10x record` + `recede-scout backfill`, record-only. This IS the
 * "wired recede-record"; no Marketplace Action is packaged here.
 */

import type { EvidenceMapEntry } from "./scanner.ts";
import {
  evRef,
  policyDigest,
  referencePolicyV02,
  REF_WEIGHTING_V02,
  type CheckKind,
  type Policy,
} from "../../reference/ts/src/index.ts";

/** Options shared by the TS emitters. `importFrom` is the recede package specifier. */
export interface EmitTsOpts {
  importFrom?: string;
}

/** A published consumer imports "recede"; tests inject the reference path. */
const DEFAULT_IMPORT = "recede";

// ---------------------------------------------------------------------------
// emitPolicyTs
// ---------------------------------------------------------------------------

/**
 * Serialize a ratified v0.2 Policy to a `recede.policy.ts` module. The A4 gate:
 * the weights are routed back through `referencePolicyV02` (throws on any
 * weight outside [0,1]) and the reconstruction must digest-match the input —
 * a policy that is not exactly a reference-v0.2 policy cannot round-trip the
 * emitted shape and is refused loud.
 */
export function emitPolicyTs(policy: Policy, opts?: EmitTsOpts): string {
  if (policy.weighting !== REF_WEIGHTING_V02) {
    throw new Error(
      `emitPolicyTs: policy must be a v0.2 pooled policy (weighting '${REF_WEIGHTING_V02}'); ` +
        `got weighting '${policy.weighting ?? "(v0.1 default)"}'`,
    );
  }
  // A4: re-validate through the audited constructor (out-of-range throws here).
  const reconstructed = referencePolicyV02(policy.evidence_weights ?? {});
  if (policyDigest(reconstructed) !== policyDigest(policy)) {
    throw new Error(
      "emitPolicyTs: policy does not round-trip referencePolicyV02(evidence_weights) — " +
        "only unmodified reference v0.2 policies are emittable in this shape",
    );
  }
  const importFrom = opts?.importFrom ?? DEFAULT_IMPORT;
  const weights = JSON.stringify(policy.evidence_weights ?? {}, null, 2);
  return `// recede.policy.ts — emitted by recede-scout wire.
// Round-trips through referencePolicyV02: importing this module RE-VALIDATES
// every declared weight (out of [0,1] fails loud at import time).
// Weights are DECLARED POLICY — yours to edit in a PR, not a prediction.

import { referencePolicyV02, type Policy } from ${JSON.stringify(importFrom)};

export const policy: Policy = referencePolicyV02(${weights});
`;
}

// ---------------------------------------------------------------------------
// emitCheckAdapters
// ---------------------------------------------------------------------------

/** Scanner routing hint -> kernel CheckKind (mirrors the backfill mapping). */
function checkKindOf(kind: EvidenceMapEntry["checkKind"]): CheckKind {
  return kind === "VALIDATE" || kind === "checkpoint" ? "VALIDATE" : "VERIFY";
}

/**
 * One `checks/<evClass>.ts` CheckSpec factory per WIRED evidence class.
 * evClass / provTier / locator are carried VERBATIM from the map entry into a
 * hash-covered evRef; `mutation` comes from `entry.artifact.mutationAdequate
 * === true` (the `;mut=1` pre-image — never invented). Entries classified
 * "unknown" are skipped: an unknown class has no wireable weight row.
 *
 * The emitted adapter is a FACTORY taking the verdict from the caller's CI
 * signal — the emitter never hard-codes a PASS (that would be a fake check).
 * Multiple entries in one class contribute multiple refs to the one logical
 * check (the hash-covered audit trail; see descOf in weighting-v0.2.ts).
 */
export function emitCheckAdapters(
  entries: EvidenceMapEntry[],
  opts?: EmitTsOpts,
): { path: string; source: string }[] {
  const importFrom = opts?.importFrom ?? DEFAULT_IMPORT;

  const byClass = new Map<string, EvidenceMapEntry[]>();
  for (const e of entries) {
    if (e.evClass === "unknown") continue;
    const group = byClass.get(e.evClass) ?? [];
    group.push(e);
    byClass.set(e.evClass, group);
  }

  const files: { path: string; source: string }[] = [];
  for (const evClass of [...byClass.keys()].sort()) {
    const group = [...byClass.get(evClass)!].sort((a, b) =>
      a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0,
    );
    // group[0] speaks for the class: checkKind is classifier-derived from the
    // evClass, so every entry in one class carries the same routing hint.
    const checkKind = checkKindOf(group[0].checkKind);
    const refs = group
      .map((e) =>
        evRef(
          e.evClass, // VERBATIM
          e.provTier, // VERBATIM
          "ci", // neutral evidence author (never the acting agent)
          e.sha ?? "unpinned",
          e.locator, // VERBATIM (evRef fails loud on a '|' in it)
          { mutation: e.artifact?.mutationAdequate === true },
        ),
      )
      .sort(); // sorted refs -> record id independent of arrival order (I2)
    const ident = evClass.replace(/[^a-zA-Z0-9]/g, "_");
    const source = `// checks/${evClass}.ts — emitted by recede-scout wire.
// The evidence_refs are hash-covered (bound into the CheckRecord id) and carry
// evClass/provTier/locator VERBATIM from your evidence map. The VERDICT comes
// from your CI signal at record time — this adapter never invents one.

import type { CheckSpec, Verdict } from ${JSON.stringify(importFrom)};

const NAME = ${JSON.stringify(evClass)};
const CHECK_KIND = ${JSON.stringify(checkKind)} as const;
const EVIDENCE_REFS: readonly string[] = ${JSON.stringify(refs, null, 2)};

export function ${ident}Check(verdict: Verdict, confidence: number = 1): CheckSpec {
  return {
    name: NAME,
    check_kind: CHECK_KIND,
    run: () => ({
      name: NAME,
      check_kind: CHECK_KIND,
      verdict,
      confidence,
      evidence_refs: [...EVIDENCE_REFS],
    }),
  };
}
`;
    files.push({ path: `checks/${evClass}.ts`, source });
  }
  return files;
}

// ---------------------------------------------------------------------------
// emitRecordWorkflow
// ---------------------------------------------------------------------------

// SHA-pinned actions (supply-chain floor). Version comments are load-bearing
// for humans; the pin is what runs.
const CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2";
const SETUP_NODE = "actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0";

/** A branch/ref must be a plain git ref — no whitespace, quotes, or shell metachars. */
function safeRef(value: string, name: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`emitRecordWorkflow: ${name} must be a plain git ref (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * The bounded rebase-retry push used by both jobs. No workflow-level
 * concurrency group: two merges racing on the ledger branch resolve by
 * fetch/rebase/retry on a non-fast-forward (the ledger is append-only JSONL,
 * so a rebase is a clean line-union), failing loud after the retry budget.
 */
function pushWithRetry(files: string, message: string): string {
  return `          git -C ledger config user.name "recede-record"
          git -C ledger config user.email "recede-record@users.noreply.github.com"
          git -C ledger add ${files}
          git -C ledger commit -m "${message}"
          for attempt in 1 2 3 4 5; do
            if git -C ledger push origin "HEAD:$LEDGER_BRANCH"; then
              exit 0
            fi
            git -C ledger fetch origin "$LEDGER_BRANCH"
            git -C ledger rebase "origin/$LEDGER_BRANCH"
          done
          echo "ledger push failed after 5 rebase retries" >&2
          exit 1`;
}

/**
 * Emit `.github/workflows/recede-record.yml`: on merge, invoke the shipped
 * `recede-cc10x record` (record-only mode); on `workflow_dispatch`, run a
 * `recede-scout backfill` into a fresh ledger. SHA-pinned actions,
 * least-privilege `permissions:`, and every push goes ONLY to the ledger
 * branch. PR-controlled strings are threaded through `env:` (never inlined
 * into `run:`) so a crafted PR title cannot inject shell.
 *
 * NOTHING IN THE RECORD IS FABRICATED:
 *  - `--verifier` is DERIVED from the real combined status + check-runs at the
 *    merge SHA (this workflow's own check run excluded by name). If the query
 *    fails, the step fails — no record with an unbound verdict. A PR merged
 *    over red CI records `--verifier fail`.
 *  - `--task`/`--risk` come from the shipped `recede-scout infer-task`, the
 *    SAME pure inference the backfill uses (lane continuity, both directions).
 *  - The human decision recorded is REAL: the merge itself — `--human approve`
 *    with `--reviewer "merged-by:<login>"`. The label keeps merge-approval
 *    distinguishable from an independent review in audits; a self-merge is
 *    visible as actor == merged-by.
 */
export function emitRecordWorkflow(opts: { ledgerBranch: string; scoutRef: string }): string {
  const ledgerBranch = safeRef(opts.ledgerBranch, "ledgerBranch");
  const scoutRef = safeRef(opts.scoutRef, "scoutRef");
  return `# .github/workflows/recede-record.yml — emitted by recede-scout wire.
# Record-only: the same engine as your terminal (the shipped recede CLIs),
# invoked on merge. Writes ONLY to the ledger branch '${ledgerBranch}'.
name: recede-record

on:
  pull_request:
    types: [closed]
  workflow_dispatch: {}

# Least privilege: contents write is required to push the ledger branch;
# both jobs push ONLY to '${ledgerBranch}'.
permissions:
  contents: write

env:
  LEDGER_BRANCH: ${ledgerBranch}

jobs:
  record:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Check out recede (pinned)
        uses: ${CHECKOUT}
        with:
          repository: yuvalraz/recede
          ref: ${scoutRef}
          path: recede
      - name: Check out the ledger branch
        uses: ${CHECKOUT}
        with:
          ref: \${{ env.LEDGER_BRANCH }}
          path: ledger
      - name: Set up Node (pinned)
        uses: ${SETUP_NODE}
        with:
          node-version: 24
      - name: Infer the task lane (same inference as the backfill)
        env:
          PR_TITLE: \${{ github.event.pull_request.title }}
          PR_LABELS: \${{ join(github.event.pull_request.labels.*.name, ',') }}
        run: |
          set -euo pipefail
          inferred="$(node recede/integrations/scanner/cli.ts infer-task --title "$PR_TITLE" --labels "$PR_LABELS")"
          read -r task risk <<<"$inferred"
          { echo "TASK_TYPE=$task"; echo "TASK_RISK=$risk"; } >> "$GITHUB_ENV"
      - name: Derive the verifier verdict from the real checks at the merge SHA
        # Fail loud: if either query fails, this step fails and NOTHING is
        # recorded — the verdict is derived, never fabricated. failure/error
        # flip the verdict to fail; success/neutral/skipped (and indefinite
        # states) do not. This workflow's own check run is excluded by name.
        env:
          MERGE_SHA: \${{ github.event.pull_request.merge_commit_sha }}
          SELF_JOB: record
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          states="$(gh api "repos/$GITHUB_REPOSITORY/commits/$MERGE_SHA/status" \\
            --jq '[.statuses[].state] | join(" ")')"
          conclusions="$(gh api "repos/$GITHUB_REPOSITORY/commits/$MERGE_SHA/check-runs" --paginate \\
            --jq '[.check_runs[] | select(.name != env.SELF_JOB) | (.conclusion // "pending")] | join(" ")')"
          verdict=pass
          for s in $states $conclusions; do
            case "$s" in
              failure|error) verdict=fail ;;
            esac
          done
          echo "VERIFIER_VERDICT=$verdict" >> "$GITHUB_ENV"
      - name: Record the merged PR (record-only)
        env:
          PR_ACTOR: \${{ github.event.pull_request.user.login }}
          PR_TITLE: \${{ github.event.pull_request.title }}
          PR_MERGED_BY: \${{ github.event.pull_request.merged_by.login }}
        run: |
          node recede/integrations/cc10x/cli.ts record \\
            --ledger ledger/recede-ledger.jsonl \\
            --actor "$PR_ACTOR" \\
            --task "$TASK_TYPE" \\
            --risk "$TASK_RISK" \\
            --intent "$PR_TITLE" \\
            --verifier "$VERIFIER_VERDICT" \\
            --human approve \\
            --reviewer "merged-by:$PR_MERGED_BY" \\
            --mode record-only
      - name: Push the ledger (ledger branch only; rebase-retry on contention)
        env:
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          set -euo pipefail
${pushWithRetry("recede-ledger.jsonl", 'recede: record merged PR #$PR_NUMBER')}

  backfill:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Check out recede (pinned)
        uses: ${CHECKOUT}
        with:
          repository: yuvalraz/recede
          ref: ${scoutRef}
          path: recede
      - name: Check out the ledger branch
        uses: ${CHECKOUT}
        with:
          ref: \${{ env.LEDGER_BRANCH }}
          path: ledger
      - name: Set up Node (pinned)
        uses: ${SETUP_NODE}
        with:
          node-version: 24
      - name: Backfill merge history (fresh ledger)
        run: |
          node recede/integrations/scanner/cli.ts backfill \\
            --repo "$GITHUB_REPOSITORY" \\
            --ledger ledger/recede-backfill.jsonl
      - name: Push the backfilled ledger (ledger branch only; rebase-retry on contention)
        run: |
          set -euo pipefail
${pushWithRetry("recede-backfill.jsonl recede-backfill.jsonl.policy.json", "recede: backfill merge history")}
`;
}
