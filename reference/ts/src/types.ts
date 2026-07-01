// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/** Shared leaf types, factored out to keep module imports acyclic. */

export type Decision = "APPROVE" | "REJECT" | "MODIFY" | "ESCALATE";

/** Minimal shape of a gate decision, for surfaces that render one. */
export interface GateDecisionLike {
  autonomous: boolean;
  altitude?: string;
  reason: string;
}
