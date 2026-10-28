# T-0167 — Quote PDF template and send by email

| Field | Value |
|---|---|
| **id** | T-0167 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 Agent A5 |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M05-products-quotes-cpq-invoicing-payments.md` P0; US-3 |
| **dependencies** | T-0165 (quotes); `@kasuwa/channel-adapter` email kind |
| **decisions** | Email only until WhatsApp after S3. Fail closed until a real email provider exists (NullChannelProvider in production). No payment links (T-0169). No approvals (T-0166). |
| **budget** | Max 3 sessions before escalating |

## Goal

Render a deterministic quote PDF and send a quote by email through the
`email` channel kind of `@kasuwa/channel-adapter`. Persist a programme-scoped
`quote_send` row only when the provider accepts the message. Fail closed
(503, no row, no status flip) when the provider is unavailable. WhatsApp
send is explicitly out of scope until inbox S3.

## Context

- Extend OpenAPI: `docs/api/commerce.openapi.yaml` — `renderQuotePdf`, `sendQuote`.
- Migration **0050**: `quote_send`. Programme-scoped; RLS ENABLED and FORCED;
  in `TENANT_SCOPED_TABLES`. Append-only for `kasuwa_app` (SELECT + INSERT).
- Domain: `packages/domain/core/src/commerce/quote-pdf.ts`,
  `quote-send.repository.ts`.
- API: `apps/api/src/commerce/quote-send.service.ts` (+ quotes controller).
- Flags: `quote_send` (off by default; on in `pnpm demo`). `crm_quotes` still
  gates the quotes surface; send uses `quotes.write`.
- PDF: zero new dependencies — hand-built deterministic PDF 1.4 buffer.
- Prior art: portal invite send (channel adapter + 503 fail-closed).

## Acceptance tests

Lead-authorised deliverable on this branch:

- `tests/acceptance/commerce/quote-send.acceptance.test.ts`

Suite header rulings (R1–R10) are the contract until the lead amends them.

## Non-goals

WhatsApp send, payment links (T-0168/T-0169), approvals (T-0166), deal-page
wiring (T-0170), P21 screens (T-0171), FX rate-lock (B5), invoices/MBS (S5).

## Definition of done

- [ ] Named acceptance tests pass, unmodified after lead authorisation
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` for touched packages
- [ ] OpenAPI updated (`docs/api/commerce.openapi.yaml`)
- [ ] Migration reviewed; `quote_send` in `TENANT_SCOPED_TABLES` with RLS
- [ ] `pnpm features` regenerates FEATURES.md
- [ ] Completion report at `team/reports/T-0167.md`

## Escalate if

- An open decision blocks you — name it, stop, do not guess.
- An acceptance test looks wrong — say so, do not edit it after lead lock.
- A PDF dependency seems required — document and escalate rather than adding
  silently (policy: no new deps without PR justification).
- You exceed the budget above.
