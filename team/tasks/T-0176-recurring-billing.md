# T-0176 — Recurring billing

| Field | Value |
|---|---|
| **id** | T-0176 |
| **status** | `not-assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A5 |
| **priority** | P1 |
| **dependencies** | T-0172 |
| **decisions** | D-L212 |
| **budget** | 3 sessions |

## Goal

Billing schedules from invoices/quotes. Mig **0067** `billing_schedule`.
Flag `recurring_billing`.

## Acceptance tests

- `tests/acceptance/commerce/recurring-billing.acceptance.test.ts`
