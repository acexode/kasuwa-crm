# T-0170 — Wire deal page commerce placeholders

| Field | Value |
|---|---|
| **id** | T-0170 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 Agent A6 |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0 |
| **dependencies** | T-0164 (catalogue), T-0165 (quotes); Phase 2 deal detail (T-0110 / T-0135 placeholders) |
| **decisions** | B5 blocks FX; `fx_display` stays flagged empty/disabled. No new migration. |
| **budget** | Max 3 sessions before escalating |

## Goal

Make `deal_products` and `deal_quotes` on the P06 deal detail real: the deal UI
reads programme catalogue products (with list prices) and quotes for that deal
via the existing commerce API. Lazy-load commerce so flag-off first paint does
not grow shared chunks. `fx_display` stays a flagged empty/disabled state until
B5 — do not invent FX.

## Acceptance tests

Lead-authorised:

- `tests/acceptance/records-ui/deal-commerce.acceptance.test.ts`

## Non-goals

- Migrations
- Payment links / P21 full screens (T-0171)
- Discount approvals UI (T-0166)
- FX rate-lock / US$ figures (B5)

## Definition of done

- [ ] Named acceptance tests pass
- [ ] Unit tests for commerce client helpers
- [ ] Lazy-loaded deal commerce panels; flags wired
- [ ] i18n keys for new strings
- [ ] Completion report at `team/reports/T-0170.md`
- [ ] Branch pushed (no PR/main)
