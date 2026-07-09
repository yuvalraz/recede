---
name: recede-scan
description: Discover the machine-readable evidence already present in a GitHub repo and render the headline. Wraps the read-only recede-scout scan CLI. First step of the 15-minute sequence; feeds /recede-blueprint.
---

# /recede-scan

Discover what evidence a repo already produces. Read-only. Emits `evidence-map.json` plus a starter policy, then renders one headline built from tooling-emitted counts.

One thing to hold while you narrate: the inventory is the commodity part. The map exists to feed `/recede-blueprint` and `/recede-path`, where the backfilled ledger and the gate posture live. Do not present the inventory as the payoff.

## Prerequisites

- An authenticated `gh` CLI (or a read-only `GITHUB_TOKEN` it can use). The scan reads; it never writes to GitHub.
- Node >= 22.18 (or >= 23.6), run from the recede repo root. Older Node needs `--experimental-strip-types` before each `.ts` invocation.

## Step 1: run the scan

```bash
node integrations/scanner/cli.ts scan \
  --repo <owner/name> \
  --out evidence-map.json \
  --policy-out starter-policy.json
```

`--repo` accepts a comma-separated list for multi-repo scans. The only writes are the two output files.

Expected shape (real output from the bundled fixture, `--repo acme/widget --source fixture --fixture integrations/scanner/test/fixtures/merge-history/widget.json`):

```
recede-scout: scanned 1 repo(s) via fixture
  sources    12 (wired 0)
  strength   L3 signed=0  L2 required=0  L1 optional=11  L1 self=1
  classes    e2e:1  lint:3  sast:1  unit:6  review:1
  artifacts  auto-discovery: found 0 artifact(s), attached 0 (withArtifact=0; pass --artifact to override)
  wrote      evidence-map.json
  wrote      starter-policy.json  (starter policy, mode=all-equal, never_recede intact)
```

If the command fails with an auth error, stop and tell the adopter to run `gh auth login`. Do not retry with invented flags.

## Step 2: compute the headline numbers (never by hand)

The headline numbers come from `evidence-map.json.counts`, verbatim. The top-3 coverage percentage is computed by this snippet, not by mental arithmetic. Run it exactly:

```bash
node -e "const m=require(process.argv[1]);const c=m.counts;const top=Object.entries(c.byClass).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1)).slice(0,3);const covered=top.reduce((s,[,n])=>s+n,0);console.log(JSON.stringify({totalSources:c.totalSources,repos:m.repos.length,wiredToTrust:c.wiredToTrust,top3:top.map(([k,n])=>k+':'+n),top3Pct:Math.round(100*covered/c.totalSources)}))" "$PWD/evidence-map.json"
```

Real output against the fixture map:

```
{"totalSources":12,"repos":1,"wiredToTrust":0,"top3":["unit:6","lint:3","e2e:1"],"top3Pct":83}
```

## Step 3: render the headline

If `totalSources` is 0, skip the template. State it flat: "No machine-readable evidence sources surfaced in this repo. The scan found no check runs, statuses, protections, or attestations to map." Then point forward honestly: `/recede-path` still works, because the backfill rides merge history, not checks; warrants with zero check evidence fold on the held path by design. Do not render a percentage of zero sources.

Otherwise, fill the template only with the numbers from step 2:

> Detected {totalSources} machine-readable evidence sources across {repos} repo(s). {wiredToTrust} are wired to trust gates today. Wiring the top 3 classes ({top3}) covers {top3Pct}% of your discovered surfaces.

For the fixture: "Detected 12 machine-readable evidence sources across 1 repo. 0 are wired to trust gates today. Wiring the top 3 classes (unit, lint, e2e) covers 83% of your discovered surfaces."

## Step 4: label every source on the strength ladder

Each entry in `evidence-map.json.sources` already carries `strength` and `provTier`. Render each source with its label. The ladder, strongest first:

| Strength | Tier | Meaning |
|---|---|---|
| `signed-provenance` | L3 | Cryptographically attested (artifact attestation) |
| `required-status-check` | L2 | Branch protection makes it mandatory |
| `optional-check` | L1 | Runs, but a merge does not require it |
| `self-reported` | L1 | The actor's own claim, weakest rung |

Do not invent a strength. If the map says `optional-check`, say `optional-check`.

## Output

- `evidence-map.json` (schema `recede-evidence-map/1`) and `starter-policy.json` on disk.
- The headline plus a per-source table with strength labels.
- One closing line: the map is input, not outcome. Next: `/recede-blueprint` ranks the leverage, `/recede-path` shows the ledger this history already earns.

## Rules

- Every number in the headline is tooling-emitted or produced by the step 2 snippet. Never compute a percentage in your head.
- The starter policy is all-equal placeholders. Never present its weights as calibrated or predictive.
- Read-only means read-only: `scan` writes the two files and nothing else.
