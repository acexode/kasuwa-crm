# ADR-0008 — Metadata is tenant-scoped and deliberately not programme-scoped

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Agent 2 (Metadata & Customisation), lead agent, @acexode
- **Source:** T-0002; `docs/prd/M15-customisation-and-app-builder.md` open
  question 2 ("that is a real decision and should be recorded as one when
  T-0002 lands"); founding pack 3.4

## Context

Programme is the isolation boundary *inside* a tenant. Nearly every table in
Kasuwa carries `programme_id` and every policy on such a table adds
`programme_id = ANY (app.current_programme_ids())`. That is the default, and
deviating from it is the kind of thing that should require an argument.

`object_def` and `field_def` — the storage model for custom objects and custom
fields — are the deviation. They carry `tenant_id` and no `programme_id`.

## Decision

Metadata definitions are scoped to the tenant. Their RLS policies use the
tenant predicate alone:

```sql
USING      (tenant_id = app.current_tenant_id())
WITH CHECK (tenant_id = app.current_tenant_id());
```

Reasons:

1. **A BPO configures its own platform, not its client's.** The admin who adds
   a `priority` field to `case` works for the BPO. If definitions were
   programme-scoped, that admin would have to recreate every field in every
   client engagement, and an agent moved from "Bank X Collections" to "Telco Y
   Care" would find a different-shaped object.
2. **Records stay programme-scoped.** The *definition* is tenant-wide; the
   *data* stored under it is not. `custom_record` (a later task) is
   programme-scoped like `contact`, so nothing about this decision widens
   access to anyone's records.
3. **It mirrors a precedent already in the schema.** `"user"` and
   `user_programme` are tenant-scoped for a related reason: scope resolution
   has to be possible before programme scope is known. Which definitions a
   given user may *edit* is a permissions question (M2), not a tenancy one.

Everything else about tenancy applies unchanged: `tenant_id` on both tables,
RLS `ENABLE` **and** `FORCE`, `WITH CHECK` identical to `USING`, composite
foreign keys carrying `tenant_id`, both tables in `TENANT_SCOPED_TABLES`, and
uniqueness scoped per tenant (and per object for fields) rather than globally.

## Consequences

**Good.** Customisation works the way a BPO actually operates. There is one
metadata cache per tenant rather than one per programme, which matters when the
runtime API generation of founding pack 3.4 arrives.

**Bad.** A tenant cannot yet give one client engagement a different object
shape from another. If that turns out to be needed, the expand path is a
nullable `programme_id` meaning "applies everywhere" plus a policy of the form
`programme_id IS NULL OR programme_id = ANY (...)` — additive, and therefore
available later without rewriting what exists.

**Risky.** This is exactly the kind of exception a later reviewer "fixes" on
seeing a missing `programme_id`. Three things defend it: the header comment on
`packages/db/migrations/0002_metadata_object_and_field_def.sql`, the note in
`packages/metadata-engine/src/index.ts`, and — the one that actually stops a
regression — `tests/acceptance/metadata/metadata-isolation.acceptance.test.ts`,
which asserts the exception **positively**: a user in programme A2 must see a
definition created in A1.
