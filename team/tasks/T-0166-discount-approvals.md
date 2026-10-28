# T-0166 — In-app discount approvals

| Field | Value |
|---|---|
| **id** | T-0166 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 Agent A3 |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0; founding pack AC2 |
| **dependencies** | T-0165 (quotes); D-L211 (rep `quotes.write`) |
| **decisions** | Threshold per programme; approver role; outbox event. Send/PDF (T-0167) and payments out of scope. |
| **budget** | Max 3 sessions before escalating |

## Goal

A programme configures a discount threshold and approver role. When a draft
quote's effective discount (max of quote and line `discountBps`) is strictly
above the threshold, a writer with `quotes.write` may request approval; an
approver with `quotes.approve` decides; members may list. Money stays bigint
minor units; scope stays programme-resolved.

## Context

- Migration **0049 only**: `approval_rule`, `quote_approval`.
- OpenAPI ops: `requestApproval`, `decideApproval`, `listApprovals`.
- Domain: `packages/domain/core/src/commerce/`; API: `apps/api/src/commerce/`.
- Flag: `quote_approvals` (off by default; on in `pnpm demo`).
- Outbox: `quote.approval_requested` (ids only). Notification kinds closed until a later slice.

## Acceptance tests

- `tests/acceptance/commerce/discount-approval.acceptance.test.ts`

Suite header rulings (R1–R10) are the contract until the lead amends them.

## Non-goals

PDF/send (T-0167), payments (T-0168/T-0169), deal-page wiring (T-0170), P21
screens (T-0171), WhatsApp notification delivery.

## Definition of done

- [ ] Named acceptance tests pass, unmodified
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` for touched packages
- [ ] OpenAPI updated; `pnpm features` committed
- [ ] Migration reviewed; tables in `TENANT_SCOPED_TABLES` with RLS
- [ ] Completion report at `team/reports/T-0166.md`
