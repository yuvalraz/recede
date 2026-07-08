// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.1 — strengthOf (the provenance-strength ladder) + tierOf (label → L1/L2/L3).
 * Required-ness is JOINED from branch protection's required list and passed in as
 * `isRequired`; it is NEVER guessed from the source name.
 *
 * Namespace import so the not-yet-defined functions are `undefined` during RED and
 * calling them throws behaviorally ("is not a function") — a real RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import { fixtureSet, REPO, SHA_A } from "./fixtures/fake-github.ts";

test("strengthOf: signed source → signed-provenance (isSigned wins over everything)", () => {
  assert.equal(
    scanner.strengthOf({ discoveredAs: "attestation", isRequired: false, isSigned: true }),
    "signed-provenance",
  );
  // isSigned wins even if the source is also required.
  assert.equal(
    scanner.strengthOf({ discoveredAs: "check-run", isRequired: true, isSigned: true }),
    "signed-provenance",
  );
});

test("strengthOf: required (unsigned) check → required-status-check", () => {
  assert.equal(
    scanner.strengthOf({ discoveredAs: "check-run", isRequired: true, isSigned: false }),
    "required-status-check",
  );
  // A required legacy status is also L2-strength.
  assert.equal(
    scanner.strengthOf({ discoveredAs: "status", isRequired: true, isSigned: false }),
    "required-status-check",
  );
});

test("strengthOf: unrequired check-run → optional-check", () => {
  assert.equal(
    scanner.strengthOf({ discoveredAs: "check-run", isRequired: false, isSigned: false }),
    "optional-check",
  );
});

test("strengthOf: a bare (unrequired) status context → self-reported", () => {
  assert.equal(
    scanner.strengthOf({ discoveredAs: "status", isRequired: false, isSigned: false }),
    "self-reported",
  );
});

test("strengthOf: unrequired review/deployment/codeowners → optional-check", () => {
  for (const discoveredAs of ["review", "deployment", "codeowners"] as const) {
    assert.equal(
      scanner.strengthOf({ discoveredAs, isRequired: false, isSigned: false }),
      "optional-check",
      discoveredAs,
    );
  }
});

test("tierOf: ladder → provenance tier", () => {
  assert.equal(scanner.tierOf("signed-provenance"), "L3");
  assert.equal(scanner.tierOf("required-status-check"), "L2");
  assert.equal(scanner.tierOf("optional-check"), "L1");
  assert.equal(scanner.tierOf("self-reported"), "L1");
});

test("strengthOf: required-ness is JOINED from branch protection, not guessed from the name", async () => {
  const src = new scanner.FixtureEvidenceSource(fixtureSet);
  const bp = await src.getBranchProtection(REPO, "main");
  assert.ok(bp);
  const checkRuns = await src.listCheckRunsForRef(REPO, SHA_A);

  // The name alone tells us nothing; the required list is the source of truth.
  // `unit-tests` and `build` ARE in requiredStatusChecks; `lint` is NOT.
  const byName = (n: string) => {
    const cr = checkRuns.find((c) => c.name === n);
    assert.ok(cr, n);
    const isRequired = bp.requiredStatusChecks.includes(cr.name); // non-mutating join
    return scanner.strengthOf({ discoveredAs: "check-run", isRequired, isSigned: false });
  };

  assert.equal(byName("unit-tests"), "required-status-check"); // in required list → L2
  assert.equal(byName("build"), "required-status-check"); // in required list → L2
  assert.equal(byName("lint"), "optional-check"); // NOT in required list → L1

  // Guard: the join did not mutate the fixture's required list.
  assert.deepEqual(bp.requiredStatusChecks, ["unit-tests", "build"]);
});

test("strengthOf: truthy NON-boolean isSigned/isRequired does NOT promote (=== true boundary)", () => {
  // Anti-gaming: a future caller that derives isSigned/isRequired incorrectly and
  // yields a truthy non-boolean (string "false", 1, {}) must NOT inflate a source
  // to L2/L3. Only a strict `=== true` promotes. Cast simulates a bad caller.
  for (const bad of ["false", 1, {}] as unknown[]) {
    assert.equal(
      scanner.strengthOf({
        discoveredAs: "check-run",
        isRequired: false,
        isSigned: bad as unknown as boolean,
      }),
      "optional-check",
      `isSigned=${String(bad)} must not promote to signed-provenance`,
    );
    assert.equal(
      scanner.strengthOf({
        discoveredAs: "check-run",
        isRequired: bad as unknown as boolean,
        isSigned: false,
      }),
      "optional-check",
      `isRequired=${String(bad)} must not promote to required-status-check`,
    );
    // A bare status with a truthy-non-bool isRequired still stays self-reported (L1).
    assert.equal(
      scanner.strengthOf({
        discoveredAs: "status",
        isRequired: bad as unknown as boolean,
        isSigned: false,
      }),
      "self-reported",
      `isRequired=${String(bad)} must not promote a status to required-status-check`,
    );
  }
});

test("strengthOf: no branch protection (null) → nothing is required → optional-check", () => {
  // Fresh adopter with no protection: isRequired is false for every check → L1.
  const label = scanner.strengthOf({ discoveredAs: "check-run", isRequired: false, isSigned: false });
  assert.equal(label, "optional-check");
  assert.equal(scanner.tierOf(label), "L1");
});
