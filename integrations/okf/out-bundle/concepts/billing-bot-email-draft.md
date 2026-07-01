---
type: recede/trust-scope
title: billing-bot · email.draft
description: "Trust standing (T1, score 0.536, 6 samples) for billing-bot on email.draft."
tags:
  - recede
  - trust-scope
  - "actor:billing-bot"
  - "task:email.draft"
timestamp: "2026-06-01T09:03:49.000Z"
---

Trust standing for actor **`billing-bot`** on task type **`email.draft`**. Trust is scoped to this exact pair (Recede invariant I1) — nothing this actor earned on another task type influences this scope.

## Current standing

- **tier**: `T1`
- **score**: 0.535596
- **confidence**: 0.595433
- **sample_count**: 6
- **last updated**: 2026-06-01T09:03:49.000Z

## Gate posture (current)

How the pure gate would decide the next action at each risk class, given this standing:

| RiskClass | Decision |
|---|---|
| `read.only` | autonomous |
| `reversible.low` | checkpoint (brief) |
| `financial.reversible` | checkpoint (full) |
| `irreversible.critical` | checkpoint (full) |

This posture is governed by the [bundle policy](/concepts/policy.md). The full evidence history that produced this standing is in the [scope log](/concepts/billing-bot-email-draft.log.md) — that log **is** the Warrant chain, chronological.
