# T-0082 — Activities API: my activities, the calendar, meetings, snooze and reschedule (P07)

**status** `not-assigned` (suite to be written) · **owner** Agent 3 · **priority** P1 · **decisions** D-L105, D-P18, D-P22,
D-L80, D-L81, D-L85, D-L97, D-L102 · **migration** next free when it starts

## Goal
Serve what T-0081 (#115) put in `records.openapi.yaml`, exactly as specified, and flip each new operation and property's
`x-kasuwa-implemented` to true.
- **`listMyActivities`:** the caller's own open tasks (`ownerUserId` = the session user) in the programmes the session
  resolves. Buckets are computed on the server in the validated IANA `timeZone` (D-L105). Keyset on `due_at` then id;
  id-only cursors; no counts; field security on every item. A row whose time field is withheld is dropped before the page
  is cut.
- **`listCalendar`:** the caller's own tasks with `dueAt` in `[from, to)` and meetings overlapping it. The window is at
  most 42 days, never clamped.
- **`meeting` type:** `starts_at` and `ends_at` columns (migration). End after start, at most 24 h. The meeting-only and
  task-only codes apply to the resulting row on update.
- **`updateActivity`:** `dueAt` (snooze), `startsAt`/`endsAt` (reschedule), under D-P18's rights, with `version`
  optimistic locking. Audited by name, with D-L72's value rules.
- **Timelines** carry meetings (D-L85). Under D-L97, the web parser in `apps/web/lib/contact-record-api.ts` and
  the account record's parser accept `meeting` in the same PR, and the e2e mocks follow the contract.
- **Not here:** reminders, external calendars (D-P22) and reopening a task.

## Acceptance tests
`tests/acceptance/records/activities-api.acceptance.test.ts`, written by the lead (D-L23). It also edits the T-0081 suite's
"implemented: false" pins to true.

## Escalate if
Index support for "my open tasks by due time" needs an RLS-unsafe expression (see the LEAKPROOF question gating T-0084).
