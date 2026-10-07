# T-0063 — Account record screen (P05)

**status** `not-assigned` (after T-0062; the account timeline needs an account-side timeline endpoint, which is a contract task first) · **owner** Agent 11 · **priority** P2 · **decisions** D-L69, D-L74, D-L78

## Goal
P05 frame 04 for an account, behind `crm_record_view`.
- **Details:** driven by account field security.
- **Hierarchy:** the parent and child breadcrumb, at most depth 5.
- **Contacts grid:** `listAccountContacts`, showing only reachable contacts. It shows a message when `accountId` is withheld
  (400 `field_withheld`).
- **Activities:** the account's activities. Pipeline rollups come after the pipeline slice.
- **Rules:** never print a UUID; i18n everywhere; byte budget pinned.

## Acceptance tests
To be written once an account timeline contract exists (a small contract task, to be numbered when it starts).