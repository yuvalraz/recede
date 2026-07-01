// Copyright 2026 Yuval Raz
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * OKF exporter demo.
 *
 * Builds a small refund-style Recede ledger — the same shape as the canonical
 * killer example: a billing bot issues refunds, earns trust through verified +
 * validated clean runs, then a high-risk irreversible action still gates. We
 * run several scopes so the exported bundle has more than one concept doc.
 *
 * Then we export the ledger to ./out-bundle/ as a conformant OKF bundle and
 * print (1) the file tree, (2) one full concept file, and (3) a conformance
 * check that every non-index doc carries a non-empty `type` frontmatter field.
 *
 * Run: node integrations/okf/demo.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { Recede, MemoryLedger, check, autoApprove, fixedCheckpoint } from "../../reference/ts/src/index.ts";
import { exportLedgerToDir } from "./okf-export.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(HERE, "out-bundle");

// A deterministic clock so the demo output (and record ids) are stable.
function fixedClock(startIso: string): () => string {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000; // advance 1s per stamp
    return iso;
  };
}

async function buildLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  const clock = fixedClock("2026-06-01T09:00:00.000Z");

  // The billing bot on small refunds — auto-approve the early checkpoints so it
  // graduates from gated to autonomous over a run of clean, verified refunds.
  const r = new Recede({
    ledger,
    checkpoint: autoApprove(),
    now: clock,
  });

  const amountOK = check.verify<{ orderTotal: number }, { amount: number }>(
    "amount<=orderTotal",
    (io) => io.output.amount <= io.input.orderTotal,
  );
  const policyOK = check.validate<{ orderTotal: number }, { amount: number }>(
    "policy-clean",
    () => ({ ok: true, confidence: 0.9 }),
  );

  // ~30 clean small refunds accrue trust for (billing-bot, refund.issue).
  for (let i = 0; i < 30; i++) {
    await r.run(() => ({ amount: 20 }), {
      actor: "billing-bot",
      taskType: "refund.issue",
      intent: `Refund order #${1000 + i} — duplicate charge`,
      risk: "reversible.low",
      input: { orderTotal: 50 },
      checks: [amountOK, policyOK],
    });
  }

  // A high-stakes irreversible refund still gates (never_recede, I3). A human
  // reviews and approves it — evidence, but the checkpoint fired regardless.
  const rGated = new Recede({
    ledger,
    checkpoint: fixedCheckpoint("APPROVE", "risk-analyst"),
    now: clock,
  });
  await rGated.run(() => ({ amount: 2000 }), {
    actor: "billing-bot",
    taskType: "refund.issue",
    intent: "Refund order #9001 — $2000, abuse-flagged customer",
    risk: "irreversible.critical",
    input: { orderTotal: 2000 },
    checks: [amountOK, policyOK],
  });

  // A DIFFERENT scope: the same actor drafting emails — separate trust lane (I1).
  const draftOK = check.verify<unknown, { body: string }>(
    "non-empty-body",
    (io) => io.output.body.length > 0,
  );
  for (let i = 0; i < 6; i++) {
    await r.run(() => ({ body: "Thanks for reaching out — resolved." }), {
      actor: "billing-bot",
      taskType: "email.draft",
      intent: `Draft reply to ticket #${200 + i}`,
      risk: "read.only",
      input: {},
      checks: [draftOK],
    });
  }

  // A deferred refund that a next-day fraud check later REVERTS — negative
  // evidence that arrives late and snaps trust back down.
  const deferred = await r.run(() => ({ amount: 40 }), {
    actor: "billing-bot",
    taskType: "refund.issue",
    intent: "Refund order #1500 — awaiting fraud clearance",
    risk: "reversible.low",
    input: { orderTotal: 60 },
    checks: [amountOK, policyOK],
    deferUntil: "2026-06-02T09:00:00.000Z",
  });
  r.reseal(deferred.warrant.intent.id, "REVERTED", "next-day-fraud-check");

  return ledger;
}

function printTree(root: string): void {
  const rows: string[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir).sort();
    entries.forEach((name, i) => {
      const full = join(dir, name);
      const last = i === entries.length - 1;
      const branch = last ? "└── " : "├── ";
      rows.push(prefix + branch + name);
      if (statSync(full).isDirectory()) {
        walk(full, prefix + (last ? "    " : "│   "));
      }
    });
  };
  rows.push(relative(HERE, root) + "/");
  walk(root, "");
  console.log(rows.join("\n"));
}

/** Parse the `type` field out of a doc's frontmatter block, if present. */
function frontmatterType(contents: string): string | null {
  if (!contents.startsWith("---\n")) return null;
  const end = contents.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = contents.slice(4, end);
  for (const line of block.split("\n")) {
    const m = /^type:\s*(.+?)\s*$/.exec(line);
    if (m) {
      let v = m[1];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}

function listDocs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out;
}

async function main(): Promise<void> {
  const ledger = await buildLedger();
  exportLedgerToDir(ledger, OUT_DIR, {
    clean: true,
    title: "Billing Bot — Recede Trust Ledger",
    now: "2026-06-02T12:00:00.000Z",
  });

  console.log("=== OKF bundle tree ===\n");
  printTree(OUT_DIR);

  const samplePath = join(OUT_DIR, "concepts", "billing-bot-refund-issue.md");
  console.log("\n=== Sample concept file: concepts/billing-bot-refund-issue.md ===\n");
  console.log(readFileSync(samplePath, "utf8"));

  console.log("=== Conformance: every non-index doc has a non-empty `type` ===\n");
  const docs = listDocs(OUT_DIR);
  let ok = true;
  for (const path of docs) {
    const rel = relative(OUT_DIR, path);
    const contents = readFileSync(path, "utf8");
    if (rel === "index.md") {
      // OKF: index.md permits no frontmatter. Confirm it has none.
      const hasFm = contents.startsWith("---\n");
      console.log(`  ${rel}: index (no frontmatter) — ${hasFm ? "UNEXPECTED frontmatter" : "OK"}`);
      if (hasFm) ok = false;
      continue;
    }
    const type = frontmatterType(contents);
    const valid = type != null && type.length > 0;
    console.log(`  ${rel}: type=${type ?? "(missing)"} — ${valid ? "OK" : "INVALID"}`);
    if (!valid) ok = false;
  }
  console.log(`\nBundle ${ok ? "CONFORMS" : "FAILS"}: ${docs.length} docs checked.`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
