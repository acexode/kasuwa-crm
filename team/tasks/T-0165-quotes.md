# T-0165 — Quotes

| Field | Value |
|---|---|
| **id** | T-0165 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0; US-3 |
| **dependencies** | T-0164 (catalogue); Phase 2 deals/contacts |
| **decisions** | B6: only NGN, GHS, KES, ZAR. Approvals (T-0166), send (T-0167), payment links (T-0169) are out of scope. |
| **budget** | Max 3 sessions before escalating |

## Goal

A programme can create, list, get and update quotes with line items (product /
variant references, quantity, unit amount in minor units, optional line
discount), set a quote-level discount and validity, bump a version on draft
edits, and move status through a gated transition — all programme-scoped,
behind `crm_quotes`, with money never a float.

## Context

- Extend OpenAPI: `docs/api/commerce.openapi.yaml`.
- Migration **0048**: `quote`, `quote_line`. Programme-scoped; RLS ENABLED and
  FORCED; in `TENANT_SCOPED_TABLES`. Take the number only after T-0164's 0047
  has merged (phase plan: two migration PRs never share a number).
- Domain: `packages/domain/core/src/commerce/` (alongside catalogue).
- API: `apps/api/src/commerce/`.
- Flag: `crm_quotes` (off by default; on in `pnpm demo`).
- Prior art: T-0164 catalogue (D-L210 grants, `catalogue.write`, currency/
  amount caps). Mirror with `quotes.write` for create/update/status.
- Zod 4; closed bodies (`z.strictObject`); currencies NGN/GHS/KES/ZAR only.

## Acceptance tests

Already committed and currently **failing**. Do not edit these files.

- `tests/acceptance/commerce/quotes.acceptance.test.ts`

Suite header rulings (R1–R12) are the contract until the lead amends them.

## Non-goals

Approvals (T-0166), PDF/send (T-0167), payments (T-0168/T-0169), deal-page
wiring (T-0170), P21 screens (T-0171), FX rate-lock (B5), invoices/MBS (S5),
refunds/partial payments (B3).

## Definition of done

- [ ] Named acceptance tests pass, unmodified
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` for touched packages
- [ ] OpenAPI updated (`docs/api/commerce.openapi.yaml`)
- [ ] i18n keys added if user-facing strings were added
- [ ] Migration reviewed; every new table in `TENANT_SCOPED_TABLES` with RLS
- [ ] Completion report at `team/reports/T-0165.md`
- [ ] Acceptance PR merges before the build PR (phase plan §4)

## Escalate if

- An open decision blocks you — name it, stop, do not guess.
- An acceptance test looks wrong — say so, do not edit it.
- You exceed the budget above.
