---
name: recede-blueprint
description: Turn evidence-map.json into a ranked leverage blueprint and a proposed weight table. Reads the frozen scan artifact; emits blueprint.md plus proposed-policy.json. Second step of the 15-minute sequence; feeds /recede-path and /recede-wire.
---

# /recede-blueprint

Read `evidence-map.json` (from `/recede-scan`) and emit two artifacts: `blueprint.md`, the ranked leverage plan, and `proposed-policy.json`, the weight table the adopter will ratify. This is where judgment enters: the tooling counted; you rank.

The blueprint exists to set up the click in `/recede-path`. Lead every framing toward the gate posture a fix unlocks, not toward the size of the inventory.

## Input

`evidence-map.json`, schema `recede-evidence-map/1`. Trust its fields: `sources[].evClass`, `strength`, `provTier`, `checkKind`, `wiredToTrust`, and the `counts` block (`totalSources`, `wiredToTrust`, `byStrength`, `byClass`, `withArtifact`, `mutationAdequate`). Do not rescan and do not recount; the map is the ground truth.

## Step 1: rank leverage, top 3 only

Pick the three items where one small change moves the most gate posture. Never dump the full inventory; the adopter can open the JSON. Ranking heuristics, in order:

1. A high-volume class stuck at `optional-check` (L1) that branch protection could make `required-status-check` (L2). One settings edit, largest tier jump.
2. A class with `withArtifact: 0` where CI already produces a report (JUnit, coverage, mutation). Attaching the artifact is what lets credit rise above L1 later.
3. A class that exists in CI but never runs on merges (visible as low count relative to merge volume), or a missing class the repo obviously needs (no `review` sources, no `sast`).

Each item carries exactly one line of fix. The sharpest pattern, use it when it applies:

> Your integration suite runs but only as an optional check (L1). Make it a required status (L2) and `code.feature` promotes from checkpoint to autonomous.

State what flips, in gate-posture terms. Not "improves quality". Which lane, which posture, after how many samples under the declared policy.

## Step 2: emit proposed-policy.json

Shape: the `evidence_weights` table of a v0.2 Policy, keyed by discovered class, then tier. Same shape the scanner's starter policy uses and the pre-image of `/recede-wire`'s `recede.policy.ts`. Real starter shape from the fixture scan:

```json
{
  "weighting": "recede/ref-weighting-v0.2",
  "evidence_weights": {
    "e2e":    { "L1": 0.5 },
    "lint":   { "L1": 0.5 },
    "review": { "L1": 0.5 },
    "sast":   { "L1": 0.5 },
    "unit":   { "L1": 0.5 }
  },
  "never_recede": ["irreversible.critical"]
}
```

You may propose weights that differ from 0.5 where the leverage analysis argues for it. Every weight you write carries this framing, no exceptions:

> Declared policy. Edit freely. Not a prediction.

Put that line in `proposed-policy.json` as a top-level `"_note"` field and in `blueprint.md` above the table. The adopter authors the final numbers in their PR; you propose, they ratify.

## Step 3: write blueprint.md

Order inside the file:

1. Where this leads (2 sentences): the backfilled ledger and the gate-posture flip that `/recede-path` renders next. The blueprint is the setup, the ledger is the payoff.
2. The top-3 leverage items, each with its one-line fix and the posture it moves.
3. The proposed weight table with the declared-policy framing.
4. Next step: run `/recede-path`.

## Rules (binding)

- Top 3 only. A 40-item dump is a Scorecard clone, not a blueprint.
- Every weight is framed "declared policy, edit freely, not a prediction". Never assert a weight as correct or calibrated.
- No aggregate or cross-lane trust number, ever. No "your team scores 0.7". Per-lane posture only, and that rendering belongs to `/recede-path`.
- Never ask the adopter to hand-author `evidence_requirements`. It stays optional and default-empty; only `never_recede` lanes are pre-filled, and the gate already forces those.
- Boring result is a valid result. If the repo is already mostly L2 with clean history, say so: the value left is the lane map, forward sealing, and artifact adequacy. Do not inflate a leverage item to manufacture drama.
