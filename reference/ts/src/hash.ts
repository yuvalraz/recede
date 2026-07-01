// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Content-addressing primitives.
 *
 * A record's id is `hash(canonicalize(record))` with the volatile `id` and
 * `sig` fields omitted from the pre-image. `canonicalize` produces a stable,
 * deterministic byte string independent of key insertion order, so two
 * implementations that agree on field values agree on the id — the basis of
 * replay reproducibility (I2) and the hash chain.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic JSON canonicalization:
 *  - object keys sorted lexicographically at every depth
 *  - keys whose value is `null` or `undefined` dropped at every object depth
 *    (so an absent optional == a null == a missing key — SPEC §3)
 *  - arrays preserved in order (null array *elements* are kept as `null`)
 *  - primitives via JSON.stringify (numbers in shortest round-trip form)
 *
 * This is a subset-JSON canonical form, sufficient because every record field
 * is a string, number, boolean, null, array, or plain object. It intentionally
 * has no dependency on any external canonical-JSON library.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError("cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "undefined") {
    throw new TypeError("cannot canonicalize a bare undefined");
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Drop null/undefined-valued keys at every depth so an absent optional, a
    // null, and a missing key all canonicalize identically (SPEC §3).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && obj[k] !== null)
      .sort();
    const body = keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",");
    return "{" + body + "}";
  }
  throw new TypeError(`cannot canonicalize value of type ${t}`);
}

/** SHA-256 of a canonical byte string, hex-encoded, prefixed by algorithm. */
export function hashBytes(canonical: string): string {
  return "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Content id for a record. The `id` and `sig` fields are excluded from the
 * pre-image (id is derived; sig is reserved and out of band). Everything else
 * — kind, prev, actor, ts, and all payload fields — is bound into the hash, so
 * tampering with any field breaks the id and, via `prev`, the whole chain.
 */
export function contentId(record: Record<string, unknown>): string {
  const { id: _id, sig: _sig, ...preimage } = record;
  return hashBytes(canonicalize(preimage));
}

/** A short digest of arbitrary content, used for inputs/result digests. */
export function digest(value: unknown): string {
  return hashBytes(canonicalize(value ?? null));
}
