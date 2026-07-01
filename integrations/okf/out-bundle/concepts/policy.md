---
type: recede/policy
title: "Policy: recede.reference@0.1.0"
description: The versioned gate matrix and never-recede ceiling that governs every trust scope in this bundle.
tags:
  - recede
  - policy
  - gate
timestamp: "2026-06-02T12:00:00.000Z"
---

The policy that produced every gate decision in this bundle. Its **digest** pins each decision to the exact rules that made it (Recede invariant I6).

- **id**: `recede.reference`
- **version**: `0.1.0`
- **digest**: `sha256:e3bbda0bde646b86cc43ee0be78370f523b04b95261bf1297cb7a0ba8b5d6234`
- **never_recede** (checkpoint at every tier, invariant I3): `irreversible.critical`

## Gate matrix (RiskClass × Tier)

| RiskClass | T0 | T1 | T2 | T3 | T4 |
|---|---|---|---|---|---|
| `read.only` | checkpoint (full) | autonomous | autonomous | autonomous | autonomous |
| `reversible.low` | checkpoint (full) | checkpoint (brief) | autonomous | autonomous | autonomous |
| `financial.reversible` | checkpoint (full) | checkpoint (full) | checkpoint (brief) | autonomous | autonomous |
| `irreversible.critical` | checkpoint (full) | checkpoint (full) | checkpoint (full) | checkpoint (full) | checkpoint (full) |

Higher tier and lower risk mean less oversight; the matrix is monotone, so accumulating positive evidence provably moves a scope toward autonomous, and negative evidence provably re-introduces checkpoints.
