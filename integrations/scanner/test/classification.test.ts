// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P2.1 — classifyClass: pure name → { evClass, checkKind } mapping. Deterministic,
 * substring/keyword based, case-insensitive. Unrecognized names → "unknown".
 *
 * Namespace import so the not-yet-defined `classifyClass` is `undefined` during
 * RED and calling it throws behaviorally ("is not a function") — a real RED, not
 * a module-collection error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";
import { fixtureSet, REPO } from "./fixtures/fake-github.ts";

test("classifyClass: unit-test runners → unit / VERIFY", () => {
  for (const name of ["vitest", "jest", "unit-tests", "mocha", "pytest", "junit"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "unit", checkKind: "VERIFY" }, name);
  }
});

test("classifyClass: e2e runners → e2e / VERIFY", () => {
  for (const name of ["playwright e2e", "cypress", "selenium", "end-to-end tests"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "e2e", checkKind: "VERIFY" }, name);
  }
});

test("classifyClass: integration → integration / VERIFY", () => {
  assert.deepEqual(scanner.classifyClass("integration-tests"), {
    evClass: "integration",
    checkKind: "VERIFY",
  });
});

test("classifyClass: typecheck → typecheck / VERIFY", () => {
  for (const name of ["tsc", "typecheck", "type-check", "mypy"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "typecheck", checkKind: "VERIFY" }, name);
  }
});

test("classifyClass: lint → lint / gate-only", () => {
  for (const name of ["eslint", "lint", "prettier", "ruff"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "lint", checkKind: "gate-only" }, name);
  }
});

test("classifyClass: sast → sast / VALIDATE", () => {
  for (const name of ["codeql", "semgrep", "sast-scan", "snyk"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "sast", checkKind: "VALIDATE" }, name);
  }
});

test("classifyClass: dast → dast / VALIDATE", () => {
  for (const name of ["dast-scan", "owasp-zap"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "dast", checkKind: "VALIDATE" }, name);
  }
});

test("classifyClass: coverage → coverage / VALIDATE", () => {
  for (const name of ["codecov", "coverage-report"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "coverage", checkKind: "VALIDATE" }, name);
  }
});

test("classifyClass: deploy → deploy / gate-only", () => {
  for (const name of ["deploy-prod", "release", "deploy-preview"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "deploy", checkKind: "gate-only" }, name);
  }
});

test("classifyClass: review → review / checkpoint", () => {
  assert.deepEqual(scanner.classifyClass("code-review"), {
    evClass: "review",
    checkKind: "checkpoint",
  });
});

test("classifyClass: bare preview → deploy / gate-only (deploy rule beats review substring)", () => {
  // "preview" contains the substring "review"; the deploy rule is ordered first so
  // bare preview checks classify as a deploy gate, not a review checkpoint.
  for (const name of ["preview", "pr-preview", "Vercel – Preview"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "deploy", checkKind: "gate-only" }, name);
  }
  // Genuine review checks still classify as review/checkpoint (the review rule works).
  for (const name of ["code-review", "pr-review"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "review", checkKind: "checkpoint" }, name);
  }
});

test("classifyClass: CODEOWNERS → codeowners / checkpoint (case-insensitive)", () => {
  assert.deepEqual(scanner.classifyClass("CODEOWNERS"), {
    evClass: "codeowners",
    checkKind: "checkpoint",
  });
  // The CODEOWNERS file path from the fixture also classifies.
  const path = fixtureSet[`${REPO.owner}/${REPO.repo}`].files.CODEOWNERS.path;
  assert.equal(scanner.classifyClass(path).evClass, "codeowners");
});

test("classifyClass: attestation → attestation / VERIFY", () => {
  for (const name of ["attestation", "slsa-provenance", "sigstore", "cosign"]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "attestation", checkKind: "VERIFY" }, name);
  }
});

test("classifyClass: unrecognized names → unknown / gate-only", () => {
  for (const name of ["build", "some-random-thing", "foobar", ""]) {
    assert.deepEqual(scanner.classifyClass(name), { evClass: "unknown", checkKind: "gate-only" }, name);
  }
});

test("classifyClass: is deterministic (same input → same output)", () => {
  assert.deepEqual(scanner.classifyClass("vitest"), scanner.classifyClass("vitest"));
});

test("classifyClass: does not mutate its string input (primitive, by-value)", () => {
  const name = "eslint";
  scanner.classifyClass(name);
  assert.equal(name, "eslint");
});
