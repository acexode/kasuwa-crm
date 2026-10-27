# T-0099 — Notifications contract (P26)

**status** `done` · **owner**
Agent 1 · **priority** P1 · **decisions** D-P29, ADR-0018, D-L87, D-L134, D-L97, D-L23

## Goal
Contract first, with `x-kasuwa-implemented: false` until T-0100. The design is in `docs/design/P26/`, frames A, A1, A3, B
and B2.
- **Depends on:** nothing technical. It runs after T-0093 to avoid editing the same spec at once. **Unblocks:** T-0100 and
  T-0101.
- **Kinds:** a closed enum that only grows (D-L87): `record_assigned` (contact, account, deal), `task_assigned` (activity)
  and `import_finished` (import).
- **`GET /notifications?filter=unread|all&kind=&cursor=&limit=`** returns keyset pages, newest first. Each item is
  `{ id, kind, objectType, objectId, actor: { id, displayName | null }, objectDisplayName | null, createdAt, readAt }`.
  - The display names are resolved at read time under the reader's scope and field security, and are null when withheld
    (D-P29).
  - An item whose object the reader can no longer see is dropped, not redacted. A page may therefore hold fewer than
    `limit` items, and `nextCursor` continues.
  - The client builds the sentence from `kind` with i18n. The server sends no title text.
- **`GET /notifications/unread-count`** returns `{ count: 0..99, capped }`, counted over visible items only.
- **`PATCH /notifications/{id}`** takes `{ read: boolean }`. **`POST /notifications/read-all`** takes `{ kind? }`, which is
  A1's "clear assignments in one tap".
- **Errors:**
  - An out-of-scope or someone else's notification is one 404 body.
  - Polling is throttled as search is (D-L134), with `429` and `Retry-After`, and a recommended interval is documented.
- There is no create or delete operation. Notifications come only from events.

## Acceptance tests
`tests/acceptance/platform/records-contract-notifications.acceptance.test.ts` (lead, D-L23). It is contract only. Every
existing mock still validates (D-L97).

## Non-goals
- approvals and inline Approve and Reject (hidden, D-L87);
- critical security alerts (A2) and toasts (C);
- preferences (D, D1), email, WhatsApp, SMS and push (E–E2): in-app only (D-P29);
- a socket or push channel (polling, D-L87);
- retention of notification rows (open: escalate for a period before T-0100's purge, if any).
