# T-0104 — Audit: a convert-created account, and an owner takeover (D-L82, D-L71)

**status** `not-assigned` (lead suite edits first) · **owner** Agent 3 · **priority** P2 · **decisions** D-L82, D-L71, D-L72

## Goal
- **Convert:** a convert that creates an account writes two audit events in its one transaction: the contact `updated` (as now)
  and the account `created`, names only (D-L78). A repeat or a refusal writes neither.
- **Takeover:** an `ownerUserId` change on a contact records the before and after owner ids as values. Staff ids are not
  customer PII. T-0078's contact value allow-list gains `ownerUserId` in the same change.

## Acceptance tests
Lead edits, made first on a `lead/*` branch: `leads-api.acceptance.test.ts` (convert audit), `contacts-api.acceptance.test.ts`
(takeover values) and `audit-field-security.acceptance.test.ts` (the allow-list).

## Escalate if
The second event cannot share the convert's transaction.
