# T-0098 — Transactional outbox, `kasuwa_relay` and the relay (ADR-0018; migration, new role)

**status** `not-assigned` (suite to be written; no task dependency) · **owner** Agent 1 · **priority** P1 · **decisions**
ADR-0018, D-L128 (ADR-0018 Q1–Q5), D-P30 item 2, D-P29, ADR-0012, ADR-0013, D-L66, D-L94, D-L65 · **migration** 0043
(projected)

## Goal
Build ADR-0018, Decisions 1 to 11. This task needs a CLAUDE.md section 8 decision for a new table and a new LOGIN role.
ADR-0018 and D-P30 are that decision.
- **Depends on:** nothing. Its config change waits for T-0092's config PR, or follows the lead's registry PR. **Unblocks:**
  T-0100, and later the M18 invite send.
- **`bootstrap.sql`** (lead-owned; the lead makes the edit or approves it): create `kasuwa_relay` with LOGIN, NOBYPASSRLS,
  NOSUPERUSER, NOCREATEDB, NOCREATEROLE and NOREPLICATION.
  - It is a member of nothing and has no members. It is never granted to `kasuwa_app`. No default privilege names it.
  - Add a matching section to `packages/db/CLAUDE.md`.
- **Migration 0043, `outbox_event`**, per ADR-0018 point 1:
  - `programme_id NOT NULL` (Q1) and `actor_user_id NOT NULL` (Q2: system jobs act as their initiator, so no NULL is
    needed yet);
  - the two partial indexes;
  - ENABLED and FORCED, in `TENANT_SCOPED_TABLES`;
  - `kasuwa_app` holds INSERT and SELECT only, with UPDATE and DELETE revoked;
  - the relay's three policies and column grants exactly as in point 4;
  - a migrate-time assertion of the role's shape and grants, which fails loudly if bootstrap has not run (the 0020 and 0024
    pattern).
- **`appendOutboxEvent(tx: TenantTx, event)`** in `packages/db`:
  - the tenant comes from the session, and a programme outside scope is refused;
  - the payload is parsed by the event type's strict schema, with no free-text strings (D-P29).
  - An event registry ships with one real type, `contact.owner_changed` (contact id and previous and new owner ids; staff
    ids are not PII, D-L71). Its schema is exported from the contact module's public entry. T-0100 wires the producer.
- **Relay** (`apps/worker`; a `DATABASE_RELAY_URL` pool, max 2):
  - claims with `FOR UPDATE SKIP LOCKED` in batches of 100, ordered per aggregate with `NOT EXISTS`;
  - enqueues with `addBulk`, using the event id as `jobId`, then marks published without `RETURNING`;
  - polls every second;
  - **dead after 10 publish attempts; consumer jobs retry 5 times, then sit in the failed set** (Q3).
  - One queue per consuming domain (`kasuwa.events.notifications`).
- **The consumer re-entry helper** (point 8):
  - opens `withTenantTransaction({ tenantId, userId: actor })` and re-reads the outbox row under RLS;
  - drops and counts a missing or mismatched row, or an actor who no longer resolves;
  - then hands the handler the transaction.
- **Retention (Q3):** the relay's sweep deletes published rows after 7 days and dead rows after 30.
  - It runs in batches under a transaction-scoped advisory lock.
  - The window lives in both the policy and the DELETE.
  - BullMQ keeps completed jobs for at least 7 days.
- **Config:**
  - `workerEnv` requires `DATABASE_RELAY_URL`. The other process schemas refuse it, and the D-L94 dev-password refusal
    covers it.
  - The worker refuses to boot unless that pool is `kasuwa_relay` and `DATABASE_URL` is `kasuwa_app`.
  - Update the `apps/worker/src/main.ts` header comment, which ADR-0018 amends.
- **Observability (Q4, Q5):** logs carry event id, type, attempt and outcome only. Metrics: backlog, oldest-unpublished age,
  publish failures, dead rows and consumer drops. A dashboard, not paging. The runbook notes that the failed set is
  trimmed by hand.
- **Size:** over 600 lines, so two PRs. PR 1: role, migration, `appendOutboxEvent` and config. PR 2: relay, sweep, consumer
  helper and metrics.

## Acceptance tests
- `tests/acceptance/platform/outbox.acceptance.test.ts` and `tests/acceptance/tenancy/outbox-forgery.acceptance.test.ts`
  (lead, D-L23), covering ADR-0018's "Tests" section:
  - the catalogue;
  - the relay can touch nothing else;
  - the app cannot tamper;
  - atomicity;
  - claim semantics;
  - forged jobs;
  - payload hygiene.
- Unmodified: `rls-enforcement`, `schema-hygiene`, `config-schemas`, `auth-role` and `test-admin-absent`.

## Non-goals
- any consumer beyond the helper's test double (T-0100);
- producers in the domains (T-0100);
- tenant-level events (Q1);
- a NOTIFY wake-up;
- alerting or paging (Q4);
- automatic trimming of the failed set (Q5);
- search sync and webhooks.
