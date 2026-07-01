// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * The Gate — the pure receding-oversight decision function.
 *
 * gate(trust, risk, policy) reads current trust plus declared risk and returns
 * AUTONOMOUS or REQUIRE_CHECKPOINT(altitude). It is a pure function (I7): same
 * inputs, same output, no side effects. Every decision references the exact
 * policy digest that produced it (I6). Never-recede risk classes retain a
 * checkpoint at every tier (I3), overriding the matrix.
 */

import type { TrustState } from "./trust.ts";
import type { RiskClass } from "./records.ts";
import { matrixCell, policyDigest, type Policy } from "./policy.ts";

export interface GateDecision {
  autonomous: boolean;
  altitude?: string;
  reason: string;
  /** I6: the exact policy digest that produced this decision. */
  policy_digest: string;
}

/**
 * PURE. Decides whether the next action needs a human checkpoint.
 *
 * Order of reasoning:
 *  1. If the declared risk is in never_recede[], gate always (I3) — the floor.
 *  2. Otherwise consult the (RiskClass x Tier) matrix cell for the trust tier.
 *
 * Because the matrix is monotone (higher tier / lower risk => less oversight),
 * accumulating positive evidence provably moves a scope toward AUTONOMOUS and
 * negative evidence provably re-introduces checkpoints.
 */
export function gate(
  trust: TrustState,
  declared_risk: RiskClass,
  policy: Policy,
): GateDecision {
  const pd = policyDigest(policy);

  if (policy.never_recede.includes(declared_risk)) {
    return {
      autonomous: false,
      altitude: "full",
      reason: `never_recede: '${declared_risk}' retains a checkpoint at every tier (I3)`,
      policy_digest: pd,
    };
  }

  const cell = matrixCell(policy, declared_risk, trust.tier);
  if (cell.kind === "AUTONOMOUS") {
    return {
      autonomous: true,
      reason: `tier ${trust.tier} is autonomous for risk '${declared_risk}'`,
      policy_digest: pd,
    };
  }
  return {
    autonomous: false,
    altitude: cell.altitude,
    reason: `tier ${trust.tier} requires checkpoint for risk '${declared_risk}'`,
    policy_digest: pd,
  };
}
