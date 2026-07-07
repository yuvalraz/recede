# Evidence weight: trust moves on declared evidence, not just pass/fail

Two lanes do the same work. Both run 18 clean fixes. Both seal SUCCESS every
cycle. Both carry an identical green VERIFY(ci) check. They end at different
trust. The strong-evidence lane reaches autonomy at cycle 11 and ends at score
0.8868. The weak-evidence lane reaches autonomy at cycle 13 and ends at 0.7074.
The only input that differs is the declared weight on each lane's VALIDATE
evidence.

`demo.ts` asserts that divergence, not just prints it, and asserts a control:
two lanes with the same outcomes and the same declared weight converge to a
byte-identical trajectory (score 0.816876086 on both). The control is what makes
the claim non-vacuous. Divergence and control run through the same `runLane()`
with only the weight differing, so an always-diverge bug fails the control and
an always-converge bug fails the divergence. Both sides have to hold.

These numbers are the demo's deterministic output under a fixed clock and
`idle_ms=0`. They are an illustration of a declared policy, not a prediction
that one check catches more real bugs than another. See "Not a prediction" below.

## The two-axis model

Evidence weight is two things multiplied, not one.

1. **Signal power.** What failure mode does a green result rule out? A unit test
   rules out a narrow logic regression. An isolated end-to-end run rules out
   integration and wiring failures the unit test never touches. A green result
   is only as strong as the class of failure it would have caught.

2. **Manipulability.** Who ran it, and could they fake it? Self-authored tests
   run by the same actor that wrote the change are cheap to game: write the
   assertion to match the output. An independently attested run on a
   provenance-carrying runner is not. This is an SLSA-style provenance ladder:
   L1 (a green log, no attestation), L2 (an authenticated build service),
   L3 (a hardened, isolated, non-falsifiable build).

Weight is signal power scaled by (1 minus manipulability). A powerful signal
that the author can trivially fake is worth little. A modest signal that no one
could have forged is worth more than its raw coverage suggests.

## Does a unit test build more trust than an E2E suite?

Neither dominates the other. They rule out different failure modes, so ranking
them on a single axis is the wrong question. A unit test suite with high signal
power on logic and an E2E suite with high signal power on integration are not
comparable as "more" or "less"; they are comparable only against the failure
class an adopter cares about.

So the weight is not a fact about the check. It is the adopter's declared,
auditable, replayable policy: "in my org, an isolated E2E run attested at L3 is
worth this much; a self-authored unit test at L1 is worth that much." The policy
is written down, versioned, and pinned into every gate decision by the policy
digest (I6). Anyone can replay the ledger and get the same trust.

### Not a prediction

The weight is a policy value, not a forecast. Recede does not claim a
higher-weight check empirically catches more bugs. The M0 (next.js) and M1
(langchain) backtests found that the trust math extracted nothing beyond trivial
per-lane features on either repo. That is why there is no prediction claim here:
the backtests earned the discipline. Trust is a governance and audit gate driven
by declared policy. Predictive trust is labeled research, not a shipped promise.

## The honest Phase-0 mechanism

This demo runs on today's kernel with no protocol change.

`check.verify` hardcodes confidence 1.0 (`reference/ts/src/check.ts`), so a
VERIFY check cannot carry differential weight yet. `check.validate` takes a
caller-supplied confidence. That confidence flows into `foldSignal`'s
confidence-weighted positive step (`reference/ts/src/weighting.ts`):

```
step = positive_gain * raw * meanConfidence * (1 - score)
```

`meanConfidence` is the mean over a warrant's checks. With one VERIFY at 1.0 and
one VALIDATE at weight `w`, the mean is `(1 + w) / 2`. A higher `w` means a
larger positive step per clean SUCCESS, so the score climbs faster and crosses
the `(reversible.low x tier)` autonomy boundary at T2 sooner. Both lanes accrue
the same sample count, so the confidence-tier cap (I5) is identical between them;
the divergence is entirely in the score channel.

So Phase 0 encodes declared evidence weight as the VALIDATE check's confidence.
That is the whole mechanism. It is a faithful illustration of the principle on
the existing channel, and it is deliberately narrow.

A corollary falls straight out of the flat mean: any VALIDATE with confidence
below 1.0 pulls `meanConfidence` under 1.0, so a clean SUCCESS carrying a weak
VALIDATE beside the pinned VERIFY accrues trust SLOWER than the same SUCCESS
carrying the VERIFY alone (adding a weak VALIDATE next to a passing VERIFY is
worse than logging no VALIDATE at all). That is a declared-policy artifact of the
flat mean, not a prediction about which check catches more bugs, and it is
exactly why this VALIDATE-confidence encoding stays a narrow illustration that
must NOT back a real recorder until the Phase-1 pooled (noisy-OR) combiner
replaces the mean.

## What Phase 1 generalizes (roadmap, not built here)

Phase 1 is the real evidence layer. It is deferred and is NOT implemented or
wired in this demo. It adds:

- **Weightable VERIFY checks.** VERIFY stops being pinned at 1.0, so a green CI
  run and a green attested E2E run can carry different declared weight too.
- **Noisy-OR pooling.** The flat mean over checks is replaced by a pooled
  combiner, `1 - prod(1 - w_i)`, so independent pieces of evidence compound
  toward certainty instead of averaging each other down. Two weak checks that
  fail differently should not dilute one strong check.
- **`evidence_refs` binding.** Each check links hash-addressed artifacts (logs,
  attestations, coverage reports) so the weight is anchored to replayable
  evidence, not a bare number.
- **Provenance and anti-gaming gates.** Assertion-strength checks,
  author-independence checks, and an SLSA-style provenance floor, so a lane
  cannot inflate its weight by self-attesting cheap evidence.

Phase 1 changes `weighting.ts` and the record model. Phase 0 changes nothing in
the kernel. That ordering is deliberate: prove the principle on the existing
channel first, then generalize.

## How to run

Offline, keyless, deterministic. Node built-in type stripping (>= 22.6, tested
on 26). Zero dependencies.

```
node examples/evidence-weight/demo.ts
```

Exit 0 with all 10 assertions green is the pass. The run is byte-identical across
invocations (fixed clock, `idle_ms=0`). `lanes.ts` holds the single shared
`runLane()` code path; `demo.ts` is the assertion harness and its own test.
