<!--
Copyright 2026 Yuval Raz. Licensed under the Apache License, Version 2.0.
-->

# Agentic checkout — mandates meet oversight that recedes

A Nekuda-style mandate answers "did the user actually mean it?" before an agent
spends — a signed, scoped, ex-ante permission. It does not answer what comes
*after*: should this same agent keep buying unattended? That is a trust
question, not a signature question, and it changes with evidence. This example
wraps a mandate-carrying `shopping-agent` in [Recede](../../README.md) and
watches oversight move accordingly. It imports the canonical
[TypeScript reference implementation](../../reference/ts) and reimplements no
protocol logic. **Zero runtime dependencies.**

## Run it

```bash
node checkout.ts        # from this directory; requires Node >= 22.6
```

## What you'll watch

| # | Beat | What the trace shows |
|---|------|----------------------|
| 1 | **Baseline** | Card-not-present, human-not-present: every checkout on `commerce.checkout` stops for the cardholder at cold start (T0). |
| 2 | **Earning trust** | Clean, in-mandate reorders (within cap, on the allowlist) compound trust on their own lane, `commerce.reorder`. |
| 3 | **Recedes** | The same mandate, same call site — a reorder runs unattended. `outcome.checkpoint` is `undefined`; the Warrant is still sealed and on the ledger. |
| 4 | **Friendly fraud** | A chargeback arrives on a purchase that already settled SUCCESS. Reseal flips it to REVERTED, trust re-folds (asymmetric loss), and the checkpoint SNAPS BACK on the next reorder — no rule edited. |
| 5 | **Step-up** | A high-value, off-allowlist purchase declares `irreversible.critical`, which is `never_recede` in the reference policy (I3). It checkpoints every time, at any trust level — the reference's step-up authentication floor. |

## Mandate ↔ Warrant

| Nekuda mandate | Recede Warrant |
|---|---|
| id, cap, merchant allowlist, expiry, user signature | the **Intent** record — data-rich, ex-ante |
| "is this purchase in scope?" (cap, allowlist, totals) | **Verify** checks — mechanical, did-it-right |
| "was this the right purchase?" (kept vs. disputed) | **Validate** checks — the post-purchase judgment |
| a later chargeback | a **deferred-outcome reseal**: SUCCESS → REVERTED |

## The gate is implicit

```ts
const out = await r.run(() => chargeMerchant(order), {
  actor: "shopping-agent", taskType: "commerce.reorder",
  risk: "financial.reversible", intent: `order ${order.id}: buy from ${order.merchant}`,
  input: { cap: mandate.capAmount, allowlist: mandate.merchantAllowlist, requested: order.amount },
  checks: [withinCap, merchantAllowed, totalsReconcile, keptNotDisputed],
});
```

No `if (needsApproval)` lives in the agent. The mandate scopes what it MAY try;
the ledger decides what it MAY do without waking a human — and `never_recede`
decides what never stops needing one.

Nekuda makes agents able to pay; Recede makes good behavior pay.

## License

Apache-2.0 © 2026 Yuval Raz.
