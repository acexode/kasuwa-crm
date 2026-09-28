# T-0011 — Two schema habits worth correcting once, repo-wide

| Field | Value |
|---|---|
| **id** | T-0011 |
| **status** | `not-assigned` |
| **module** | M1 platform |
| **owner** | Agent 1 — Platform & Security |
| **priority** | P2 — cheap now, not cheap later |
| **PRD refs** | — |
| **dependencies** | T-0002 (merged) |
| **decisions** | none blocking |
| **budget** | 1 session before escalating |

## Why this exists

Both items were found by `migration-reviewer` on the T-0002 migration, and
**neither is a defect in that migration** — it is consistent with the pattern
`0001_tenancy_core.sql` already set. That is precisely the argument for a
separate task: they are habits, not mistakes, and a habit gets copied into
every table that follows.

The reviewer's own framing, which is the right one:

> Noting it because `0001` has the same pattern, so this is a repo-wide habit
> worth correcting once rather than a defect in this commit.

## 1. Redundant tenant-prefix indexes

`object_def_tenant_idx ON (tenant_id)` is a strict prefix of the implicit
indexes behind `UNIQUE (tenant_id, api_name)` and `UNIQUE (tenant_id, id)`.
`field_def_tenant_object_idx ON (tenant_id, object_id)` is a strict prefix of
`UNIQUE (tenant_id, object_id, api_name)`. The planner cannot prefer either
over the unique index, so they are pure write amplification and disk.

The same pattern exists in `0001`: `business_unit_tenant_idx`,
`user_tenant_idx`.

**Impact today is near zero** — these tables are small by nature. It matters
because every future tenant-scoped table will copy the pattern, and by then the
tables are `contact`, `interaction` and `ticket`, where a redundant index on
every write is real.

Do **not** drop an index without checking it is genuinely a prefix of an
existing one. `contact_keyset_idx` is not redundant and must stay.

## 2. `updated_at` is never maintained

Both new tables (and every table in `0001`) default `updated_at` to `now()`
and nothing ever sets it again. There is no trigger, and no UPDATE path exists
yet.

**The column will be silently wrong the moment an update endpoint lands** —
which is worse than not having it, because a stale timestamp that looks
maintained gets used for cache invalidation, sync cursors and "what changed
since" queries, and it will be believed.

Decide and apply one policy repo-wide:

- a `BEFORE UPDATE` trigger per table, or
- every repository sets it explicitly and a test proves it, or
- drop the column where nothing needs it

**Recommendation: the trigger.** The repository-sets-it approach is one
forgotten line away from the same silent wrongness, and the thing that makes
this worth fixing now is that it *cannot* be forgotten once it is in the schema.

## Non-goals

- Changing any RLS policy. The policies are correct; this is indexes and
  timestamps only.
- Editing `0001` or `0002`. Migrations are append-only — this is a new one.
- Adding `updated_at` where it does not already exist.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/tenancy/schema-hygiene.pending.acceptance.test.ts`.

Behaviours they will name:

- no index in the catalogue is a strict column-prefix of another index on the
  same table, asserted against `pg_index` rather than by reading the SQL — so
  it keeps holding for tables nobody has written yet
- every table carrying `updated_at` advances it on UPDATE, demonstrated with a
  real update through a real repository
- `contact_keyset_idx` still exists, because the obvious way to satisfy the
  first assertion is to delete an index that is actually load-bearing

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- A "redundant" index turns out to serve a query plan the unique index does
  not. Say so with the `EXPLAIN` output — that is a finding, and the index
  stays.
