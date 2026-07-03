<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# OpenWiki × Recede: trust-calibrated wikis

> **This is a WRAP, not a fork of OpenWiki.** OpenWiki generates a wiki from a
> codebase. Nothing in it knows whether a page is still true after the code
> beneath it moves. This adapter is the overlay that gives every generated page
> a trust trajectory under the [Recede protocol](../../SPEC.md): pages start at
> the epsilon floor on generation, decay when their cited source files change,
> and rise only on a human seal.

Recede is an **overlay**. It wraps a step you already run, turns your existing
checks into Verify/Validate evidence (**Warrants**), and a **pure `gate()`**
decides whether a human checkpoint fires. Trust is held per `(Actor, TaskType)`.
Here the Actor is the wiki generator and the TaskType is `doc.map`. OpenWiki
itself is never forked or patched: the wrap runs it as a child process and reads
its output.

**Zero runtime dependencies.** Node >= 22.18 via native TS type-stripping, no
build step. `git` is required for `decay` (the wrap runs against a working repo).

## The seam: OpenWiki generates, Recede remembers

An OpenWiki run produces pages. It cannot tell you which of those pages you
should still trust a month later, after the parser they document was rewritten.
Recede adds the one thing generation cannot: a **per-page trust trajectory**
backed by an append-only Warrant chain.

Four wiki events each seal one `doc.map` Warrant:

| Event | What happened | Recede evidence | Effect |
|---|---|---|---|
| `run` | the generator produced/updated pages | VERIFY (child exit, pages present, gitHead binding, plan snapshot) | new pages enter at the epsilon floor; the generator lane earns trust |
| `seal` | a human vouched for named pages | VALIDATE (`openwiki:human-seal:<id>`, confidence 0.95) | page score rises toward `ok` |
| `sample` | mechanical re-verification of cited refs at HEAD | VERIFY, one per page (FAIL when a page reaches the `action` band) | a broken page bands `action` and the generator lane loses trust |
| `decay` | source files moved under the pages | none (lane-non-counting) | cited pages drop multiplicatively; all pages relax toward the floor |

Each Warrant is `intent -> action -> checks -> outcome`, hash-linked and
content-addressed. Every event carries a `runId` so structurally identical
events never collapse into one warrant id.

## Quickstart

Run against any repo whose wiki you want to calibrate. The ledger path is always
yours to supply. Nothing is ever written to a default location.

```bash
# 1. wrap a generator run: snapshots the wiki, seals one doc.map warrant,
#    writes the sidecar + TRUST.md, and (with --inject) the AGENTS.md fence.
node integrations/openwiki/cli.ts run    --ledger ./wiki-trust.jsonl --inject -- openwiki

# 2. a human vouches for pages they reviewed: trust rises
node integrations/openwiki/cli.ts seal   --ledger ./wiki-trust.jsonl --page openwiki/parser.md --human yuval

# 3. code moved: decay the pages whose sources changed (git diff attribution)
node integrations/openwiki/cli.ts decay  --ledger ./wiki-trust.jsonl

# 4. mechanically re-verify cited refs at HEAD; a broken page bands "action"
node integrations/openwiki/cli.ts sample --ledger ./wiki-trust.jsonl --n 3 --seed 7

# 5. read the per-page table + the doc.map lane posture + a replay-integrity check
node integrations/openwiki/cli.ts status --ledger ./wiki-trust.jsonl

# 6. rebuild the sidecar from the ledger alone (byte-identical); --write to persist
node integrations/openwiki/cli.ts replay --ledger ./wiki-trust.jsonl --write

# 7. install or refresh the AGENTS.md trust fence (idempotent)
node integrations/openwiki/cli.ts inject --ledger ./wiki-trust.jsonl --create
```

Common flags: `--dir .` (repo root), `--wiki openwiki` (the wiki subdirectory),
`--actor openwiki` (the generator lane). A failed generator run (missing binary,
or child exits non-zero) seals no warrant and writes no trust state.

## The trust model

Two levels move independently:

**Per-page trust** lives in the sidecar and is a total function into
`[EPSILON, 1]`:

| Constant | Value | Meaning |
|---|---|---|
| `EPSILON` | 0.25 | generated-but-unsealed floor and starting score |
| `SEAL_GAIN` | 0.4 | seal raises: `score += SEAL_GAIN * (1 - score)` |
| `DIFF_DECAY_MULT` | 0.5 | source diff: `score = max(EPSILON, score * 0.5)` |
| `TIME_HALF_LIFE_MS` | 2592000000 | 30-day half-life, idle relaxation toward `EPSILON` |
| `OK_FLOOR` | 0.35 | `score >= OK_FLOOR` (and no adverse sample) reads as `ok` |
| `BROKEN_RATIO_ACTION` | 0.2 | a sample with `brokenRatio > 0.2`, or any missing cited file, reaches `action` |

A freshly generated page sits at 0.25, which is below `OK_FLOOR`, so it bands
`warning` until a human seals it. One seal takes it to 0.55 (`ok`). A source
diff under it halves the score toward the floor.

**Bands** grade a page for a reader: `ok` and `warning` come from the score
alone; `action` is reachable **only** from sample evidence (a cited file is
missing, or more than 20% of a page's refs broke). A clean sample never demotes
a page.

**The generator lane** is the `(actor, doc.map)` trust scope in the ledger. It
earns from `run` events and loses from bad `sample` events. A `decay` is
**lane-non-counting**: decay is a page-level freshness signal, not a
verification of the generator's work, so it moves neither the lane score nor its
sample count. The lane posture per risk class is what `status` prints.

**The conservative sourceless-page rule:** a page that cites no source files
decays on ANY diff in the repo. The wrap cannot prove an unrelated change left
that page true, so it errs toward distrust.

## The sidecar is a derived cache

Per-page state lives in `<wiki>/.trust/state.json`. It is a **cache**, not the
source of truth. The Warrant chain in the ledger is the only truth. `replay`
folds the chain back into the sidecar **byte-identically** (every fold uses the
warrant's own timestamp, never the wall clock), so you can delete `state.json`
and rebuild it:

```bash
rm openwiki/.trust/state.json
node integrations/openwiki/cli.ts replay --ledger ./wiki-trust.jsonl --write
```

`status` prints `SIDECAR REPLAY: PASS|FAIL` on every call, comparing the on-disk
sidecar against a fresh ledger replay and exiting non-zero on divergence.

## The AGENTS.md fence contract

An agent reading a repo should know how far to trust its wiki. Once an
`AGENTS.md` fence exists, every trust-writing command (`run`, `decay`, `seal`,
`sample`, `inject`) keeps it current between two markers:

```
<!-- openwiki-trust:begin -->
Some wiki pages have degraded trust. Verify flagged pages (see `TRUST.md`)
against their cited sources before relying on them.

- openwiki/parser.md (warning, 0.275)
<!-- openwiki-trust:end -->
```

The wrap edits **only** the bytes between the markers. Every byte outside them
is preserved verbatim. The fence language downgrades by the wiki's worst band
(`ok` / `warning` / `action`). If the markers are corrupt (missing one, doubled,
or reversed), the wrap refuses and leaves the file untouched. Creating a fence
where none exists takes `run --inject` or `inject`; `inject` additionally needs
`--create` to create a missing `AGENTS.md`. The other commands refresh an
existing fence but never add one to a fenceless file.

The wrap does **not** write trust into the wiki pages themselves: OpenWiki
rewrites those on the next run. Trust rides in the sidecar, `TRUST.md`, and the
fence, all of which survive regeneration.

## Files

| File | Responsibility |
|---|---|
| `openwiki-adapter.ts` | The pure mapping core: event model, trust math, sidecar fold/replay, renderers (TRUST.md, fence, trust-delta), and `doc.map` warrant sealing via the core ops. |
| `sampler.ts` | `samplePages` (staleness-weighted selection), `verifyPage`, the mechanical `MechanicalVerifier`, and the pluggable `ClaimVerifier` seam. |
| `cli.ts` | The thin CLI. Owns all process/fs/git I/O: wraps the generator child, watches `_plan.md`, drives the seven commands. |
| `demo.ts` | The offline full-loop proof (fixture wiki, no network, no LLM, no OpenWiki install). |
| `test/unit.test.ts` | Unit tests over the pure seam (math, fold, replay property, extraction, rendering, sampling). |
| `test/fixtures/fake-openwiki.ts` | A fixture generator that writes pages, writes-then-deletes `_plan.md` (the exact upstream behavior the wrap survives), and drops `.last-update.json`. |
| `examples/openwiki-trust-update.yml` | A GitHub Actions template: scheduled `run` + `decay` opening a trust-delta PR. |

## Run it

```bash
node integrations/openwiki/demo.ts                       # 52/52 assertions, fully offline
node --test integrations/openwiki/test/unit.test.ts      # 62/62 unit tests
```

The demo arranges a temp git repo, runs the fake OpenWiki generator, seals a
page, decays it after a source edit, samples a broken ref, and replays the
sidecar byte-identically. It proves the write boundary: nothing outside
`openwiki/.trust/`, `TRUST.md`, and the `AGENTS.md` fence is ever touched.

## Ceilings and upgrade paths

Deliberate MVP boundaries, each with its swap point:

- **Mechanical sampling only.** `MechanicalVerifier` checks that a cited file
  exists and (for a `path#symbol` ref) that the symbol string appears in the
  file. It does not confirm the prose is correct. `ClaimVerifier` is the
  pluggable seam: an LLM claim-checker is the named upgrade path. `anyMissing`
  stays mechanical regardless of the verifier, so the `action`-band ground truth
  cannot be spoofed by a lenient custom verifier.
- **Page-level trust.** Trust attaches to a whole page, not to individual
  claims. Per-claim trust is a future refinement.
- **Single runner.** No lockfile. Concurrent runs are last-writer-wins on
  `state.json`. The upgrade path is an `O_EXCL` `.trust/lock` file.

## Clean-room

Designed from first principles and public prior art only. This adapter
references no proprietary or employer-internal system, concept, or name. It is a
consumer-side mapping between a generic wiki generator and the open Recede
protocol.

## License

Apache-2.0 © 2026 Yuval Raz.
