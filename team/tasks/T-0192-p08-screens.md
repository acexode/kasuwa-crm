# T-0192 — P08 inbox screens + P02 Channels/Compliance settings

| Field | Value |
|---|---|
| **id** | T-0192 |
| **status** | `assigned` |
| **module** | M08 |
| **owner** | Phase 3 W4 A1 |
| **priority** | P0 |
| **dependencies** | T-0185–T-0191 backends |
| **decisions** | D-L205; P08 received |
| **budget** | 4 sessions |

## Goal

Inbox UI from `docs/design/P08/`; Channels/Compliance settings pages (empty
states where frames thin). Flag `channel_settings` as needed. Byte budgets.

## Acceptance tests

- `tests/acceptance/inbox-ui/p08.acceptance.test.ts`
