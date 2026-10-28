# T-0173 — VAT and multi-tax

| Field | Value |
|---|---|
| **id** | T-0173 |
| **status** | `assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A2 |
| **priority** | P1 |
| **dependencies** | T-0172 |
| **decisions** | D-A3; D-L212 |
| **budget** | 3 sessions |

## Goal

VAT 7.5% and multi-tax on quotes and invoices. Mig **0064** `tax_line`.
Flag `vat_multitax`.

## Acceptance tests

- `tests/acceptance/commerce/vat-multitax.acceptance.test.ts`
