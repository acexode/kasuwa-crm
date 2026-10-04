---
name: create-rls-migration
description: Create a new database migration with correct row-level security, grants and tests. Use whenever adding or changing a table in packages/db/migrations.
---

# Create an RLS migration

Adding a table to Kasuwa is not just DDL. A table without a correct policy is a
cross-tenant leak that every test will happily pass over, because a missing
policy looks exactly like "no rows matched".

Work through these steps in order. Do not skip step 7.

## 1. Decide the scope of the table

Three legitimate answers, and you must pick one deliberately:

| Scope | When | Policy predicate |
|---|---|---|
| **Tenant + programme** | Business records belonging to a client engagement — contacts, deals, calls, tickets | `tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids())` |
| **Tenant only** | Configuration belonging to the whole tenant — metadata definitions, roles, price books | `tenant_id = app.current_tenant_id()` |
| **Session bootstrap** | The two tables read *before* programme scope is known: `user`, `user_programme` | `tenant_id = app.current_tenant_id()` |

If you choose tenant-only for something that looks like a business record,
**write a comment in the migration saying why**. A reviewer will otherwise read
it as a forgotten predicate, and they will be right to.

## 2. Write the migration file

`packages/db/migrations/NNNN_short_description.sql`, numbered after the highest
existing file. Copy the shape from `0001_tenancy_core.sql`.

```sql
CREATE TABLE thing (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id  uuid        NOT NULL,          -- omit for tenant-only tables
  -- ... your columns ...
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),                      -- needed if children reference it
  CONSTRAINT thing_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX thing_tenant_idx ON thing (tenant_id, programme_id);

ALTER TABLE thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE thing FORCE ROW LEVEL SECURITY;

CREATE POLICY thing_isolation ON thing FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));
```

Four things people get wrong, in order of how often:

1. **`FORCE` omitted.** `ENABLE` alone leaves the table *owner* exempt. The
   owner is `kasuwa_migrator`, so the seed and any migration would silently read
   and write across every tenant.
2. **`WITH CHECK` omitted.** A `USING`-only policy filters reads but permits
   writing rows you cannot read back — including rows in another tenant.
3. **Plain foreign key instead of composite.** `REFERENCES programme (id)` lets
   a row point at another tenant's programme. Carry `tenant_id` in the key.
4. **Money or timestamps typed loosely.** `bigint` minor units plus an ISO
   currency column; `timestamptz`, never `timestamp`.

### Hot tables: build indexes CONCURRENTLY, validate constraints later (D-L65)

Once a cell holds real data, a plain `CREATE INDEX` or a validating `ADD
CONSTRAINT` on `contact` or another hot table holds a lock that blocks writes
while it scans. The rule from D-L65:

- add CHECKs and FKs `NOT VALID` in an ordinary migration;
- validate them, and build or drop indexes, in a **separate** migration whose
  first line is exactly:

```sql
-- kasuwa:no-transaction
-- 0042: D-L65, contact is hot. Validates the check added NOT VALID in 0041.
CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_phone_idx ON contact (tenant_id, phone);
DROP INDEX CONCURRENTLY IF EXISTS contact_phone_old_idx;
ALTER TABLE contact VALIDATE CONSTRAINT contact_phone_format_ck;
```

How the marker works:

- It counts only as the exact first line, with no indentation, no other text
  and no change of case. A marker anywhere else does nothing, and the file runs
  in a transaction, where `CONCURRENTLY` fails.
- The runner sends a marked file without `BEGIN`/`COMMIT`, **one statement at a
  time**.
- A marked file may contain only `CREATE [UNIQUE] INDEX CONCURRENTLY`, `DROP
  INDEX CONCURRENTLY` and `ALTER TABLE ... VALIDATE CONSTRAINT`, with no other
  action in the same statement. Comments are fine. The runner refuses anything
  else, including `SET`, `BEGIN`, `DO`, `VACUUM`, `REINDEX` and a plain `CREATE
  INDEX`. It checks the whole file before running any of it. Put everything
  else in an ordinary migration.
- The marker line is part of the checksum. Adding it to an applied file, or
  removing it, counts as an edit, and the runner refuses it.
- Use `IF NOT EXISTS` and `IF EXISTS`. Without a transaction, a file that fails
  on its third statement has already applied the first two. The file is **not
  recorded**, so the next run starts it from the top, and the `IF` clauses make
  that safe.

#### When a CONCURRENTLY build fails: clean up the INVALID index

A failed `CREATE [UNIQUE] INDEX CONCURRENTLY` (duplicate keys, a deadlock, a
cancelled deploy) does not roll back. It leaves the index behind marked
**INVALID**. Postgres maintains it on every write but never uses it for reads,
and a re-run then fails with "already exists". With `IF NOT EXISTS`, a re-run
silently keeps the broken index, which is worse. To recover:

1. Find it:
   ```sql
   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE NOT i.indisvalid;
   ```
2. Fix the cause, for example remove the duplicate rows that broke a unique build.
3. Drop the INVALID index without locking the table:
   `DROP INDEX CONCURRENTLY IF EXISTS <name>;` Run it on its own, outside a
   transaction, as `kasuwa_migrator`.
4. Run `pnpm db:migrate` again. The failed file was not recorded, so it runs
   again from its first statement.

You can correct the failed file itself before the re-run, because a failed
marked file is never recorded. First check that no other cell or environment
has applied it. Once a file is recorded anywhere, the usual append-only rule
holds.

## 3. Mirror it in the Drizzle schema

Add the table to `packages/db/src/schema.ts`. This is a *mirror* — the SQL is
the source of truth (ADR-0006).

## 4. Add it to `TENANT_SCOPED_TABLES`

Same file, the exported list at the bottom. The catalogue invariant in
`tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts` asserts that the
set of tables in the database matches this list exactly — so forgetting it
fails the isolation suite, which is the intended behaviour.

## 5. Run it

```bash
pnpm db:migrate
pnpm db:seed          # if the seed needs to populate the new table
```

## 6. Check the grants

`bootstrap.sql` sets default privileges for anything `kasuwa_migrator` creates,
so a normal `CREATE TABLE` needs no explicit grant. If you created the table as
a different role, or added a sequence or function, grant explicitly.

## 7. Prove it is isolated — this is the step that matters

Run the suites:

```bash
pnpm test:integration
pnpm test:isolation
```

The catalogue invariant will catch a missing `ENABLE`, `FORCE` or policy. It
will **not** catch a policy with the wrong predicate — a policy that reads
`tenant_id = tenant_id` passes every structural check and isolates nothing.

So add a real isolation test for the new object: a user in tenant A cannot read,
update or delete a tenant B row, by id and by list, and the same across sibling
programmes. Model it on `repository-isolation.acceptance.test.ts`.

Note that `tests/acceptance/` is lead-owned: your PR touching it needs the
`lead-approved` label, so ask the lead to write or approve that test rather than
adding it quietly.

## 8. Get it reviewed

Run the `migration-reviewer` subagent before opening the PR, and put its verdict
in your completion report.
