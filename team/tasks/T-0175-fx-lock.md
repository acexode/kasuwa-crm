# T-0175 — FX rate-lock (provisional)

| Field | Value |
|---|---|
| **id** | T-0175 |
| **status** | `not-assigned` |
| **module** | M05 |
| **owner** | Phase 3 W5 A4 |
| **priority** | P1 |
| **dependencies** | S1 |
| **decisions** | D-L212 B5 provisional (admin rates + 24h TTL) |
| **budget** | 3 sessions |

## Goal

Admin-entered FX rates; lock TTL 24h provisional. Mig **0066** `fx_rate`,
`fx_lock`. Flag `fx_lock`. Light `fx_display` on deal page.

## Acceptance tests

- `tests/acceptance/commerce/fx-lock.acceptance.test.ts`
