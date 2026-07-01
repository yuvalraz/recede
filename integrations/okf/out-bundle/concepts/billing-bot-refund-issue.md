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

Trust standing for actor **`billing-bot`** on task type **`refund.issue`**. Trust is scoped to this exact pair (Recede invariant I1) — nothing this actor earned on another task type influences this scope.

## Current standing

- **tier**: `T1`
- **score**: 0.366534
- **confidence**: 0.987177
- **sample_count**: 32
- **last updated**: 2026-06-01T09:03:57.000Z

## Gate posture (current)

How the pure gate would decide the next action at each risk class, given this standing:

| RiskClass | Decision |
|---|---|
| `read.only` | autonomous |
| `reversible.low` | checkpoint (brief) |
| `financial.reversible` | checkpoint (full) |
| `irreversible.critical` | checkpoint (full) |

This posture is governed by the [bundle policy](/concepts/policy.md). The full evidence history that produced this standing is in the [scope log](/concepts/billing-bot-refund-issue.log.md) — that log **is** the Warrant chain, chronological.
