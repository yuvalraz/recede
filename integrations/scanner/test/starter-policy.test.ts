// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.3 — emitStarterPolicy: a starter `Policy` built ONLY via the audited
 * `referencePolicyV02` constructor (Durable Decision 4). Provable property 2 (no
 * authored magnitudes): `empty` mode yields an empty table; `all-equal` (default)
 * yields ONE named placeholder value keyed by the DISCOVERED classes (excluding
 * `unknown`). Property 3 (digest floor): `never_recede` stays intact,
 * `version:"0.2.0"`, and the starter digest DIFFERS from the default (it is a real
 * 0.2.0 policy) while `policyDigest(defaultPolicy())` is UNMOVED.
 *
 * Namespace import so the not-yet-defined `emitStarterPolicy` is `undefined`
 * during RED and calling it throws behaviorally — a real RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { policyDigest, defaultPolicy } from "../../../reference/ts/src/index.ts";
import * as scanner from "../scanner.ts";

const SHA_A = "a".repeat(40);

// A scan with three discovered classes (unit, lint, deploy) plus an unknown legacy
// status. The unknown MUST be excluded from the starter table.
function threeClassScan(): scanner.RepoScan {
  return {
    repo: { owner: "acme", repo: "example" },
    discoveredVia: "fixture",
    requiredChecks: ["unit-tests"],
    surfaces: [
      { name: "unit-tests", sha: SHA_A, conclusion: "success", kind: "check-run", detailsUrl: "https://x.test/1" },
      { name: "eslint", sha: SHA_A, conclusion: "success", kind: "check-run", detailsUrl: "https://x.test/2" },
      { name: "deploy-prod", sha: SHA_A, conclusion: "success", kind: "check-run", detailsUrl: "https://x.test/3" },
      { name: "some-random-thing", sha: SHA_A, conclusion: "success", kind: "status", detailsUrl: "https://x.test/4" },
    ],
    attestations: [],
  };
}

test("emitStarterPolicy: all-equal (default) keys the DISCOVERED classes only, one equal placeholder", () => {
  const map = scanner.buildEvidenceMap([threeClassScan()]);
  const policy = scanner.emitStarterPolicy(map);
  const weights = policy.evidence_weights ?? {};
  const classes = Object.keys(weights).sort();
  assert.deepEqual(classes, ["deploy", "lint", "unit"], "discovered classes only, no unknown");
  // Every emitted weight is the SAME single value (all-equal → zero authored claims).
  const values = new Set<number>();
  for (const tiers of Object.values(weights)) {
    for (const w of Object.values(tiers ?? {})) values.add(w as number);
  }
  assert.equal(values.size, 1, "all weights are one and the same placeholder");
  const [placeholder] = [...values];
  assert.ok(placeholder >= 0 && placeholder <= 1, "placeholder is a valid weight in [0,1]");
});

test("emitStarterPolicy: empty mode authors NO magnitude", () => {
  const map = scanner.buildEvidenceMap([threeClassScan()]);
  const policy = scanner.emitStarterPolicy(map, { mode: "empty" });
  assert.deepEqual(policy.evidence_weights, {}, "empty table: no authored magnitude");
});

test("emitStarterPolicy: never_recede intact, version 0.2.0, weighting tag set", () => {
  const map = scanner.buildEvidenceMap([threeClassScan()]);
  const policy = scanner.emitStarterPolicy(map);
  assert.deepEqual(policy.never_recede, ["irreversible.critical"], "never_recede floor intact");
  assert.equal(policy.version, "0.2.0");
  assert.equal(policy.weighting, "recede/ref-weighting-v0.2");
});

test("emitStarterPolicy: digest DIFFERS from default (it is a real 0.2.0 policy), default UNMOVED", () => {
  const before = policyDigest(defaultPolicy());
  assert.equal(
    before,
    "sha256:e3bbda0bde646b86cc43ee0be78370f523b04b95261bf1297cb7a0ba8b5d6234",
    "default digest floor pinned",
  );
  const map = scanner.buildEvidenceMap([threeClassScan()]);
  const starterAllEqual = scanner.emitStarterPolicy(map);
  const starterEmpty = scanner.emitStarterPolicy(map, { mode: "empty" });
  assert.notEqual(policyDigest(starterAllEqual), before, "all-equal starter is not the default");
  assert.notEqual(policyDigest(starterEmpty), before, "even empty starter is a 0.2.0 policy, not the default");
  // Importing/using the scanner did not perturb the default digest.
  assert.equal(policyDigest(defaultPolicy()), before, "default digest UNMOVED after scanner use");
});

test("emitStarterPolicy: no discovered classes → empty all-equal table (all unknown excluded)", () => {
  const scan: scanner.RepoScan = {
    repo: { owner: "acme", repo: "example" },
    discoveredVia: "fixture",
    requiredChecks: [],
    surfaces: [
      { name: "mystery-thing", sha: SHA_A, conclusion: "success", kind: "status", detailsUrl: "https://x.test/9" },
    ],
    attestations: [],
  };
  const map = scanner.buildEvidenceMap([scan]);
  const policy = scanner.emitStarterPolicy(map);
  assert.deepEqual(policy.evidence_weights, {}, "unknown-only scan authors nothing");
});
