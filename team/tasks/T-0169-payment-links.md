# T-0169 — Payment links (Paystack / Flutterwave)

| Field | Value |
|---|---|
| **id** | T-0169 |
| **status** | `not-assigned` |
| **module** | M05 |
| **owner** | Phase 3 W1 A1 |
| **priority** | P0 |
| **PRD refs** | M05 P0; PLAN T-0169 |
| **dependencies** | T-0168, T-0165 |
| **decisions** | D-L205 webhook slug; D-L212 B3 provisional (paid+expired only) |
| **budget** | 3 sessions |

## Goal

Create payment links via `@kasuwa/payments-adapter`; webhook ingress at
`/webhooks/<provider>/<tenantSlug>` with signature verification and idempotency;
reconciliation marks the quote paid and moves the deal to Won–Paid through the
gated move. **D-A3.** Refunds/partials are flagged empty states (D-L212).

## Acceptance tests

- `tests/acceptance/commerce/payment-links.acceptance.test.ts`

## Migration

**0051** — `payment_link`, `payment_event`. RLS ENABLE+FORCE; TENANT_SCOPED_TABLES.

## Non-goals

Real refunds/partials (B3); M-Pesa/MoMo (T-0177); P21 screens (T-0171).
