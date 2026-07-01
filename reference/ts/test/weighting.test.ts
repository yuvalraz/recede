// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Proves the reference weighting: asymmetry, decay+drift, near-miss ratchet,
// trust-theater guard, and the gate matrix monotonicity.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  coldStart,
  decayScore,
  defaultPolicy,
  gate,
  replay,
  tierIndex,
  update,
} from "../src/index.ts";
import { buildWarrant, cleanSuccess, resetClock } from "./helpers.ts";

const policy = defaultPolicy();
beforeEach(() => resetClock());

test("asymmetry: one failure erases more than one success adds", () => {
  const gainState = update(coldStart("bot", "x"), cleanSuccess(), policy).state;
  const gain = gainState.score - 0;

  const primed = replay("bot", "x", Array.from({ length: 10 }, () => cleanSuccess()), policy);
  const fail = buildWarrant({ result: "FAILURE", checks: [{ kind: "VERIFY", verdict: "FAIL", confidence: 1 }] });
  const afterFail = update(primed, fail, policy).state;
  const loss = primed.score - afterFail.score;

  assert.ok(loss > gain, `loss (${loss.toFixed(3)}) must exceed a single gain (${gain.toFixed(3)})`);
});

test("asymmetry: slow-earn — score climbs with diminishing returns", () => {
  let st = coldStart("bot", "x");
  const steps: number[] = [];
  for (let i = 0; i < 6; i++) {
    const prev = st.score;
    st = update(st, cleanSuccess(), policy).state;
    steps.push(st.score - prev);
  }
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] <= steps[i - 1] + 1e-9, "each positive step is no larger than the last");
  }
});

test("human APPROVE matching proposal is a strong positive; MODIFY is scored as failure", () => {
  const approve = update(coldStart("bot", "x"), buildWarrant({ decision: "APPROVE", result: "SUCCESS", checks: [{ kind: "VALIDATE", verdict: "PASS", confidence: 0.9 }] }), policy).state;
  assert.ok(approve.score > 0);

  const primed = replay("bot", "x", Array.from({ length: 10 }, () => cleanSuccess()), policy);
  // MODIFY even with an eventual SUCCESS => wrong proposal => demotion.
  const modified = update(primed, buildWarrant({ decision: "MODIFY", result: "SUCCESS" }), policy).state;
  assert.ok(modified.score < primed.score, "MODIFY lowers score despite SUCCESS");
  assert.ok(tierIndex(modified.tier) < tierIndex(primed.tier), "MODIFY forces a demotion");
});

test("near-miss ratchet: an autonomous action later REVERTED takes an extra debit", () => {
  const primed = replay("bot", "x", Array.from({ length: 12 }, () => cleanSuccess()), policy);

  // Reverted WITHOUT a checkpoint (i.e. it had run autonomously) => ratchet.
  const autoReverted = buildWarrant({ result: "REVERTED" });
  const ratcheted = update(primed, autoReverted, policy).state;

  // Reverted but a human had checkpointed it (not autonomous) => no ratchet bonus.
  const gatedReverted = buildWarrant({ result: "REVERTED", decision: "APPROVE" });
  const gated = update(primed, gatedReverted, policy).state;

  assert.ok(ratcheted.score < gated.score, "autonomous revert is penalized harder than a gated one");
});

test("trust theater: an action with no closed outcome moves nothing", () => {
  const primed = replay("bot", "x", Array.from({ length: 5 }, () => cleanSuccess()), policy);
  // Warrant with checks but no outcome and no decision.
  const open = buildWarrant({ checks: [{ kind: "VERIFY", verdict: "PASS", confidence: 1 }] });
  const after = update(primed, open, policy).state;
  assert.equal(after.score, primed.score, "no closed evidence => no movement");
  assert.equal(after.sample_count, primed.sample_count);
});

test("decay: idle time relaxes score toward the tier floor", () => {
  const halfLife = policy.decay.idle_half_life_ms;
  const floor = policy.weights.score_tier_floor[3]; // T3 floor
  const decayed = decayScore(0.9, "T3", halfLife, 0, policy);
  const expected = floor + (0.9 - floor) * 0.5;
  assert.ok(Math.abs(decayed - expected) < 1e-9, `one half-life halves the distance to floor`);
});

test("drift discount: input drift pulls score further toward the floor", () => {
  const noDrift = decayScore(0.9, "T2", 0, 0, policy);
  const withDrift = decayScore(0.9, "T2", 0, 1, policy);
  assert.ok(withDrift < noDrift, "drift discounts score");
});

test("decay crossing a tier boundary emits a transition record", () => {
  // High tier with lots of samples, then a long idle gap with no new evidence.
  const primed = replay("bot", "x", Array.from({ length: 70 }, () => cleanSuccess()), policy);
  const idleWarrant = cleanSuccess(); // fold with a big idle gap + drift
  const { transition } = update(primed, idleWarrant, policy, {
    idle_ms: policy.decay.idle_half_life_ms * 6,
    drift: 1,
  });
  // The idle+drift may or may not cross depending on the fold; if the tier
  // changed a transition MUST be present.
  const before = primed.tier;
  const res = update(primed, idleWarrant, policy, { idle_ms: policy.decay.idle_half_life_ms * 6, drift: 1 });
  if (res.state.tier !== before) {
    assert.ok(res.transition, "a tier change MUST emit a transition");
    assert.equal(res.transition!.from, before);
  } else {
    assert.equal(res.transition, undefined);
  }
});

test("gate matrix is monotone: higher tier and lower risk never increase oversight", () => {
  const tiers = ["T0", "T1", "T2", "T3", "T4"] as const;
  const risks = ["read.only", "reversible.low", "financial.reversible"]; // exclude never_recede
  for (const risk of risks) {
    let prevAutonomousTier = -1;
    for (let i = 0; i < tiers.length; i++) {
      const st = { ...coldStart("b", "x"), tier: tiers[i], sample_count: 999, confidence: 1, score: 1 };
      const auto = gate(st, risk, policy).autonomous;
      if (auto && prevAutonomousTier < 0) prevAutonomousTier = i;
      // Once autonomous at some tier, all higher tiers stay autonomous.
      if (prevAutonomousTier >= 0) assert.equal(auto, true, `${risk} regressed at ${tiers[i]}`);
    }
  }
});
