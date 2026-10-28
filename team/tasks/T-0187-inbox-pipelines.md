# T-0187 — Inbox in/out pipelines + slug webhooks

| Field | Value |
|---|---|
| **id** | T-0187 |
| **status** | `assigned` |
| **module** | M08 |
| **owner** | Phase 3 W3 A1 |
| **priority** | P0 |
| **dependencies** | T-0185, T-0186 |
| **decisions** | D-L205 webhook slug |
| **budget** | 3 sessions |

## Goal

Outbox pipelines against fake provider; webhook `/webhooks/<provider>/<tenantSlug>`.
Mig **0056** `message_delivery`.

## Acceptance tests

- `tests/acceptance/inbox/pipelines.acceptance.test.ts`
