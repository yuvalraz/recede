// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Recede reference implementation (TypeScript) — public surface.
 *
 * The primary, canonical implementation of the Recede protocol (SPEC.md).
 * Zero runtime dependencies. Everything a caller needs is re-exported here.
 */

// Content addressing
export { canonicalize, contentId, digest, hashBytes } from "./hash.ts";

// Records + the raw core ops
export {
  open,
  act,
  check as makeCheckRecord,
  checkpoint,
  sealOutcome as seal,
  type AnyRecord,
  type ActionRecord,
  type CheckRecord,
  type CheckKind,
  type CheckpointRecord,
  type Decision,
  type IntentRecord,
  type OutcomeRecord,
  type OutcomeResult,
  type RecordKind,
  type RiskClass,
  type Verdict,
  type Warrant,
} from "./records.ts";

// Policy + tiers
export {
  defaultPolicy,
  matrixCell,
  policyDigest,
  RISK_ORDER,
  TIERS,
  tierIndex,
  type DecayParams,
  type GateCell,
  type Policy,
  type Tier,
  type WeightParams,
} from "./policy.ts";

// The pure gate
export { gate, type GateDecision } from "./gate.ts";

// Reference weighting
export {
  clamp01,
  decayScore,
  foldSignal,
  signalOf,
  tierFor,
  type Signal,
} from "./weighting.ts";

// Policy-selected weighting-strategy seam (SPEC §9)
export {
  REF_WEIGHTING_V01,
  REF_WEIGHTING_V02,
  STRATEGIES,
  strategyFor,
  type WeightingStrategy,
} from "./weighting-strategy.ts";

// v0.2 pooled noisy-OR weighting profile (SPEC §9)
export {
  descOf,
  effectiveWeight,
  evRef,
  isTestClass,
  parseEvRef,
  pooledConfidence,
  referencePolicyV02,
  signalOfV02,
  UNKNOWN_WEIGHT,
  type EvDesc,
} from "./weighting-v0.2.ts";

// Pure trust reducers
export {
  coldStart,
  replay,
  update,
  type ReplayEntry,
  type Transition,
  type TrustState,
  type UpdateResult,
} from "./trust.ts";

// Ledgers
export { FileLedger, MemoryLedger, type Ledger } from "./ledger.ts";

// Checkpoint surfaces
export {
  autoApprove,
  consoleCheckpoint,
  fixedCheckpoint,
  type CheckpointHandler,
  type CheckpointPresentation,
  type HumanDecision,
} from "./checkpoint.ts";

// Ergonomic check builders
export {
  check,
  type CheckContext,
  type CheckResult,
  type CheckSpec,
} from "./check.ts";

// The front door
export {
  Recede,
  type RecedeConfig,
  type RunOptions,
  type RunResult,
} from "./recede.ts";
