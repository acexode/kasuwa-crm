# T-0164 — Product catalogue

| Field | Value |
|---|---|
| **id** | T-0164 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0; US-3 |
| **dependencies** | S0 (merged); Phase 2 records |
| **decisions** | B6: only NGN, GHS, KES, ZAR. B3 (refunds) does not block this task. |
| **budget** | Max 3 sessions before escalating |

## Goal

A programme can list, create and update products (with variants), list price books
per allowed currency, upsert a price-book entry in minor units, and list tax
profiles — all programme-scoped, behind `crm_products`, with money never a float.

## Context

- New OpenAPI: `docs/api/commerce.openapi.yaml`.
- Migration **0047**: `product`, `product_variant`, `price_book`, `price_book_entry`,
  `tax_profile`. All programme-scoped; RLS ENABLED and FORCED; in `TENANT_SCOPED_TABLES`.
- Domain: `packages/domain/core/src/commerce/`.
- API: `apps/api/src/commerce/`.
- Flag: `crm_products` (off by default; on in `pnpm demo` when that wiring lands).
- Prior art: contact / activity repositories and `0044_notification.sql` RLS shape.
- Zod 4; closed bodies (`z.strictObject`); currencies NGN/GHS/KES/ZAR only.

## Acceptance tests

Already committed and currently **failing**. Do not edit these files.

- `tests/acceptance/commerce/catalogue.acceptance.test.ts`

## Non-goals

Quotes (T-0165), approvals (T-0166), send (T-0167), payments adapter (T-0168),
payment links (T-0169), deal-page wiring (T-0170), P21 screens (T-0171), XOF/USD
(B6), refunds/partial payments (B3), invoices/MBS/FX (S5).

## Definition of done

- [ ] Named acceptance tests pass, unmodified
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` for touched packages
- [ ] OpenAPI updated (`docs/api/commerce.openapi.yaml`)
- [ ] i18n keys added if user-facing strings were added
- [ ] Migration reviewed; every new table in `TENANT_SCOPED_TABLES` with RLS
- [ ] Completion report at `team/reports/T-0164.md`
- [ ] Structural PR ok if the slice exceeds ~600 lines

## Escalate if

- An open decision blocks you — name it, stop, do not guess.
- An acceptance test looks wrong — say so, do not edit it.
- You exceed the budget above.
