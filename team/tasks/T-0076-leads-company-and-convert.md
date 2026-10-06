# T-0076 — Leads: `contact.company_name`, the Leads list and convert

**status** `not-assigned` (suite after T-0056) · **owner** Agent 3 (Agent 1 reviews the migration) · **priority** P1 · **decisions** D-P17, D-P18, D-L63, D-L67

## Goal
Serve the T-0056 contract.
- **Migration** (the next free number when the task starts): `contact.company_name` text, plus its standard `field_def` in the
  T-0053 catalogue, using the clash pre-check recipe.
- **The Leads list:** served through the contacts list path. Field security, scope and paging are unchanged.
- **Convert:**
  - Allowed to `admin` and to the tenant-admin flag. Converting creates or links an account, and account writes are
    admin-only (D-P18).
  - Idempotent, one transaction, one audit event labelled by record id.
  - The account must be in the contact's programme.

## Acceptance tests
`tests/acceptance/records/leads-api.acceptance.test.ts`, written by the lead.