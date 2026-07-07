// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// The weighting-strategy dispatch seam (SPEC §9). The default (undefined tag)
// MUST resolve to the byte-frozen reference v0.1 weighting; an UNREGISTERED tag
// MUST fail loud (protects I2 against a silent v0.2→v0.1 downgrade on replay).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, type Policy } from "../src/index.ts";
import { signalOf } from "../src/weighting.ts";
import {
  REF_WEIGHTING_V01,
  REF_WEIGHTING_V02,
  strategyFor,
} from "../src/weighting-strategy.ts";
import { buildWarrant, cleanSuccess, resetClock } from "./helpers.ts";

const policy = defaultPolicy();

beforeEach(() => resetClock());

// The undefined tag on the default policy resolves to the reference v0.1
// signalOf, unchanged, field-for-field.
test("strategyFor(defaultPolicy()) dispatches the byte-frozen v0.1 signalOf", () => {
  const w = cleanSuccess();
  const viaStrategy = strategyFor(policy).signalOf(w, policy);
  assert.deepEqual(viaStrategy, signalOf(w), "default must fold identically to v0.1");
});

// An explicit v0.1 tag resolves to the same reference function.
test("strategyFor() with the explicit v0.1 tag dispatches reference signalOf", () => {
  const p: Policy = { ...policy, weighting: REF_WEIGHTING_V01 };
  const w = cleanSuccess();
  assert.deepEqual(strategyFor(p).signalOf(w, p), signalOf(w));
});

// The v0.1 adapter ignores policy and forwards the Warrant verbatim, so the
// negative/REVERTED path (I4) is dispatched byte-identically too.
test("v0.1 dispatch forwards the negative path unchanged (I4 preserved)", () => {
  const rev = buildWarrant({
    result: "REVERTED",
    checks: [{ kind: "VALIDATE", verdict: "FAIL", confidence: 0.8 }],
  });
  assert.deepEqual(strategyFor(policy).signalOf(rev, policy), signalOf(rev));
});

// UNREGISTERED tag fails loud — never a silent fallback to v0.1 (I2 guard).
test("strategyFor() throws loud on an unregistered weighting tag", () => {
  const p: Policy = { ...policy, weighting: "recede/not-a-real-profile" };
  assert.throws(() => strategyFor(p), /unknown weighting strategy/);
});

// The v0.2 tag const is exported for the next phase to register against; it is
// NOT active in this phase, so referencing it stays greppable and stable.
test("v0.2 tag const is exported and distinct from v0.1", () => {
  assert.equal(REF_WEIGHTING_V02, "recede/ref-weighting-v0.2");
  assert.notEqual(REF_WEIGHTING_V01, REF_WEIGHTING_V02);
});
