# T-0189 — Consent and DND engine

| Field | Value |
|---|---|
| **id** | T-0189 |
| **status** | `not-assigned` |
| **module** | M08 |
| **owner** | Phase 3 W3 A3 |
| **priority** | P0 |
| **dependencies** | T-0187 |
| **decisions** | D-L61; NDPA-sensitive |
| **budget** | 3 sessions |

## Goal

Send-time register lookup (not `dnd` boolean); `purpose` audited per send.
Mig **0058** `consent_check`.

## Acceptance tests

- `tests/acceptance/inbox/consent-dnd.acceptance.test.ts`
