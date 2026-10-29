# T-0183 — Portal tenancy-adversarial suite

| Field | Value |
|---|---|
| **id** | T-0183 |
| **status** | `not-assigned` |
| **module** | M18 |
| **owner** | Phase 3 W2 A5 |
| **priority** | P0 |
| **dependencies** | T-0179–T-0181 |
| **decisions** | D-L212 |
| **budget** | 3 sessions |

## Goal

Portal user tries every record route, other programmes/tenants, and reverse.
Extend TENANT_SCOPED_TABLES checks.

## Acceptance tests

- `tests/acceptance/portal/portal-isolation.acceptance.test.ts`
