// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, contentId, digest } from "../src/index.ts";

test("canonicalize is key-order independent", () => {
  const a = canonicalize({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
  const b = canonicalize({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
  assert.equal(a, b);
});

test("canonicalize drops undefined-valued keys (absent == missing)", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("canonicalize drops null-valued keys at every depth (SPEC §3)", () => {
  // A null-valued key, an absent key, and undefined all canonicalize alike.
  assert.equal(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
  assert.equal(canonicalize({ a: 1, b: null }), canonicalize({ a: 1, b: undefined }));
  // Nested: the inner null key is dropped too.
  assert.equal(canonicalize({ nested: { z: true, y: null } }), '{"nested":{"z":true}}');
  // Null *array elements* are preserved (only object keys are dropped).
  assert.equal(canonicalize({ xs: [1, null, 2] }), '{"xs":[1,null,2]}');
});

test("contentId excludes id and sig from the pre-image", () => {
  const base = { kind: "INTENT", actor: "x", ts: "t", task_type: "y", proposed_action: "z" };
  const id1 = contentId({ ...base, id: "AAA", sig: null });
  const id2 = contentId({ ...base, id: "BBB", sig: "whatever" });
  assert.equal(id1, id2, "id/sig must not affect the content hash");
});

test("contentId is sensitive to every payload field (tamper-evidence)", () => {
  const base = { kind: "INTENT", actor: "x", ts: "t", task_type: "y", proposed_action: "z" };
  assert.notEqual(contentId(base), contentId({ ...base, proposed_action: "z!" }));
  assert.notEqual(contentId(base), contentId({ ...base, actor: "x2" }));
});

test("digest is stable and hashes distinct content differently", () => {
  assert.equal(digest({ a: 1 }), digest({ a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test("canonicalize rejects non-finite numbers", () => {
  assert.throws(() => canonicalize({ x: Infinity }));
  assert.throws(() => canonicalize({ x: NaN }));
});
