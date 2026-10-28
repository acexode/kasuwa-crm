# T-0168 — `packages/payments-adapter`

| Field | Value |
|---|---|
| **id** | T-0168 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Agent A2 — S1 Commerce |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0; PLAN T-0168 |
| **dependencies** | none (adapter contract only) |
| **decisions** | D-L205 (package approved); CLAUDE.md §2.8; PCI / PAN rule in PLAN |
| **budget** | Max 2 sessions before escalating |

## Goal

Ship `@kasuwa/payments-adapter`: the `PaymentProvider` contract (create payment
link, verify webhook signature, parse webhook event), an in-memory fake, and a
default that **fails closed**. The only place Paystack / Flutterwave are named.
PAN-free by type (`token` + `lastFour` only).

## Context

- Mirror `packages/channel-adapter` / `packages/telephony-adapter` (package.json,
  tsconfig, exports, `scope:adapter`, vitest / tsconfig wiring).
- No DB migration. No payment-links API (T-0169). No quotes/catalogue edits.
- Flag: not required for the adapter itself; `payment_links` lands with T-0169.

## Acceptance tests

Lead-authorised for this agent to create:

- `tests/acceptance/adapters/payments-adapter.acceptance.test.ts`
  — boundary lint (vendor names only inside the package); type surface has no
  PAN fields; fail-closed default; fake works.

## Non-goals

- Real Paystack / Flutterwave SDKs and webhook HTTP routes (T-0169)
- M-Pesa / MoMo (T-0177)
- Migrations, commerce API, deal-page wiring, P21 screens

## Definition of done

- [ ] Named acceptance tests pass
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` for touched packages
- [ ] Completion report at `team/reports/T-0168.md`
- [ ] No PR from this agent — commit + push the feature branch only
