# T-0053 — Standard objects get metadata rows, and field security reads them for any object

**status** `done` (#91) · **owner** Agent 2 (Agent 1 reviews the migration) · **priority** P0 (blocks field security on accounts, deals, activities) · **decisions** D-L69, D-P4, D-P9, D-L45

## Goal
Field security is hard-wired to contacts: `packages/domain/core/src/contact/contact-field-access.repository.ts` joins
`object_def.api_name = 'contact'`. Also, no tenant has `object_def` rows for its standard objects; only the T-0041 suite inserts
one. Fix both.
- **Migration `0025`** (reserved for this task). Backfill `object_def` and `field_def` rows for the standard objects `contact`
  and `account`, for every existing tenant.
  - Field `api_name`s are the contract's wire names.
  - The rows are marked standard: they cannot be deleted, and `api_name` cannot change (D-P4).
  - The rows are tenant-scoped, under the existing RLS.
- **Tenant provisioning** creates the same rows for a new tenant, in the same transaction.
- **A generic loader** `loadFieldAccess(tx, objectApiName)` in a shared place. The contact path uses it, with behaviour
  unchanged.
- No new SECURITY DEFINER function. Migration rules per D-L65.

## Acceptance tests
`tests/acceptance/metadata/standard-object-metadata.acceptance.test.ts`, written by the lead. The existing field-security suites
must still pass unmodified.

## Escalate if
The metadata engine's tables cannot mark a definition as standard without a new column. Adding one is fine in 0025, but say
so in the report.