---
name: recede-wire
description: Validate the ratified proposed-policy.json, then emit the three wiring artifacts (recede.policy.ts, checks/*.ts, .github/workflows/recede-record.yml) with the tested wire emitters. Fourth step of the sequence. The adopter opens the PR; nothing is ever posted for them.
---

# /recede-wire

Turn the ratified policy and the evidence map into a wiring PR. The emitters are tested tooling (`integrations/scanner/wire.ts`); your job is to validate the input, run them, and present the three artifacts for the adopter to review and submit. You never open the PR.

## Inputs

- `proposed-policy.json` from `/recede-blueprint`, possibly hand-edited by the adopter. Treat it as untrusted until validated.
- `evidence-map.json` from `/recede-scan` (schema `recede-evidence-map/1`).
- `RECEDE`: the path to the recede checkout the CLIs run from.

Run every command below from the adopter's repo root, with `RECEDE` set.

## Step 1: validate proposed-policy.json before anything is emitted

The weights were authored by a person or a model. Route them through `referencePolicyV02` first; a malformed or out-of-range weight must fail loud here, never reach an emitter.

```bash
RECEDE=<path to recede checkout> node --input-type=module -e '
import { readFileSync } from "node:fs";
const { referencePolicyV02, policyDigest } = await import(process.env.RECEDE + "/reference/ts/src/index.ts");
const proposed = JSON.parse(readFileSync("proposed-policy.json", "utf8"));
const policy = referencePolicyV02(proposed.evidence_weights ?? {});
console.log("proposed-policy.json is valid; policy digest " + policyDigest(policy));
'
```

On the fixture starter policy this prints the digest and exits 0. On a bad weight it throws and exits 1, for example:

```
Error: evidence weight out of range [0,1]: unit.L1 = 1.5
```

Stop on any validation error. Report the exact message, have the adopter fix the JSON, re-validate. Do not "fix" a weight yourself; every number in the policy is theirs.

## Step 2: run the emitters

```bash
RECEDE=<path to recede checkout> node --input-type=module -e '
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const { referencePolicyV02 } = await import(process.env.RECEDE + "/reference/ts/src/index.ts");
const { emitPolicyTs, emitCheckAdapters, emitRecordWorkflow } =
  await import(process.env.RECEDE + "/integrations/scanner/wire.ts");

const proposed = JSON.parse(readFileSync("proposed-policy.json", "utf8"));
const policy = referencePolicyV02(proposed.evidence_weights ?? {});

const map = JSON.parse(readFileSync("evidence-map.json", "utf8"));

// The emitted modules import recede from the adopter's checkout so they
// resolve as emitted. Without importFrom they import the package name
// "recede", which only resolves once a published package exists.
const importFrom = process.env.RECEDE + "/reference/ts/src/index.ts";

writeFileSync("recede.policy.ts", emitPolicyTs(policy, { importFrom }));
mkdirSync("checks", { recursive: true });
for (const f of emitCheckAdapters(map.sources, { importFrom })) writeFileSync(f.path, f.source);
mkdirSync(".github/workflows", { recursive: true });
writeFileSync(
  ".github/workflows/recede-record.yml",
  emitRecordWorkflow({ ledgerBranch: "recede-ledger", scoutRef: "main" }),
);
console.log("emitted recede.policy.ts, checks/, .github/workflows/recede-record.yml");
'
```

Ask the adopter for the two workflow parameters before running: `ledgerBranch` (the branch the ledger lives on, default `recede-ledger`) and `scoutRef` (the recede ref the workflow checks out; a tag or commit SHA is the right answer, `main` only for a first look).

Notes on what the emitters guarantee, so you can say it plainly:

- `recede.policy.ts` is a `referencePolicyV02(<weights>)` call, so importing it re-validates every weight. It refuses to emit a policy that does not round-trip the reference constructor.
- `checks/<class>.ts` adapters carry evClass, provTier, and locator verbatim from the evidence map into hash-covered evidence refs. The verdict is a factory argument from the adopter's CI signal; no adapter ever hard-codes a PASS. Sources classified `unknown` are skipped.
- `recede-record.yml` invokes the shipped `recede-cc10x record` and `recede-scout backfill` CLIs, SHA-pinned actions, least-privilege permissions, pushes only to the ledger branch (with a bounded rebase-retry when two merges race). It is record-only by default (`--mode record-only`). Nothing in the record is fabricated: the verifier verdict is derived from the real checks at the merge SHA (a PR merged over red CI records `fail`; if the query fails the step fails and nothing is recorded), and the task lane comes from the same `infer-task` inference the backfill used. There is no Marketplace Action here and none is needed.
- The workflow needs the ledger branch to exist: create it once before the first run (an orphan branch with an empty commit is enough).
- Fork-PR merges cannot push the ledger with the default `GITHUB_TOKEN`; those merges go unrecorded. A known limitation, not a fix this skill performs.

## Step 3: present the three artifacts

Show the adopter, in this order:

1. `recede.policy.ts`, with the reminder that every weight in it is their declared policy, editable in the PR.
2. The `checks/` adapters, one per wired evidence class, and where each plugs into their recorder call.
3. `.github/workflows/recede-record.yml`, with the staged path: it starts record-only; flipping to `advisory` is a one-word edit to `--mode` in the workflow. The gated stage comes later as a pre-action `recede-cc10x gate` consult, with exit codes usable as a required status check; it ships when the adopter reaches that stage and is not a recorder mode. `never_recede` lanes keep a human checkpoint in every mode. Caption the human decision honestly: the workflow records merge approval as `merged-by:<login>`, which is the checkpoint floor, not an independent review; a self-merge is visible in the ledger as actor equal to merged-by.

## Step 4: the adopter opens the PR

Binding rule: **the adopter opens the PR. Never open, post, or push it for them, even if asked to "just submit it".** Opening a PR is a public release action (`release.publish`, a `never_recede` lane); the human checkpoint here is the point of the whole system. Hand them the branch-ready files and stop.

## Rules (binding)

- Validation before emit, always. A proposed policy that fails `referencePolicyV02` stops the skill.
- No invented numbers. If a weight is missing, the class is not wired; say so rather than filling in a value.
- Weights are declared policy, edit-me, not a prediction. Repeat that framing when presenting `recede.policy.ts`.
- Pin `scoutRef` to a tag or SHA in anything the adopter will merge.
- The ledger and its `.policy.json` sidecar are state, not source. They live on the ledger branch or in a state directory, never in the main tree.
- The adopter opens the PR. No exceptions.
