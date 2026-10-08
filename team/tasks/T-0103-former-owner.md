# T-0103 — A contact's owner who left its programme (D-P23)

**status** `assigned` (suite `lead/T-0103-acceptance`: a3a3bc1; hook 9379fda; migration 0031; D-L99) · **owner** Agent 3 · **priority** P1 · **decisions** D-P23, D-L61, D-L67

## Goal
Nobody sees the name of a person who no longer shares the contact's programme.
- **Contract first:** `owner: { id, displayName: null }` means "former owner"; the screens show a translated neutral label.
- **Read path:** the owner subquery gains a membership predicate (the owner is in the contact's programme). A non-member owner
  reads as above; `ContactOwnerUnresolvedError` is no longer thrown for that case.
- **Removal:** removing a user from a programme unassigns their contacts in that programme, in the same transaction, as one
  audited statement (count only, no names).

## Acceptance tests
`tests/acceptance/records/former-owner.acceptance.test.ts`, written by the lead; `contacts-api` and `display-names` must still
pass unmodified, or the lead edits them first.

## Escalate if
Programme removal has more than one write path.
