# T-0083 — Activities screen: my tasks, the calendar, meetings, snooze and reschedule (P07)

**status** `not-assigned` (suite to be written; can start before T-0082 merges, against mocks) · **owner** Agent 11 ·
**priority** P1 · **decisions** D-L105, D-L107, D-P18, D-P21, D-P22, D-L97, D-L102

## Goal
The P07 screen at `/activities` (design: `docs/design/P07/`, final exports), behind a new flag `crm_activities` (off by
default, not production-ready), against T-0081's contract.
- **My work:** `listMyActivities` in three buckets (overdue, today, upcoming). The caller's IANA zone is the browser's
  resolved zone, sent as `timeZone` and never guessed on the server. Keyset paging on `nextCursor`, no counts.
- **Calendar:** `listCalendar` over a week or month view, with a window of at most 42 days. Meetings span their times;
  tasks sit at their due time. Kasuwa events only (D-P22). Times are shown in the caller's zone.
- **Compose:** a task or a meeting. A meeting has both times, end after start, at most 24 h. The owner is the caller.
- **Snooze and reschedule:** `updateActivity` with `dueAt`, or `startsAt`/`endsAt`. Send `version` plus the changed fields
  only, and rebase after a 409 (D-L102). A 403 `field_not_editable` is a message, not a retry.
- **States:**
  - a withheld time is a lock, never a guess;
  - empty, failed and loading are distinct;
  - a contact or account summary links only from a well-formed uuid.
- **Rules:**
  - no UUID printed;
  - i18n everywhere (every catalogue);
  - no colour literals;
  - no offline writes (D-P21);
  - nothing stored on the device;
  - the byte budget is measured and pinned.

## Acceptance tests
`tests/acceptance/records-ui/activities-screen.acceptance.test.ts`, `tests/e2e/p07-activities.spec.ts` and
`tests/e2e/support/activities-mock.ts` (lead, D-L23). The mock validates against `records.openapi.yaml` and is pinned by
sha256.
