# T-0002 — Metadata engine foundations: object and field definitions

| Field | Value |
|---|---|
| **id** | T-0002 |
| **status** | `done` |
| **module** | M15 — Customisation & app builder |
| **owner** | Agent 2 — Metadata & Customisation |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M15-customisation-and-app-builder.md`; founding pack 3.4 "Metadata layer"; US-5 |
| **dependencies** | none |
| **decisions** | none blocking. D-L06 is answered: programme scope is always an explicit list. |
| **budget** | 4 sessions before escalating |

## Goal

An admin can define a custom field on a standard object and a custom object, and
those definitions are stored, tenant-isolated and readable through a typed API.
No UI, no dynamic endpoint generation, no formula engine yet. The point of this
task is the storage model and its isolation properties, because the rest of M15
is built on top of it and a mistake here is expensive to undo.

## Context

- Founding pack 3.4 gives the target shape: `object_def`, `field_def`,
  `layout_def`, `validation_rule`, `record_type`, `custom_record`. Implement
  `object_def` and `field_def` **only**.
- `packages/metadata-engine/src/index.ts` is a placeholder. Read the comment.
- `packages/db/migrations/0001_tenancy_core.sql` is the pattern to copy: every
  table gets `tenant_id`, `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, and a
  policy whose `WITH CHECK` matches its `USING`.
- Add every new table to `TENANT_SCOPED_TABLES` in `packages/db/src/schema.ts`,
  or the catalogue invariant in the isolation suite fails — that is intended
  behaviour, not an obstacle.
- Metadata is tenant-scoped but **not** programme-scoped: a custom field belongs
  to the tenant, not to one client programme. Say so explicitly in the migration
  comment. It is the one place where omitting `programme_id` is correct, and a
  future reviewer will otherwise assume it is a bug.

## Acceptance tests

**Real and failing**, at
`tests/acceptance/metadata/metadata-isolation.pending.acceptance.test.ts`.
Run them with `pnpm test:pending`. The lead renames the file to drop `.pending`
when assigning; from then on CI enforces it and you may not edit it.

The contract:

- `object_def` and `field_def` exist, are in `TENANT_SCOPED_TABLES`, and have
  RLS enabled **and** forced with at least one policy
- tenant A cannot read, update or delete tenant B's definitions — including
  when it knows the id, which is the realistic case
- a field definition cannot point at another tenant's object definition
- `api_name` uniqueness is per tenant per object, never global: two tenants must
  both be able to call a field `priority`
- **metadata is tenant-scoped but NOT programme-scoped** — asserted positively,
  because a missing `programme_id` looks like an oversight to a later reviewer
  and this is the one place it is correct
- cross-tenant reads still fail with a forged programme scope, and everything
  fails with no session context

`seedObjectDef()` in that file throws deliberately — implementing it is part of
this task.

## Non-goals

- `custom_record` storage, the `custom jsonb` strategy, expression indexes,
  OpenSearch mirroring — the next task.
- Formula engine, validation rules, record types, layouts.
- Runtime OpenAPI/GraphQL generation.
- Any UI.

## Definition of done

Standard, plus:

- [ ] New tables in `TENANT_SCOPED_TABLES`; catalogue invariant passes
- [ ] Migration is append-only and reviewed by `migration-reviewer`
- [ ] Anything the PRD does not settle is written into the "Open questions"
      section of `docs/prd/M15-*.md` — there will be several; the PRD is two
      bullets deep here

## Escalate if

- You need to choose between the generic `custom_record` table and materialised
  columns per tenant. That is ADR territory and affects Silo tenants.
- You find the PRD's metadata bullets too thin to proceed. That is a real
  finding for `DECISIONS.md`, not something to guess past.
