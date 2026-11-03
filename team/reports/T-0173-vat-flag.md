# T-0173 — vat_multitax flag wiring

## What changed
- `invoices.service.ts`: `createInvoiceFromQuoteFor(tx, params, { vatMultitaxEnabled })`; the hard-coded `includeTax = true` is gone.
- New `apps/api/src/commerce/vat-flags.ts` (token + helper); `InvoicesQuoteController` injects it.
- `CommerceModule.forRoot({ vatMultitaxEnabled })`; `AppModuleOptions.vatMultitaxEnabled`; `main.ts` reads flag `vat_multitax` (default false).
- Tests: `tax.repository.test.ts` (8) and `vat-flags.test.ts` (1).

## Off vs on
- Off (default): no `tax_line` rows, `taxMinor` "0", invoice `totalMinor` = quote total (pre-T-0173). The code never had a separate "single-rate" path, so "previous behaviour" was read as the pre-T-0173 invoice. Ambiguous; chose the safest.
- On: product tax_profile rates bucketed by code+rate, persisted, added to total.

## Rounding (documented, unchanged)
Tax is computed PER LINE (after line discount and a pro-rata share of the quote discount), `ceil` in minor units, then summed per bucket. Two 1-minor lines at 7.5% give 2, whereas rounding the summed base once gives 1. Zero-rated (rate 0) and exempt (no profile) lines produce no bucket.

## Open question for @acexode
Should VAT round per line (current) or once per invoice/bucket? Per line can overcharge by up to (lines-1) minor units versus per invoice.

## Not done
No integration or acceptance runs. No service-level flag-off test (needs a DB tx).
Acceptance harness (`tests/acceptance/support/api.ts`) needs `vatMultitaxEnabled` passed through to `AppModule.forRoot`; the vat-multitax suite must set it true.
