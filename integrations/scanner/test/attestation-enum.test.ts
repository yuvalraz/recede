// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * P3.3 item 2 — attestation ENUMERATION. GitHub attestations attach to build
 * ARTIFACT digests; once auto-discovery enumerates run artifacts, each artifact's
 * `digest` (sha256, where the API provides it) drives the EXISTING
 * `listAttestations(repo, subjectDigest)` — so `collectScan` stops returning
 * `attestations: []` when digests are available, and the frozen
 * `pendingFromAttestation` path labels the entry `signed-provenance`/L3.
 * Degrade honestly: a digest-less artifacts response (older gh/API) keeps
 * `attestations: []` — a digest is NEVER fabricated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as scanner from "../scanner.ts";

const SNAP = "c".repeat(40);
const REPO = { owner: "acme", repo: "example" } as const;
const DIGEST = "sha256:" + "d".repeat(64);

function fixturesWith(runArtifacts: scanner.RepoFixture["runArtifacts"]): scanner.FixtureSet {
  return {
    "acme/example": {
      pullRequests: [
        { number: 7, merged: true, mergeCommitSha: SNAP, headSha: "a".repeat(40), author: "octo-dev", mergedAt: "2026-01-15T10:00:00Z" },
      ],
      reviews: {},
      workflowRuns: [
        { id: 4242, name: "unit-tests", path: ".github/workflows/ci.yml", headSha: SNAP, conclusion: "success", event: "push" },
      ],
      checkRuns: {
        [SNAP]: [
          { name: "unit-tests", headSha: SNAP, conclusion: "success", status: "completed", detailsUrl: null, app: "github-actions" },
        ],
      },
      combinedStatus: {},
      branchProtection: {},
      deployments: [],
      attestations: {
        [DIGEST]: [
          { subjectDigest: DIGEST, predicateType: "https://slsa.dev/provenance/v1", bundleUrl: "https://x.test/att/1" },
        ],
      },
      files: {},
      securityAlerts: [],
      artifacts: {
        "4242:test-results": {
          name: "test-results",
          files: { "junit.xml": '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>' },
        },
      },
      runArtifacts,
    },
  };
}

test("attestation enumeration: a digest-bearing artifact drives listAttestations → L3 entry", async () => {
  const source = new scanner.FixtureEvidenceSource(
    fixturesWith({ 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: false, digest: DIGEST }] }),
  );
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.equal(scan.attestations.length, 1, "the artifact digest enumerated an attestation");
  assert.equal(scan.attestations[0].subjectDigest, DIGEST);
  const map = scanner.buildEvidenceMap([scan]);
  const att = map.sources.find((s) => s.evClass === "attestation");
  assert.ok(att, "attestation entry present in the map");
  assert.equal(att.strength, "signed-provenance");
  assert.equal(att.provTier, "L3");
  assert.equal(map.counts.byStrength["signed-provenance"], 1);
});

test("attestation enumeration: a digest-less artifacts response degrades honestly → attestations []", async () => {
  const source = new scanner.FixtureEvidenceSource(
    fixturesWith({ 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: false }] }),
  );
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.deepEqual(scan.attestations, [], "no digest → no attestation calls, never a fabricated digest");
  const map = scanner.buildEvidenceMap([scan]);
  assert.equal(map.counts.byStrength["signed-provenance"], 0);
});

test("attestation enumeration: an EXPIRED artifact's digest is not consulted", async () => {
  const source = new scanner.FixtureEvidenceSource(
    fixturesWith({ 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: true, digest: DIGEST }] }),
  );
  const scan = await scanner.collectScan(source, REPO, { prState: "merged" });
  assert.deepEqual(scan.attestations, []);
});

test("attestation classification: an empty predicateType (REAL API shape) still classifies attestation/VERIFY/L3", async () => {
  // Real /attestations items carry no top-level predicate_type and often no inline
  // bundle — predicateType parses to "". The entry IS an attestation by construction,
  // so it must not degrade to unknown/gate-only.
  const fx = fixturesWith({ 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: false, digest: DIGEST }] });
  fx["acme/example"].attestations[DIGEST] = [
    { subjectDigest: DIGEST, predicateType: "", bundleUrl: "https://api.github.com/att/dl/1" },
  ];
  const scan = await scanner.collectScan(new scanner.FixtureEvidenceSource(fx), REPO, { prState: "merged" });
  const map = scanner.buildEvidenceMap([scan]);
  const att = map.sources.find((s) => s.strength === "signed-provenance");
  assert.ok(att, "the attestation entry is present");
  assert.equal(att.evClass, "attestation", "empty predicateType falls back to evClass attestation");
  assert.equal(att.checkKind, "VERIFY");
  assert.equal(att.provTier, "L3");
});

test("attestation enumeration: explicit --artifact path stays attestation-free (no auto)", async () => {
  const source = new scanner.FixtureEvidenceSource(
    fixturesWith({ 4242: [{ id: 1, name: "test-results", sizeBytes: 2048, expired: false, digest: DIGEST }] }),
  );
  const scan = await scanner.collectScan(source, REPO, {
    prState: "merged",
    artifacts: [{ runId: 4242, name: "test-results", kind: "junit", linkSurfaceName: "unit-tests", linkSha: SNAP }],
  });
  assert.deepEqual(scan.attestations, [], "explicit requests carry no digest; enumeration only runs on auto");
});
