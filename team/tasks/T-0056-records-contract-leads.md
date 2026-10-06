# T-0056 — Records contract: leads (D-P17)

**status** `done` (#97) · **owner** Agent 3 · **priority** P1 (blocks T-0076, T-0058) · **decisions** D-P17 (answered), D-L61, D-L69, D-P13

## Goal
Extend `docs/api/records.openapi.yaml` (ADR-0004, the contract only). A lead is a contact at a lead stage (D-P17), so there is no
new record type.
- **`Contact.companyName`:** a string or null, writable, field-secured like the other contact fields.
- **The Leads list:** either `GET /contacts` with a `lifecycle=lead` filter, or a documented view meaning status in `new`,
  `contacted`, `qualified` or `unqualified`. The builder chooses and the suite pins the result.
  - Same paging, search, sort and field-security rules as `listContacts`. No totals (D-P13).
- **`POST /contacts/{id}/convert`:**
  - The body names an existing `accountId`, or a new account's `name`.
  - It qualifies the contact, links the account, and returns the contact and the account.
  - It runs in one transaction with one audit event, and is idempotent: a repeat answers with the same result.
  - An account in another programme is refused as if it did not exist.
  - The response codes are documented: 404, 403, 400, 409.
- **Hidden:** Merge, Lead score and the Map view are 501 or absent (D-L69, D-P12 later).
- Every operation carries `x-kasuwa-implemented: false` until T-0076, and `x-kasuwa-screens` naming the P04 Leads frames.

## Acceptance tests
`tests/acceptance/platform/records-contract-leads.acceptance.test.ts`, written by the lead.