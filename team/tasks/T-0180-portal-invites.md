# T-0180 — Portal invitations hardened

| Field | Value |
|---|---|
| **id** | T-0180 |
| **status** | `not-assigned` |
| **module** | M18 |
| **owner** | Phase 3 W2 A2 |
| **priority** | P0 |
| **dependencies** | T-0179 |
| **decisions** | D-L212; D-P26 / D-L115 |
| **budget** | 3 sessions |

## Goal

Authorisation, audit, token in fragment/POST, outbox send, rate limit, paginated
list. Mig **0053** `portal_invite` (absorb `portal_user`).

## Acceptance tests

- `tests/acceptance/portal/portal-invites.acceptance.test.ts`
