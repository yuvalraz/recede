# Recede skills: the 15-minute on-ramp

Four skills that take a repo from "what evidence do we already produce" to a real, replay-verified trust ledger built from its own merge history, then to a wiring PR. Each is a harness-neutral `SKILL.md` prompt (name and description frontmatter plus instructions); any agent harness that can run shell commands can execute them. The judgment lives in the prompt; every command wraps a tested CLI.

## Prerequisite

One authenticated `gh` CLI session (or a read-only `GITHUB_TOKEN` it can use). Nothing here writes to GitHub. Node >= 22.18 (or >= 23.6), run from the recede repo root.

## The sequence

| Minutes | Skill | What it runs | What it emits |
|---|---|---|---|
| 0-5 | [`recede-scan`](recede-scan/SKILL.md) | `recede-scout scan` (read-only) | `evidence-map.json`, `starter-policy.json`, the headline |
| 5-10 | [`recede-blueprint`](recede-blueprint/SKILL.md) | reads the map, no network | `blueprint.md`, `proposed-policy.json` (top-3 leverage, declared weights) |
| 10-13 | [`recede-path`](recede-path/SKILL.md) | `recede-scout backfill`, `recede-cc10x status` | a backfilled trust ledger (in your state dir, never committed), `path.md` |
| 13-15 | [`recede-wire`](recede-wire/SKILL.md) | the `wire.ts` emitters (validated policy in, config out) | `recede.policy.ts`, `checks/*.ts`, `.github/workflows/recede-record.yml`; the adopter opens the PR |

Minute 10 to 13 is the point. The backfill replays your last 90 days of merges into per-`(actor, task_type)` trust lanes: non-zero sample counts, reverts already sealed `REVERTED`, a gate posture per risk class, and an `I2 replay integrity: PASS` self-check. Trust computed from history you already have, replay-verified, not a promise about day 90.

## What the numbers are and are not

- Backfilled rows are reconstructed, unsealed, from API state as of backfill. Hash-chain integrity starts at the first forward-sealed warrant. The skills render these captions verbatim; that is deliberate.
- Every weight is declared policy: yours to edit, never a prediction. The starter table is all-equal placeholders.
- No skill emits an aggregate "actor reliability" score. Per-lane posture only.

## Where things land

- `evidence-map.json`, `starter-policy.json`, `blueprint.md`, `proposed-policy.json`, `path.md`: working directory, safe to commit or discard.
- The trust ledger (JSONL): your state directory, for example `~/.recede/state/`. Personal data. Never commit it.
