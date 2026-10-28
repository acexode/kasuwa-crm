# T-0171 — P21 commerce screens

| Field | Value |
|---|---|
| **id** | T-0171 |
| **status** | `assigned` |
| **module** | M05 |
| **owner** | Phase 3 W1 A2 |
| **priority** | P0 |
| **PRD refs** | P21; PLAN T-0171 |
| **dependencies** | T-0164–T-0169 APIs (payment status may stub until T-0169 merges) |
| **decisions** | D-L205 design gate; P21 received |
| **budget** | 4 sessions |

## Goal

Build catalogue, quote builder, approvals, and payment status screens from
`docs/design/P21/`, behind existing commerce flags. Byte-budget tags; i18n keys.

## Acceptance tests

- `tests/acceptance/commerce-ui/p21.acceptance.test.ts`
