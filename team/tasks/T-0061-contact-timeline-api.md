# T-0061 — Contact timeline, account summary and activity writes

**status** `assigned` (suite on `lead/T-0061-acceptance`) · **owner** Agent 3 · **priority** P1 (blocks T-0062) · **decisions** D-L63, D-L64, D-L72, D-L73, D-P18 (answered)

## Goal
Serve what T-0059 contracted, and add activity writes.
- **`GET /contacts/{id}/timeline`:** items from audit events (`field_changed`, `consent_changed`) and from activities
  (`activity`).
  - Withheld fields are omitted **before** paging.
  - Item ids are per item, never the audit event id.
  - Ties are broken as the contract says.
  - The actor rules for former members, tenant admins outside the programme and deleted users are pinned by the suite.
- **The audit write records before and after values** for D-L72's non-PII fields from now on. Older events carry none.
- **`Contact.account`:** serve `{ id, name } | null`, and move it from the `allOf` part into `Contact.properties` in the same
  change (D-L73). Add it to the `listContacts` example.
- **Activities:** `POST /activities` and `PATCH /activities/{id}` (complete, reassign).
  - A new `activity.write` action, held by the `agent`, `team_lead`, `programme_manager` and `admin` sets in the activity's
    programme, and by the tenant-admin flag (D-P18).
  - Every write is audited and labelled by record id. Bodies are never logged.
  - Ids are minted on the server; `created_by_user_id` comes from the session; the owner must be in the activity's programme
    (D-L79).

## Acceptance tests
`tests/acceptance/records/contact-timeline.acceptance.test.ts`, written by the lead.