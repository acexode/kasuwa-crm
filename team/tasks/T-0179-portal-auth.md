# T-0179 — Portal identity, session, MFA

| Field | Value |
|---|---|
| **id** | T-0179 |
| **status** | `assigned` |
| **module** | M18 |
| **owner** | Phase 3 W2 A1 |
| **priority** | P0 |
| **dependencies** | T-0178 / ADR-0021 Accepted (D-L212) |
| **decisions** | D-L212; D-A3 |
| **budget** | 4 sessions |

## Goal

`portal_identity`, `portal_session`, `portal_programme` (mig **0052**). Sign-in
with MFA; scope from DB. Cookie `__Host-kasuwa_portal_session`. No third
SECURITY DEFINER. Contract `portal.openapi.yaml`.

## Acceptance tests

- `tests/acceptance/portal/portal-auth.acceptance.test.ts`
