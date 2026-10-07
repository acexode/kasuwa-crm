# T-0055 — Accounts API

**status** `assigned` (suite on `lead/T-0055-acceptance`) · **owner** Agent 3 · **priority** P0 (blocks T-0057, T-0063) · **decisions** D-L63, D-L67, D-L69, D-P13, D-P18 (answered: admin-only writes), D-L78

## Goal
Implement the T-0052 account operations (`records.openapi.yaml`), and flip `x-kasuwa-implemented` to true.
- **Reads:** list (`q`, filters, sort, keyset), get, and `listAccountContacts` (reachable contacts only).
  - `listAccountContacts` answers 400 `field_withheld` when the contact's `accountId` is withheld from the caller.
- **Writes:** create and update.
  - A new programme action, `account.write`: the `admin` set in the target programme, or the tenant-admin flag (D-L53, D-L63).
    Everyone else is read-only until D-P18 is answered.
  - Owner must be a member of the account's programme (D-L67).
  - Parent must be in the same programme; a cycle is 400 `parent_cycle`.
  - A stale `version` is 409.
- **Field security:** via `loadFieldAccess(tx, 'account')` and `fieldLevel` (T-0053). Withheld fields are omitted and listed.
- **Audit:** one event per write, labelled by record id (D-L63).
- **Logs:** `q` is redacted from logs and spans (D-L64).
- **Routes:** register the `map` route (501) before `:accountId`.

## Acceptance tests
`tests/acceptance/records/accounts-api.acceptance.test.ts`, written by the lead.