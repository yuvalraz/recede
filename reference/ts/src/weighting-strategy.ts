// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Policy } from "./policy.ts";
import type { Warrant } from "./records.ts";
import { signalOf, type Signal } from "./weighting.ts";
import { REF_WEIGHTING_V01, REF_WEIGHTING_V02 } from "./weighting-tags.ts";
import { signalOfV02 } from "./weighting-v0.2.ts";

// Re-export the profile tags so the public surface (index.ts) is unchanged; the
// literal values live in the dependency-free leaf `weighting-tags.ts` to break
// the weighting-strategy <-> weighting-v0.2 import cycle (A2).
export { REF_WEIGHTING_V01, REF_WEIGHTING_V02 };

/**
 * A weighting strategy: how a sealed Warrant's Signal is extracted. Pure (I7) —
 * a function of the Warrant and Policy only, with no I/O and no clock.
 */
export interface WeightingStrategy {
  signalOf(w: Warrant, policy: Policy): Signal;
}

// v0.1 adapter: reuse the byte-frozen reference signalOf; policy is ignored (the
// reference weighting derives everything from the Warrant's checks).
const v01: WeightingStrategy = { signalOf: (w, _policy) => signalOf(w) };

/**
 * The strategy registry. The v0.2 pooled profile is registered here at
 * LITERAL-DECLARATION time (a static map entry), not via a mutating import
 * side-effect — so dispatch is not import-order-dependent (protects I7). The
 * one-way import (`weighting-strategy.ts` -> `weighting-v0.2.ts`) is cycle-free
 * because the shared tag consts live in the `weighting-tags.ts` leaf (A2).
 */
export const STRATEGIES: Record<string, WeightingStrategy> = {
  [REF_WEIGHTING_V01]: v01,
  [REF_WEIGHTING_V02]: { signalOf: signalOfV02 },
};

/**
 * PURE lookup. `undefined` tag ⇒ the reference v0.1 strategy. An UNREGISTERED
 * tag FAILS LOUD: a silent fallback to v0.1 would let a warrant folded under a
 * different profile replay under v0.1 to a divergent state, breaking I2
 * undetectably. (A wrong-but-REGISTERED tag does not throw — that mismatch is
 * audit-detectable via a policy_digest difference, not a replay throw.)
 */
export function strategyFor(policy: Policy): WeightingStrategy {
  const key = policy.weighting ?? REF_WEIGHTING_V01;
  const s = STRATEGIES[key];
  if (!s) {
    throw new Error(
      `unknown weighting strategy '${key}' (I2: refusing silent fallback)`,
    );
  }
  return s;
}
