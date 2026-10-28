# T-0174 — NRS MBS e-invoicing (provisional Fake MBS)

| Field | Value |
|---|---|
| **id** | T-0174 |
| **status** | `assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A3 |
| **priority** | P1 |
| **dependencies** | T-0172 |
| **decisions** | D-L212 B4 provisional; D-A3 |
| **budget** | 3 sessions |

## Goal

IRN/QR; Draft → Submitted → Cleared or Failed; retry queue. Fake MBS adapter
(no real NRS credentials in CI). Mig **0065** `einvoice`. Flag `mbs_einvoicing`.

## Acceptance tests

- `tests/acceptance/commerce/mbs-einvoicing.acceptance.test.ts`
