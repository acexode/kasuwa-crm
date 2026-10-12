# T-0081 — Activities, tasks and calendar contract (P07)

**status** `done` (#115, 2026-10-12; contract-only, lead PR) · **owner** Agent 3 · **priority** P1 · **decisions** D-L87, D-P18, D-P22,
D-L81, D-L85, D-L80, D-L97, D-L102

## Goal
`docs/api/records.openapi.yaml` gains what P07 needs, contract first, so T-0082 (API) and T-0083 (screen) build against a
fixed shape.
- **`listMyActivities`:** the caller's own tasks, bucketed overdue, today and upcoming in the CALLER's IANA timezone (sent as
  a validated parameter; buckets computed on the server). Keyset on `due_at` then id; id-only cursors (D-L80); no counts
  (D-P13). Field security on every item, as on the timeline.
- **`listCalendar?from&to`:** the caller's own Kasuwa events (tasks with a due time, and the new meetings) in a bounded
  window (at most 42 days), UTC on the wire. No external calendars (D-P22).
- **A `meeting` activity type** with `startsAt` and `endsAt` (end after start; at most 24 h; both UTC).
- **`updateActivity`** gains `dueAt` (snooze) and `startsAt`/`endsAt` (drag to reschedule), under D-P18's rights. It sends
  `version` plus the changed fields only (D-L102).
- **Not in the contract:** reopening a task (D-L81, D-L87), external calendars and booking (D-P22), offline queues (D-P21),
  reminders over SMS or WhatsApp.
- Every new operation is `x-kasuwa-implemented: false` until T-0082.
- **D-L97:** every e2e mock validating against the changed schemas (`TimelineItem`, `Activity`) still validates, and its pin is
  updated in the same commit.

## Acceptance tests
`tests/acceptance/platform/records-contract-activities.acceptance.test.ts`, written by the lead.
