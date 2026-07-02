# Changelog

All notable changes to Recede are documented here. Pre-1.0: breaking changes expected.

## [0.1.0] — Unreleased (DRAFT)

Initial public draft of the Recede protocol.

- **Narrative repositioning** — Recede is a universal trust protocol for agentic work; the SDLC is the *entry manifestation*, not the identity. README + site now lead with the universal thesis and a "one protocol, many flows" gallery (SDLC · refunds · conversational · intake).

- **SPEC.md** — records + canonical serialization (null-omitting), trust model, tiers, invariants I1–I7, the pure `gate()`/`update()`/`replay()`, threat model, and conformance (normative core vs the named `recede/ref-weighting-v0.1` profile).
- **schemas/** — machine-readable JSON Schema for the record types (Intent, Action, Check, Outcome, Checkpoint).
- **reference/ts** — TypeScript reference implementation (primary), `run()` front door over the eight-op protocol.
- **reference/py** — Python mirror.
- **conformance/** — a shared `vectors.json` both implementations replay to a byte-identical TrustState (cross-language conformance).
- **examples/sdlc** — the everyday case: a coding agent earning autonomy on `code.fix` as verified changes compound, with `code.migrate` never receding.
- **examples/refund** — the higher-stakes frontier: the same protocol on money-movement, incl. a deferred `REVERTED` outcome.
- **examples/agentic-checkout** — a Nekuda-style mandate-carrying shopping agent: trust compounds on reorders, a friendly-fraud chargeback reseals SUCCESS → REVERTED and the checkpoint snaps back, and a high-value/new-merchant purchase never recedes.
- **INTEGRATIONS.md** + **integrations/cc10x** (force-multiplier reference adapter) + **integrations/okf** (Recede ledger → Open Knowledge Format bundle) + Nekuda / agentic commerce pairing.
- **site/** — a self-contained landing page.
