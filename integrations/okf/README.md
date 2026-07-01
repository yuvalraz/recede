<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# Recede → OKF exporter

A thin exporter that serializes a [Recede](../../SPEC.md) trust ledger into a
conformant [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle — a directory of markdown files with YAML frontmatter that any OKF
consumer can read.

**Zero runtime dependencies.** Runs on Node ≥ 22.6 (tested on 26) via native TS
type-stripping — no build step. It imports the Recede TypeScript reference
implementation directly.

## Why this exists

Recede is an **overlay**: it wraps a step you already run and turns your existing
checks (tests, evals, CI gates, human approvals) into Verify/Validate evidence —
**Warrants** — while a pure `gate()` decides whether a human checkpoint fires.
The by-product is an append-only, hash-linked ledger of *why every action was
allowed to run the way it did*.

This exporter re-presents that ledger as **knowledge**. Each `(Actor, TaskType)`
trust scope becomes an OKF concept; its Warrant history becomes that concept's
`log.md`; a shared policy concept records the gate matrix that governs them all.
The result is portable, tool-neutral, and diff-friendly — you can commit it,
publish it, or feed it to any OKF-aware reader.

The exporter is genuinely thin: it computes no trust of its own. It calls
Recede's **pure** `replay()` to reconstruct each scope's standing byte-for-byte
from its Warrants (invariant I2), and the **pure** `gate()` to show the current
oversight posture per risk class. Nothing is asserted that the protocol can't
reconstruct.

## Bundle layout

```
out-bundle/
├── index.md                                  # root, progressive disclosure (no frontmatter)
└── concepts/
    ├── policy.md                             # type: recede/policy   — the shared gate matrix
    ├── <actor>-<task>.md                     # type: recede/trust-scope — current standing
    └── <actor>-<task>.log.md                 # type: recede/warrant-log — the Warrant history
```

- **`index.md`** — progressive disclosure over the bundle: links to the policy
  concept and every trust scope. Per OKF, index files carry no frontmatter.
- **`concepts/policy.md`** (`type: recede/policy`) — the `(RiskClass × Tier)`
  gate matrix, the `never_recede` ceiling (I3), and the **policy digest** that
  pins every gate decision (I6). Every scope concept cross-links to it.
- **`concepts/<actor>-<task>.md`** (`type: recede/trust-scope`) — one per
  `(Actor, TaskType)` scope, showing current **tier / score / confidence /
  sample_count** and the current gate posture per risk class. Cross-links to the
  policy concept and to its own log.
- **`concepts/<actor>-<task>.log.md`** (`type: recede/warrant-log`) — the
  scope's Warrant history, chronological (ISO date headings, newest first, per
  the OKF log convention). This log **is** the evidence chain: intent, check
  verdicts, any checkpoint decision, ground-truth source, and the content-hash
  warrant id.

### Frontmatter

Every non-index doc carries OKF frontmatter with the required `type` field plus
the recommended `title`, `description`, `tags`, and `timestamp`:

```yaml
---
type: recede/trust-scope
title: billing-bot · refund.issue
description: "Trust standing (T1, score 0.367, 32 samples) for billing-bot on refund.issue."
tags:
  - recede
  - trust-scope
  - "actor:billing-bot"
  - "task:refund.issue"
timestamp: "2026-06-01T09:03:57.000Z"
---
```

Frontmatter is emitted with a null-omitting rule that mirrors Recede's own
canonical form: absent/empty optional keys are dropped, so two identical inputs
serialize identically.

## Usage

```ts
import { MemoryLedger } from "../../reference/ts/src/index.ts";
import { exportLedgerToDir } from "./okf-export.ts";

const ledger = new MemoryLedger();
// ... run Recede over your steps so the ledger accrues Warrants ...

exportLedgerToDir(ledger, "./out-bundle", {
  clean: true,                          // wipe the dir first
  title: "Billing Bot — Recede Trust Ledger",
  // policy: defaultPolicy(),           // optional; must match what produced the ledger
});
```

Or build the bundle in memory (e.g. to inspect or write elsewhere):

```ts
import { exportBundle, writeBundle } from "./okf-export.ts";

const bundle = exportBundle(ledger, { title: "My Ledger" });
for (const doc of bundle.docs) console.log(doc.path);
writeBundle(bundle, "./out-bundle", { clean: true });
```

### API

| Export | Purpose |
|---|---|
| `exportBundle(ledger, opts?)` | Build an `OkfBundle` (in-memory docs) from a ledger. Read-only over the ledger. |
| `writeBundle(bundle, dir, {clean?})` | Persist a bundle to disk. `index.md` written without frontmatter. |
| `exportLedgerToDir(ledger, dir, opts?)` | Convenience: build + write in one call. |
| `renderFrontmatter` / `renderDoc` | The frontmatter/document serializers (exposed for testing). |
| `scopesIn` / `scopeSlug` | Scope discovery + filename slugging. |

`ExportOptions`: `{ policy?, title?, now? }`. Pass the **same** `policy` that
produced the ledger so the replayed standing and gate posture are correct — a
different policy would replay to a different state (that's I6 working as
intended).

## Demo

```bash
node integrations/okf/demo.ts
```

Builds a refund-style ledger (a billing bot earning trust on small refunds, a
high-stakes irreversible refund that still gates, a separate email-drafting
scope, and a deferred refund later REVERTED by a next-day fraud check), exports
it to `./out-bundle/`, prints the file tree and one sample concept file, and
verifies every non-index doc has a valid non-empty `type`.

## Conformance

A bundle conforms to OKF v0.1 when every non-reserved `.md` file has parseable
YAML frontmatter with a non-empty `type`, and reserved files (`index.md`,
`log.md`) follow their structures. This exporter satisfies that by construction;
the demo asserts it (`Bundle CONFORMS: N docs checked.`) and exits non-zero if
any doc is missing a `type`.

## License

Apache-2.0 © 2026 Yuval Raz.
