# T-0100 — Notifications: producers, consumer and API (migration)

**status** `not-assigned` (waits on T-0098 and T-0099; suite to be written) · **owner** Agent 1 · **priority** P1 ·
**decisions** ADR-0018, D-P29, D-L128 (ADR-0018 Q2), D-L71, D-P23, D-L87, D-L134 · **migration** 0044 (projected)

## Goal
Implement T-0099 on T-0098's outbox.
- **The table needs a decision recorded.** `notification` is named in ADR-0018 point 8 and D-P29, but not specified there.
  The lead records the approval before this is assigned.
- **Depends on:** T-0098 (merged) and T-0099. The producers edit the contact, account, deal and activity services, so build
  this after T-0095 merges. The `import.finished` producer needs T-0094; if T-0094 has not merged, it is left out and
  becomes a follow-up.
- **Migration 0044, `notification`:**
  - columns: tenant, programme, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id,
    created_at, read_at. No name, subject or value (D-P29).
  - It is ENABLED and FORCED, in `TENANT_SCOPED_TABLES`, with the tenant-and-programme policy whose WITH CHECK is
    identical to USING.
  - A restrictive SELECT-and-UPDATE policy limits rows to `recipient_user_id` = the session user. The consumer inserts as
    the actor, so INSERT is not recipient-restricted.
  - `kasuwa_app` gets INSERT, SELECT and `UPDATE (read_at)` only, with no DELETE.
  - A UNIQUE on (`source_event_id`, `recipient_user_id`), inserted with `ON CONFLICT DO NOTHING`. The migration reviewer
    confirms this needs no SELECT policy on the conflict path.
- **Producers** call `appendOutboxEvent` in the same transaction as the change. Each event schema is exported from its
  domain's public entry.
  - `contact.owner_changed`, `account.owner_changed`, `deal.owner_changed` and `activity.assigned`;
  - `import.finished`, one per job, never one per row.
  - D-P23 unassignment produces no notification.
- **Consumer** (`kasuwa.events.notifications`, through T-0098's helper):
  - it re-reads the aggregate under RLS and acts on current state;
  - the recipient is the current owner or assignee, skipped when it is the actor (except `import_finished`), and only when
    the recipient is a member of the programme;
  - idempotent through the unique key.
- **Reads:**
  - recipient's rows in the session's programmes, keyset;
  - display names resolved through each object's scoped repository and field security;
  - invisible objects dropped;
  - the unread count checks visibility over at most the newest 100 unread, then caps at 99+.
- **Throttle:** as search does (D-L134).
- **Size:** about 600 lines. If needed, split into PR 1 (migration, producers and consumer) and PR 2 (read API).

## Acceptance tests
- `tests/acceptance/records/notifications-api.acceptance.test.ts`, plus cases in
  `tests/acceptance/tenancy/outbox-forgery.acceptance.test.ts` (lead, D-L23).
- They must cover:
  - no PII in notification rows, payloads or logs;
  - a reader who lost the object's programme sees nothing and the count drops;
  - a withheld name is null;
  - a duplicate event yields one row;
  - a forged job writes nothing;
  - self-assignment produces no notification;
  - an import of N rows yields one notification.
- Unmodified: `rls-enforcement`, `schema-hygiene`, `contacts-api`, `accounts-api`, `deals-api` and `activities-api`.

## Non-goals
- the screen (T-0101);
- mentions, approvals, SLA and security kinds;
- every non-in-app channel (D-P29);
- a socket (D-L87);
- purging old notifications (needs a retention ruling).
