# T-0177 — M-Pesa and MoMo (provisional)

| Field | Value |
|---|---|
| **id** | T-0177 |
| **status** | `not-assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A6 |
| **priority** | P1 |
| **dependencies** | T-0168 |
| **decisions** | D-L212 B3 provisional; D-A3 |
| **budget** | 3 sessions |

## Goal

M-Pesa and MTN MoMo through `payments-adapter` (fake/sandbox kinds; production
fail-closed). Mig **0068** `mobile_payment`. Flag `mobile_money`.

## Acceptance tests

- `tests/acceptance/commerce/mobile-money.acceptance.test.ts`
