# T-0169 hardening (D-A3)

## Changed
- `payment_links` flag is now read: `payment-links-flag.ts` (token, `PaymentLinksEnabledGuard`, helper), guard placed before `KasuwaAuthGuard` on both payment-link controllers so off answers 404 like an unknown route, even unauthenticated. `CommerceModule.forRoot` provides it; `AppModule` option `paymentLinksEnabled`; `main.ts` reads the flag (default off).
- `markQuotePaidFromLink` (domain-core repository): removed the bare `catch` that returned the quote. In a Postgres transaction a failed statement aborts it, so the swallow hid the error and failed the commit later.
- `applyPaymentWebhookEvent` wraps a reconciliation failure in `PaymentReconciliationError` (carries the cause class name only, fixed message). The webhook controller logs the class name only and answers a bare 503. The transaction rolled back, so the event is not recorded and the provider retry re-applies it. Reject cases keep the single 401 body.
- Tests: `payment-webhooks.controller.test.ts` (9), `payment-links-flag.test.ts` (4).

## Hard
Another agent edits `commerce.module.ts`, `app.module.ts` and `main.ts` (vat_multitax) at the same time; both options live in one `CommerceModule.forRoot`.

## Left out
Acceptance suites not run (no Docker). Link create/read with the flag on is covered by acceptance only. `tests/acceptance/support/api.ts` must forward `paymentLinksEnabled` (lead).

## Open questions
Whether 503 or 500 is preferred for failed reconciliation (503 chosen: retryable, generic).
