# T-0186 — ChannelProvider v2 (idempotencyKey + capabilities)

| Field | Value |
|---|---|
| **id** | T-0186 |
| **status** | `assigned` |
| **module** | M08 |
| **owner** | Phase 3 W1 A4 |
| **priority** | P0 |
| **dependencies** | existing channel-adapter |
| **decisions** | D-L205; D-L37 |
| **budget** | 2 sessions |

## Goal

Extend `ChannelProvider`: `send` requires `idempotencyKey`; `parseWebhook`,
`templates`, `capabilities`. No migration.

## Acceptance tests

- `tests/acceptance/adapters/channel-contract-v2.acceptance.test.ts`
