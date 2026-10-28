# @kasuwa/payments-adapter

The single boundary between Kasuwa and payment providers (Paystack, Flutterwave;
later M-Pesa / MoMo). `CLAUDE.md` section 2 rule 8: no module outside this
package may name or call a payment vendor.

## Contract (T-0168)

- `PaymentProvider` — create a payment link, verify a webhook signature, parse
  a webhook event.
- `FakePaymentProvider` — in-memory, for tests and local development.
- `NullPaymentProvider` — refuses every operation (`ProviderUnavailableError`).
- `defaultPaymentProvider(environment)` — fake in development/test; null in
  production, so production never reports a payment as created when none was.

Payment method refs are **PAN-free by type**: `token` + `lastFour` only.

Real provider SDKs land with T-0169 / T-0177. Until then, callers use the fake
or the fail-closed default.

## Using it

```ts
import { defaultPaymentProvider, FakePaymentProvider } from '@kasuwa/payments-adapter';

const provider = defaultPaymentProvider('test'); // or new FakePaymentProvider()
const link = await provider.createPaymentLink({
  scope: { tenantId, programmeId },
  amountMinor: 150_000n,
  currency: 'NGN',
  reference: 'quote-…',
  idempotencyKey: '…',
});
```

Never import `FakePaymentProvider` from application code — eslint forbids it.
