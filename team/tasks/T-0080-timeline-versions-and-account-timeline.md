# T-0080 — Timeline activity versions, and the account timeline

| Field | Value |
|---|---|
| **id** | T-0080 |
| **status** | `done` (#109) |
| **module** | M03 — Core CRM records; M06 — Activities |
| **owner** | Agent 3 — Core CRM |
| **priority** | P1 (unblocks T-0062's served-task completion and T-0063) |
| **PRD refs** | `docs/prd/M03-core-crm-records.md` (360° record); `docs/prd/M06-activities-calendar-tasks.md` |
| **dependencies** | T-0061 (#102) |
| **decisions** | D-L85 (the version gap), D-L72, D-L77, D-L78, D-L83 (T-0078), D-P26 (portal; not decided, see Non-goals) |
| **budget** | 3 sessions |

## Goal

An agent on a contact's record can complete a task that someone else logged last week, and an agent on an account's record
sees what happened on that account, newest first, with the same field security and scope rules as the contact timeline.

## Context

Two changes to `docs/api/records.openapi.yaml`. **The contract goes first, in the same PR.**

1. **`version` on the timeline's activity item** (D-L85). `updateActivity` requires the version it was served, and the
   timeline is the only place a screen reads an activity, so today a task can be completed only in the session that logged
   it. Add `version` to the activity item of `TimelineItem`; it is the row's `activity.version`, unchanged by field security
   (a version is never withheld).
2. **`listAccountTimeline`: `GET /api/v1/accounts/{accountId}/timeline`.** It returns `AccountTimelinePage`, which shares the
   page shape and the activity item schema node with `TimelinePage` but names Account fields only (D-L90):
   - **Field changes:** the account's audit events as field-change items, **by name only** (D-L78, and T-0078's account
     policy has no value fields).
   - **Activities:** activities whose `account_id` is this account, read on `activity_account_keyset_idx`.
   - **Scope:** an account outside the caller's scope is the identical 404 body; an id that is not a uuid is the same 404.
   - **Field security:** the account's matrix judges the account's fields, and the activity matrix judges each activity
     item, exactly as on the contact timeline.
   - **Paging:** keyset newest-first; the cursor carries position only; no totals; `Cache-Control: no-store`.
   - **Not on it:** the activities of the account's contacts that carry no `account_id`. Rollups across contacts are the
     pipeline slice's.

Prior art: `listContactTimeline` in `apps/api/src/records/` (T-0061) and its tests. Copy its merge-of-two-sources keyset
and its fail-closed field-security path. Do not fork it: extract the shared part.

## Acceptance tests

Written by the lead, committed and failing before a builder starts:
- `tests/acceptance/records/timeline-v2.acceptance.test.ts`
- `tests/acceptance/records/contact-timeline.acceptance.test.ts` (T-0061's suite), with the lead's edit a93073a: the activity
  item's key set now includes `version`.

## Non-goals

- The portal's view of any timeline (D-P26, open). `client_portal` keeps today's behaviour; do not widen or narrow it here.
- Calls, messages, emails or tickets on the timeline (their modules own those items).
- An activity read endpoint (`getActivity`). The version on the timeline item is the smaller change (D-L85).
- The account record screen (T-0063) and the contact screen's complete control (a T-0062 follow-up).

## Definition of done

As TEMPLATE.md. No migration is expected; if you find you need one, stop and raise it.

## Escalate if

- An account timeline item would need a value D-L78 records by name only.
- The two timelines cannot share one implementation without changing the contact timeline's served behaviour.
