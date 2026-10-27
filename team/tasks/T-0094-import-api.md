# T-0094 — Import API and job, run as the initiating user (migration)

**status** `done` (waits on T-0092 and T-0093; suite to be written) · **owner** Agent 3 · **priority** P1 ·
**decisions** ADR-0017, D-L128 (ADR-0017 Q4–Q7; ADR-0018 Q2), D-P28, D-P12, D-P14, D-P33, D-L65, D-L67, D-L83 ·
**migration** 0041 (projected)

## Goal
Implement ADR-0017's import flow, steps 1 to 7, against T-0093's contract. This task needs a CLAUDE.md section 8 decision
for a new table and a new dependency. ADR-0017 and D-P30 are that decision.
- **Depends on:** T-0092 (adapter and `stored_object`) and T-0093 (contract). It does not depend on T-0095 or T-0098.
- **Migration 0041:**
  - `import_job`: tenant, programme, initiated_by, stored_object id (composite FK), status, headers, mapping, counts,
    errors, timestamps. It is in the 0027 pattern: ENABLED and FORCED, WITH CHECK identical to USING,
    `TENANT_SCOPED_TABLES`, no `kasuwa_app` DELETE.
  - `contact.import_job_id uuid NULL`, with a composite FK. This is a hot table; a nullable column with no default is
    acceptable under D-L65.
- **Endpoints:**
  - `POST /imports`, `/upload-urls`, `/complete`, `/abort`, `/mapping`, `/run` and `/cancel`, `GET /imports[/{id}]`, and
    the `importId` filter on the contacts list.
  - They hold metadata only and never carry bytes.
  - `contact.import` is a new right in `packages/permissions`, not held by the `agent` set (D-P14).
- **Worker** (`apps/worker`, two BullMQ jobs; payloads Zod-parsed, ids only):
  - **`kasuwa.import.header`** reads the first row only and stores the header names. It never logs them.
  - **`kasuwa.import.run`** streams the object through `csv-parse`: BOM, quoted newlines, 64 KB per row, and a hard stop
    past 100,000 rows.
  - Each row is parsed with the contacts API's own Zod schema, plus T-0089's custom-field builder for `custom.*`.
  - Phones are normalised to E.164 with the default country's trunk rule. That rule moves from `apps/web/lib/phone.ts`
    into the domain, the four markets only, with no new dependency.
  - D-P28: a row that grants consent is a row error.
- **Run as the initiating user (D-L128 Q7):**
  - Each batch (for example 500 rows) opens its own `withTenantTransaction({ tenantId, userId: initiated_by })`.
  - Scope is re-resolved from `user_programme` every batch, and `contact.import` is re-checked.
  - A user who lost the programme or the right fails the job at that batch, with the counts so far. Scope is never
    widened.
  - Writes go through the contact repository's existing create path, so audit and field security apply unchanged. No
    repository internals are edited.
- **Duplicates (D-P12; no index, D-P33):**
  - A `DuplicateCandidatePort`. Its Phase 2 implementation loads the programme's normalised phones and lower-cased emails
    once per job by a scoped keyset scan, and adds each row the file creates.
  - An exact match is `skipped` with `possible_duplicate`. It never merges and never looks across programmes.
  - The suite pins the scan inside the T-0084 latency budget at the 120k seed.
- **Report:** counts, plus `{ row, column, code }` errors. No cell value goes in a row, log, error or audit entry.
- **Audit**, by id only, using existing actions so that `audit_event_action_check` is not touched (T-0095 owns that
  change):
  - `created` on import_job;
  - `rejected` and `deleted` on stored_object;
  - `updated` on import_job with counts when finished.
- **Retention (D-L128 Q5): the raw file is deleted 7 days after the job ends, and 24 hours after an abandoned `pending`
  row.**
  - **Escalate before building.** ADR-0017's "sweeper" names no role, `kasuwa_sweeper` is auth-only (db invariant 8), and
    `kasuwa_app` cannot see rows from every tenant.
  - **Proposed:**
    - a delayed BullMQ job per import, enqueued at job end (or at initiate for the 24-hour case), that deletes as the
      initiating user (ADR-0018 Q2's identity rule);
    - and, so erasure never depends on a user still existing, a bucket lifecycle rule (object tag `kasuwa-purpose=import`,
      set on `CreateMultipartUpload`; expire at 8 days; abort incomplete multipart uploads at 1 day);
    - a `head` 404 then reconciles `stored_object` to `deleted` on the next read.
  - A new role or a broader sweeper needs an ADR instead.
- **Size:** over 600 lines, so two PRs under this id. PR 1: migration, endpoints and the header job. PR 2: the run job,
  the duplicate port, the report and retention.

## Acceptance tests
- `tests/acceptance/records/import-api.acceptance.test.ts`, plus an adversarial file in
  `tests/acceptance/tenancy/import-isolation.acceptance.test.ts` (lead, D-L23).
- They must cover:
  - a second tenant's or programme's job is 404 and gets no URL;
  - the declared-against-actual mismatch;
  - the 25 MiB and 100,000-row limits;
  - consent grants refused;
  - a user removed mid-job fails it;
  - no cell value in the job row, logs, audit or errors;
  - duplicates skipped within the programme and created across programmes;
  - the raw file gone after the retention trigger.
- Unmodified: `rls-enforcement`, `schema-hygiene` and `migration-runner`.

## Non-goals
- the merge (T-0095);
- the `import.finished` event (T-0100 adds the producer once T-0098 exists);
- a failed-rows CSV with values (D-L128 Q6);
- per-row assignment notifications (an import emits one `import.finished`, T-0100);
- legal hold against the 7-day window (M21 Q1, counsel).
