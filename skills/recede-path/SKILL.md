---
name: recede-path
description: Backfill the trust ledger from real merge history and render the click, then emit the staged rollout in path.md. Wraps recede-scout backfill and recede-cc10x status. Third step of the 15-minute sequence.
---

# /recede-path

This is the click. Replay the repo's last 90 days of merge history into a real trust ledger, show the lanes and gate posture that history already earns, then write `path.md`, the staged rollout. Everything before this was inventory. Lead with the ledger.

## Step 1: pick a ledger path OUTSIDE the repo

The ledger is personal state, never committed. Put it in a state directory outside any repo tree, for example:

```bash
mkdir -p ~/.recede/state
```

Ledger path: `~/.recede/state/<owner>-<repo>.backfill.jsonl`. The backfill CLI refuses a non-empty ledger (a re-run would silently double every count), so each backfill gets a fresh path.

## Step 2: run the backfill

```bash
node integrations/scanner/cli.ts backfill \
  --repo <owner/name> \
  --ledger ~/.recede/state/<owner>-<repo>.backfill.jsonl
```

Expected shape (real output from the bundled fixture, `--repo acme/widget --source fixture --fixture integrations/scanner/test/fixtures/merge-history/widget.json`):

```
recede-scout backfill: acme/widget via fixture
  reconstructed  6 warrant(s) across 3 lane(s)
  reverts        1 resealed REVERTED
  dropped        0 merged PR(s) skipped (null mergedAt)
  forwardSealed  0 (backfill records nothing forward)
  wrote          ~/.recede/state/acme-widget.backfill.jsonl
  wrote          ~/.recede/state/acme-widget.backfill.jsonl.policy.json  (fold-policy sidecar; status replays under it)
  I2 replay integrity: PASS — forward replay()==stored 2/2, revert lanes demoted 1/1 (policy recede.reference@0.2.0)

  note: reconstructed, unsealed, from API state as of backfill.
        hash-chain integrity starts at the first forward-sealed warrant.
        trust computed under the v0.2 pooled profile with an ALL-EQUAL placeholder weight
        table — these weights are yours to declare, not a prediction; edit them in the PR.
```

Render this summary to the adopter with the counts and ALL FOUR caption lines verbatim: the reconstructed/unsealed line, the hash-chain line, and the two placeholder-weights lines. They are the honesty contract of the whole sequence. Never trim them.

The `I2 replay integrity: PASS` line printed HERE is the authoritative integrity proof for a backfilled ledger. It replays under the same v0.2 pooled policy the ledger was folded with.

## Step 3: read the lane table and gate posture

```bash
node integrations/cc10x/cli.ts status \
  --ledger ~/.recede/state/<owner>-<repo>.backfill.jsonl
```

Real output on the fixture-backfilled ledger:

```
ACTOR            TASK          TIER  SCORE  CONF   N    UPDATED                   I2
octo-dev         code.fix      T0    0.145  0.168  2    2026-04-08T00:00:00Z      PASS
                 gate: read.only=checkpoint(full)  reversible.low=checkpoint(full)  financial.reversible=checkpoint(full)  irreversible.critical=checkpoint(full,never-recedes)
dependabot[bot]  code.fix      T0    0.246  0.283  3    2026-04-06T00:00:00Z      PASS
                 gate: read.only=checkpoint(full)  reversible.low=checkpoint(full)  financial.reversible=checkpoint(full)  irreversible.critical=checkpoint(full,never-recedes)
octo-dev         code.feature  T0    0.000  0.000  1    -                         PASS
                 gate: read.only=checkpoint(full)  reversible.low=checkpoint(full)  financial.reversible=checkpoint(full)  irreversible.critical=checkpoint(full,never-recedes)
I2 replay integrity: PASS — replay() == stored trust for 3/3 lanes (policy recede.reference@0.2.0)
```

`status` is policy-aware: it reads the `.policy.json` sidecar the backfill wrote next to the ledger and replays under the same v0.2 pooled policy the fold used, so `I2 replay integrity: PASS` here verifies the backfilled ledger directly (exit 0). Keep the sidecar next to the ledger; a tampered or mismatched sidecar makes `status` refuse loudly. One caveat for old ledgers: without a sidecar, `status` replays under the v0.1 coding policy (the pre-sidecar default), so a v0.2 backfilled ledger that lost its sidecar reads FAIL there.

## Step 4: render the readiness matrix (the landscape)

```bash
node integrations/cc10x/cli.ts matrix \
  --ledger ~/.recede/state/<owner>-<repo>.backfill.jsonl \
  --out readiness.json
```

One table: rows are lanes, columns are your policy's risk classes, each cell is the gate posture today. Every checkpoint cell carries a footnote with two facts: the binding constraint (what holds it) and the cheapest move (how many clean cycles flip it, computed against your declared policy, no idle decay assumed). NEVER cells are the never-recede floor, by design; their move is none. Expected shape (real output from the bundled fixture):

```
policy recede.reference@0.2.0 (digest sha256:81c120c2ff2d) · generated <ISO>
3 lanes · 12 cells: 0 autonomous · 0 checkpoint(brief) · 9 checkpoint(full) · 3 never-recede
(counts, never averaged — per-lane posture only)

| lane | tier | score | conf | n | updated | i2 | read.only | reversible.low | financial.reversible | irreversible.critical |
|---|---|---|---|---|---|---|---|---|---|---|
| dependabot[bot] · code.fix * | T0 | 0.246 | 0.283 | 3 | 2026-04-06T00:00:00Z | PASS | cp(full) [1] | cp(full) [2] | cp(full) [3] | NEVER |
```

Embed the full rendered matrix in `path.md` as the centerpiece. It is the landscape view: where review can recede today, what holds each cell, and the cheapest honest move. `matrix` is fail-closed: if any lane fails I2 replay it exits 1 and writes nothing. `readiness.json` is the durable artifact (schema `recede-readiness/1`); the markdown is a disposable render of it.

## Step 5: render the click

Lead with the ledger, in this order:

1. The matrix from step 4: the whole landscape in one table, posture per lane per risk class.
2. The reverts: already sealed `REVERTED`, and the demoted lane that proves trust here can fall, not only rise.
3. The footnotes: what holds each checkpoint cell, and the cheapest move that flips it.
4. The integrity line from step 2: `I2 replay integrity: PASS`, replay-verified, not asserted.

Then the inventory numbers from `/recede-scan`, as supporting detail. Never open with them.

## Step 6: emit path.md

The staged rollout, three stages:

1. **Record-only (now).** The backfilled ledger exists; forward warrants get sealed as work happens. Gates change nothing yet. Zero team-behavior change.
2. **Advisory.** Gate decisions are computed and shown on each recorded cycle, not enforced. The team sees what would have checkpointed.
3. **Gated (later).** A pre-action `recede-cc10x gate` consult: the workflow asks the gate before acting, with exit codes usable as a required status check. It ships when you reach this stage. Flip one low-risk lane first, expand as samples accumulate. `never_recede` lanes stay checkpointed at every stage.

Note in `path.md` that stages 1 and 2 map onto the recorder's `--mode record-only|advisory` flag (default `record-only`), wired in `/recede-wire`. Stage 3 is not a recorder mode: recording happens post-merge, so enforcement lives in the pre-action consult, not the recorder.

Include the boring-result path: a repo with a low unreviewed rate and no reverts still gets the lane map, the gate posture per risk class, and forward sealing from day one. That is the durable value; the backfill is the seed, not the show. Never promise a shocking number.

Close `path.md` with the same four honesty caption lines from step 2, verbatim.

## Rules (binding)

- The story LEADS with the backfilled ledger and the gate-posture flip. The inventory is supporting detail.
- The honesty captions appear verbatim, in the rendered summary and in `path.md`.
- No aggregate or cross-lane trust number. Per-lane posture only.
- The ledger path is always outside the repo. If the adopter proposes a path inside a repo tree, refuse and explain in one line.
- Weights are declared policy, edit-me, not a prediction. The trust numbers rendered here are placeholder-policy numbers and say so.
- The matrix carries no aggregate: its summary line is cell counts, never averaged trust. Do not add a readiness score.
