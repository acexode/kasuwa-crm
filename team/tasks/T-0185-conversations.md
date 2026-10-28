# T-0185 — Conversation / message / participant tables

| Field | Value |
|---|---|
| **id** | T-0185 |
| **status** | `not-assigned` |
| **module** | M08 |
| **owner** | Phase 3 W1 A3 |
| **priority** | P0 |
| **dependencies** | S0 T-0160 for later realtime |
| **decisions** | D-L205 |
| **budget** | 3 sessions |

## Goal

Programme-scoped conversation model. Mig **0055**. Contract `inbox.openapi.yaml`.
Flag `crm_inbox`.

## Acceptance tests

- `tests/acceptance/inbox/conversations.acceptance.test.ts`
