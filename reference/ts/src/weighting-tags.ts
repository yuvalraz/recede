// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Weighting-profile tag constants — a dependency-free LEAF.
 *
 * These identify the SPEC §9 weighting profiles. They live here, importing
 * nothing from the weighting graph, so that `weighting-strategy.ts` (which
 * registers the v0.2 strategy) and `weighting-v0.2.ts` (which reads the v0.2
 * tag for `referencePolicyV02`) can both depend on the tags WITHOUT forming a
 * mutual import cycle. A cycle here would be a TDZ landmine: Node type-stripping
 * does not catch it, and a legit v0.2 policy would then hit a `ReferenceError`
 * at fold time instead of resolving its strategy.
 */

export const REF_WEIGHTING_V01 = "recede/ref-weighting-v0.1";
export const REF_WEIGHTING_V02 = "recede/ref-weighting-v0.2";
