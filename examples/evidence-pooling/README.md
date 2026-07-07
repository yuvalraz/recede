# evidence-pooling

Flat-mean averaging-down, and the pooled fix, proven through the real kernel fold. Offline, keyless, deterministic.

## The claim

Take a strong VERIFY (independent, mutation-tested integration evidence). Add a weak VALIDATE (a low-confidence judge note). Both pass.

Under the v0.1 reference weighting, adding that corroborating check **lowers** trust. Confidence is the flat mean of the checks, so a 0.1 VALIDATE averages a 1.0 VERIFY down to 0.55, and the lower mean scales down every clean-SUCCESS step. That is the P0 pathology: more passing evidence, less trust.

Under the v0.2 reference weighting (`recede/ref-weighting-v0.2`), the same weak check can only add. Confidence becomes a class-deduped noisy-OR pool over declared per-check weights, `1 - Π(1 - w_i)`, which is at least the strongest single class weight and monotone in added PASS checks.

## The numbers (16 clean cycles, run through `Recede.run`)

| lane | v0.1 flat-mean | v0.2 pooled |
| --- | --- | --- |
| `[strongVERIFY]` | 0.870663 | 0.754344 |
| `[strongVERIFY, weakVALIDATE]` | 0.664610 | 0.755884 |
| effect of adding the weak check | **-0.206053 (drag)** | **+0.001540 (lift)** |

Same warrants, same `runLane()`, same fixed clock, `idle_ms=0`. The only variable is the policy. v0.1 drags trust down by 0.21 when a weak check joins a strong one. v0.2 lifts it.

The folded score and the pool are different quantities. The score is cycle-dependent (its fold asymptote is 1.0, not the pool weight). The structural invariant lives in the pool itself: `pooledConfidence` over the declared weights is 0.700 for `[strongVERIFY]` and 0.703 for `[strongVERIFY, weakVALIDATE]`. The pool never sits below its strongest single class (0.703 >= 0.7), and adding the weak class only adds to it (0.703 >= 0.700). Those hold at any cycle count, which is why `demo.ts` asserts them on `pooledConfidence` directly, not on the folded score.

## These are declared policy, not predictions

The weights (`integration@L3 = 0.7`, `llm-judge@L1 = 0.1`) are **declared, auditable policy inputs**, not a forecast that one check catches more bugs (red-team rules 1 and 4). The demo does not claim integration tests are objectively 7x a judge note. It claims: given a policy that declares those weights, v0.1 averages them into a pathology and v0.2 pools them into a fix. The magnitudes move with the declared table and the cycle count; the direction (drag vs lift) is the invariant.

## What makes it honest

- **Real fold.** Every score comes from `Recede.run` under the actual reference policy. No hand-picked arithmetic, no theater. The v0.1 drag is what the shipped v0.1 kernel produces.
- **Assertion-count guard.** `demo.ts` snapshots the assertion counter and compares it to an independent literal (8). A silently skipped assertion fails the demo.
- **Determinism control.** The same lane folded twice is byte-identical, so the divergence is caused by the weighting profile, not run-to-run noise.
- **Replay.** Each lane's stored trust equals its `replay()` (I2).

## Run it

```bash
node demo.ts
```

Zero dependencies. Node built-in type stripping (>= 22.6, tested on 26). `OUTPUT.txt` is the captured stdout and is byte-identical across runs.

## See also

- [`../evidence-weight/EVIDENCE.md`](../evidence-weight/EVIDENCE.md) is the antecedent design note: how declared evidence weight already rides the v0.1 fold, and why the flat mean is the seam the pooled profile replaces.
- `SPEC.md §9` marks the weighting as a reference, not normative. v0.2 is a reference profile an adopter selects by policy.
