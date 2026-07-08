<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# recede-scout: read-only evidence-discovery scanner

recede-scout walks a GitHub repo you already own and inventories the
machine-readable evidence already sitting there: merged PRs, reviews, workflow
runs, check runs, commit statuses, branch protection, deployments, attestations,
CODEOWNERS, and security alerts. It labels each source on a provenance-strength
ladder and writes two files:

- **`evidence-map.json`**: the discovered inventory (schema `recede-evidence-map/1`).
- **`starter-policy.json`**: a starter Recede `Policy` built through the audited
  `referencePolicyV02` constructor, with `all-equal` placeholder weights (or an
  empty table). It authors zero magnitude claims. You edit the numbers in a PR.

It is read-only. The only writes are those two output files. It records nothing,
touches no ledger, and sends nothing beyond your own gh-authenticated provider.

## Scope: this is discovery (P2), not wiring (P3)

recede-scout maps what exists. It does not backfill history, replay records,
detect reverts, or wire any source into a Recede gate. Every discovered source
carries `wiredToTrust: false` for a fresh adopter. The map's `counts` block is
the raw material a later `/recede-scan` skill turns into the "N sources, 0 wired,
top 3 cover X%" headline. Turning discovery into records and the four adoption
skills is P3.

## The 15-minute path

1. Point it at a repo. It prints what evidence you already produce and how strong
   each piece is.
2. It hands you a starter policy shaped to your discovered classes, weights left
   equal and unauthored.
3. P3 (skills + backfill) turns that map into wired trust. P2 stops at the map.

## Prerequisite: gh auth

The default source shells the authenticated [`gh`](https://cli.github.com) CLI.
Authenticate once:

```bash
gh auth status          # confirm you are logged in
gh auth login           # if not
```

The scanner reads only what your `gh` token can already read.

## Commands

```bash
# Scan one or more repos, write the map + starter policy.
node integrations/scanner/cli.ts scan \
  --repo owner/name[,owner/name…] \
  --out evidence-map.json \
  --policy-out starter-policy.json \
  [--mode all-equal|empty]     # default: all-equal
  [--source gh|fixture]        # default: gh
  [--fixture set.json]         # required with --source fixture
  [--branch main]              # branch whose protection sets required-ness
  [--pr-state merged|open|all] # default: merged
```

`generatedAt` is stamped here, at the CLI boundary. The pure core takes no clock,
so two runs of the same repo produce byte-identical maps apart from that stamp.

## The seam and its adapters

All classification, the two scan gotchas, map assembly, and policy emission are
pure and source-agnostic. A single `EvidenceSource` interface feeds them:

- **`GhApiEvidenceSource`**: the workhorse. Each method shells `gh` through
  `execFile` with an argument array (never a shell string), so a repo name can
  never be read as a shell token. Parsing is factored into pure functions
  (`parsePullRequests`, `parseCheckRuns`, and the rest) that are unit-tested
  offline against recorded, scrubbed JSON.
- **`FixtureEvidenceSource`**: in-memory, no I/O. It drives the pure core in CI
  with hand-authored synthetic fixtures.
- **`McpEvidenceSource`**: an interface-conformant scaffold. Every method throws
  `NotConnectedError` pointing at `GhApiEvidenceSource`, because
  github-mcp-server is not connected in this environment yet. The output contract
  is transport-agnostic, so a real MCP transport drops in later with no rework.

## The two scan gotchas

1. **Union, do not concatenate.** A GitHub Action result is itself a check run,
   so the check-runs list and the legacy combined-status list overlap.
   `unionChecks` returns every check run once, plus every status context with no
   name-matching check run. An Action is never double-counted.
2. **Snapshot at the SHA.** Check runs are bound to a commit SHA and vanish on a
   new push. Every check-derived entry carries the exact SHA it was observed at.
   Entries from different SHAs never merge.

## Tests

```bash
# Offline suite (no network, no gh spawn).
node --test "integrations/scanner/test/*.test.ts"
```

The gh-api parsing is proven by feeding recorded, scrubbed `gh` JSON to the pure
parse functions. The collector is proven by driving `collectScan` with the
fixture source. No test spawns `gh` or touches the network.

## Live smoke (manual, non-CI)

```bash
node integrations/scanner/scripts/smoke.ts [owner/name]   # default: yuvalraz/recede
```

The smoke runs the real `gh` adapter against one of your own public repos. It
asserts the active `gh` account before any call and refuses any non-public or
non-self-owned repo. It writes nothing and records nothing. It is a human
verification step, never a CI dependency.
