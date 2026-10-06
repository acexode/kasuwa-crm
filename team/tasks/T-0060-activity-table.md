# T-0060 — The `activity` table

**status** `assigned` (suite on `lead/T-0060-acceptance`; migration 0027) · **owner** Agent 3 (Agent 1 reviews the migration) · **priority** P1 (blocks T-0061's activity items) · **decisions** D-L69, D-L65, D-L67, D-L72

## Goal
A programme-scoped `activity` table: notes, tasks and logged calls against a contact or an account. Migration number:
the next free one when the task starts.
- **Columns:**
  - `id`, `tenant_id`, `programme_id`;
  - `type`, a CHECK on `note | task | call`;
  - `subject`, `body`. The body is free text and may hold PII. It is never logged.
  - `due_at timestamptz`, `completed_at timestamptz`, both for tasks;
  - `owner_user_id`, with the composite FK to `"user"`;
  - `contact_id`, `account_id`, each nullable, each with a composite FK on `(tenant_id, programme_id, …)`, so an activity can
    never point at a record in another programme;
  - a CHECK that at least one target is set;
  - `created_by_user_id`, `version`, timestamps.
- **Reserved:** `deal_id` is added by the pipeline slice, not now.
- **Calendar fields:** start, end, an IANA timezone and reminders come with P07, not now.
- **Owner:** the owner must be a member of the activity's programme (D-L67). This is enforced in the repository, as for
  contacts.
- **Tenancy:** RLS ENABLED and FORCED, WITH CHECK = USING, an entry in `TENANT_SCOPED_TABLES`, keyset indexes per
  D-L65, and a standard `activity` object in the T-0053 catalogue.

## Acceptance tests
`tests/acceptance/records/activity-table.acceptance.test.ts`, written by the lead.