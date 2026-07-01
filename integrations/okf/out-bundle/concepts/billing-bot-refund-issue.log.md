---
type: recede/warrant-log
title: Warrant log · billing-bot · refund.issue
description: Chronological Warrant history (32 warrants) backing the billing-bot/refund.issue trust scope.
tags:
  - recede
  - warrant-log
  - "actor:billing-bot"
  - "task:refund.issue"
timestamp: "2026-06-01T09:03:57.000Z"
---

## 2026-06-01

**2026-06-01T09:03:57.000Z — REVERTED**

- intent: Refund order #1500 — awaiting fraud clearance (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: next-day-fraud-check
- warrant id: `sha256:d995f27d80d6e74e3e58748e03a27cd602038fc3e39af81d10e80f6b84f5fc63` · autonomous

**2026-06-01T09:03:15.000Z — SUCCESS**

- intent: Refund order #9001 — $2000, abuse-flagged customer (`irreversible.critical`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by risk-analyst
- ground truth: immediate-checks
- warrant id: `sha256:d2631a1338f1fdb0139d68da769e8d9607c1ad03e2f633aee83df098e5898d65` · human-touched

**2026-06-01T09:03:08.000Z — SUCCESS**

- intent: Refund order #1029 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:ac0017163973121bb3798bc06ef4f7575bc19cf3ac4764a224890335ecd3a348` · autonomous

**2026-06-01T09:03:02.000Z — SUCCESS**

- intent: Refund order #1028 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:234f38bccb4727e74b68dd6b865a39f3abd2ffadeca0d77905f6e08226819f7c` · autonomous

**2026-06-01T09:02:56.000Z — SUCCESS**

- intent: Refund order #1027 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:1911cc6c98a77b9ba1c80a8b5feedf534f2102e4bf0c4e1e5d2ffc43b9a11ffb` · autonomous

**2026-06-01T09:02:50.000Z — SUCCESS**

- intent: Refund order #1026 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:b0000caec1e9315b93de9e97e6702379a35a730469230e65312750d6fbc30772` · autonomous

**2026-06-01T09:02:44.000Z — SUCCESS**

- intent: Refund order #1025 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:8a82750e189f5b712f539a8b3afe9bc9888eaffdeb50ab37009e2fe35fda6b3c` · autonomous

**2026-06-01T09:02:38.000Z — SUCCESS**

- intent: Refund order #1024 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:ff7721611fac3359e9d75adb96fa4f973ae73f3fb45189794be82ad9e44d695f` · autonomous

**2026-06-01T09:02:32.000Z — SUCCESS**

- intent: Refund order #1023 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:2923ad1a0224b00a694f66aba2ab79151276d9f61a93956b7a511a23110a10c8` · autonomous

**2026-06-01T09:02:26.000Z — SUCCESS**

- intent: Refund order #1022 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:b2560aeaf108cfb4df5a7e38f6e928387bf596fe64bd58f2524c92fbdc7702f0` · autonomous

**2026-06-01T09:02:20.000Z — SUCCESS**

- intent: Refund order #1021 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:ff9363d922bfef23a1fbe23aa4d9b61f8b17619d889d44dabce8019b40f902fc` · autonomous

**2026-06-01T09:02:14.000Z — SUCCESS**

- intent: Refund order #1020 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:e6662126fb09c8affcc52dca8f40777e614558774c75d000b181672eb35ef761` · autonomous

**2026-06-01T09:02:08.000Z — SUCCESS**

- intent: Refund order #1019 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:2223a7fd02d7b3403798d0cf5d2e2d944400287247ab1bfb25a3b462a4f4051a` · autonomous

**2026-06-01T09:02:02.000Z — SUCCESS**

- intent: Refund order #1018 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:e6ee1fbee986fd293a144b4eb5f2707cbb4728bc1ac7d4a9053539a7377ac6ae` · autonomous

**2026-06-01T09:01:56.000Z — SUCCESS**

- intent: Refund order #1017 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:403f20eed50ebd4520da6aa18aa8e09b62651aa0a2a629f0f7de76030c5e8906` · autonomous

**2026-06-01T09:01:50.000Z — SUCCESS**

- intent: Refund order #1016 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:df5c4d7cc39dfe5abfc6c2f5dee46963aea2a4941eff068ae989b566448ac51e` · autonomous

**2026-06-01T09:01:44.000Z — SUCCESS**

- intent: Refund order #1015 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:ab397fef6e1465fd205a9affbd56fd2dcb998218c3aba193a2230c2ec4c3d367` · autonomous

**2026-06-01T09:01:38.000Z — SUCCESS**

- intent: Refund order #1014 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:ee02ed4cd50ecde94d1590b0da9999f2395b58b9e531672ff74b7d5fa2e7fae7` · autonomous

**2026-06-01T09:01:32.000Z — SUCCESS**

- intent: Refund order #1013 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:c33670985ee188e41da79f89e12d3cab1c2372d76a172ca4cc980767710ac74c` · autonomous

**2026-06-01T09:01:26.000Z — SUCCESS**

- intent: Refund order #1012 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:106889459ecc8e0bb274f8bccce4550d6edfc741d4acbd92261eaa4d5e5649f2` · autonomous

**2026-06-01T09:01:20.000Z — SUCCESS**

- intent: Refund order #1011 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:55e7e9945e7dc436c5049ee39bc35579dc586a0df21fa52c71d263751946c0ec` · autonomous

**2026-06-01T09:01:14.000Z — SUCCESS**

- intent: Refund order #1010 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- ground truth: immediate-checks
- warrant id: `sha256:f596e345ec72da5c8025af173b3083a524f9fefc9439a6bc5ab82cc4aad8b08d` · autonomous

**2026-06-01T09:01:08.000Z — SUCCESS**

- intent: Refund order #1009 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:d865e1f0619678003ea1f31b9d37a08dead59a4db51ed00dd354a1ee3505586c` · human-touched

**2026-06-01T09:01:01.000Z — SUCCESS**

- intent: Refund order #1008 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:9cc08dbea99b5ac31e3783bddacf35a842ecbd6ff7fb78c628103b13f528be21` · human-touched

**2026-06-01T09:00:54.000Z — SUCCESS**

- intent: Refund order #1007 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:1fc003e7944a0fb4ad0dc99c4fcb947856fec624d333e48837be22e44200ec10` · human-touched

**2026-06-01T09:00:47.000Z — SUCCESS**

- intent: Refund order #1006 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:19c1c551f986b4bd165517cff349c8590ff39092db77e85ab58be1409db71fbb` · human-touched

**2026-06-01T09:00:40.000Z — SUCCESS**

- intent: Refund order #1005 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:9b70c19cdd05e4f959a5869cdc688939280f0919b9e52839da4c3c5a4ad18f39` · human-touched

**2026-06-01T09:00:33.000Z — SUCCESS**

- intent: Refund order #1004 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:352d69f9807a57cc42abce591df80b847e9d684c058c98a54e247474aae5c69e` · human-touched

**2026-06-01T09:00:26.000Z — SUCCESS**

- intent: Refund order #1003 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:82e91fe4721d2dab203f165b68033011eda56d46768e6f882d06293d19a98b33` · human-touched

**2026-06-01T09:00:19.000Z — SUCCESS**

- intent: Refund order #1002 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:aa6ea128ec725036e7f7829fa8b3a4dbccc802f59eae5704d5c9785146221f7e` · human-touched

**2026-06-01T09:00:12.000Z — SUCCESS**

- intent: Refund order #1001 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:0e1a95f66a590abd31aad4b20ed1d21dbb760348c8209f8f70de6d5956fbaaf0` · human-touched

**2026-06-01T09:00:05.000Z — SUCCESS**

- intent: Refund order #1000 — duplicate charge (`reversible.low`)
- checks: VERIFY amount<=orderTotal=PASS, VALIDATE policy-clean=PASS
- checkpoint APPROVE by auto
- ground truth: immediate-checks
- warrant id: `sha256:3fb794f21c6eae6079700389e7710905be845e0ec4c70116b9cd0391d0a4a1df` · human-touched
