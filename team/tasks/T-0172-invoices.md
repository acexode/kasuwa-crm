# T-0172 — Invoices from accepted quotes

| Field | Value |
|---|---|
| **id** | T-0172 |
| **status** | `not-assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A1 |
| **priority** | P1 |
| **dependencies** | S1 close (quotes) |
| **decisions** | D-L212; P21 invoice frames |
| **budget** | 3 sessions |

## Goal

Invoices from accepted quotes; numbering per programme. Mig **0063**
`invoice`, `invoice_line`. Flag `invoices`.

## Acceptance tests

- `tests/acceptance/commerce/invoices.acceptance.test.ts`
