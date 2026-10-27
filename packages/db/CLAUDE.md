# CLAUDE.md — @kasuwa/db

> **Owner:** Agent 1 — Platform & Security
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Schema, migrations, RLS policies, the tenant session primitive, the migration runner and the seed.

## Invariants

1. `withTenantTransaction` is the ONLY sanctioned way to query. It opens a transaction, sets the RLS GUCs transaction-locally, and resolves programme scope from `user_programme`. There is no unscoped pool and no admin connection.
2. Scope is RESOLVED, never SUPPLIED. If a caller can pass its own `programmeIds`, the model is broken. The header-forgery acceptance tests exist to catch that regression.
3. The migrations in `migrations/*.sql` are the source of truth. `src/schema.ts` is a typed mirror (ADR-0006). Never generate migrations from the schema — RLS policies, FORCE and grants have no Drizzle representation and would be silently dropped.
4. Migrations are append-only. The runner rejects a changed checksum on an applied file. Expand -> migrate -> contract.
5. Every table: `tenant_id`, RLS ENABLED **and** FORCED, a policy whose `WITH CHECK` matches its `USING`, and an entry in `TENANT_SCOPED_TABLES`.
6. `kasuwa_app` has no BYPASSRLS and owns nothing. `kasuwa_migrator` owns the schema and never serves traffic. Nothing in `apps/` may open a pool with the migration URL.
7. The `user` table name is a reserved word. Quote it in every hand-written SQL statement.

8. `kasuwa_sweeper` (D-L66, ADR-0012) is the one role `kasuwa_app` can enter, and only `pruneAuthTables` does. Membership is `INHERIT FALSE, SET TRUE`: never inherit it, and never grant it more than DELETE and column-level SELECT on the three auth tables (migration 0020 asserts both). Because any SQL on a `kasuwa_app` connection *could* `SET ROLE` to it, `withTenantTransaction` and `withAuthTransaction` treat the role as part of the verified scope (`current_user = session_user` at start and at commit) and `releaseClean` resets the role before a connection returns to the pool. Any new helper that runs caller-supplied SQL on a pooled connection must do the same.

9. `kasuwa_auth` (D-P16, T-0049, ADR-0013) is the ONLY role that may write the auth tables: `auth_session`, `auth_challenge`, `user_credential`, `user_mfa_factor`, `user_mfa_backup_code` and `auth_rate_limit`. It is NOBYPASSRLS, a member of no role, and no role is a member of it. Its grants are explicit and narrow (UPDATE on named columns only), and migration 0024 asserts every one of them. Since migration 0046 (T-0157) `kasuwa_app` also has no SELECT on `user_credential`, and only the non-secret columns of `user_mfa_factor` and `user_mfa_backup_code` (a table-level REVOKE then a column GRANT, because the default privileges grant table-level SELECT and a column REVOKE does nothing against it). **A new auth table must be revoked from `kasuwa_app` and granted to `kasuwa_auth` explicitly, in its own migration, with the same assertions.** Do not rely on defaults: `bootstrap.sql`'s default privileges still give `kasuwa_app` SELECT, INSERT, UPDATE and DELETE on every future table, and name `kasuwa_auth` nowhere, on purpose. Never add `kasuwa_auth` to an `ALTER DEFAULT PRIVILEGES`, never make it a member of anything, and never grant it a SECURITY DEFINER function other than `app.resolve_tenant_by_slug`.

10. `kasuwa_test_admin` (D-L92, D-L94, T-0117) is the harness's BYPASSRLS login, and **only** the harness's. Applied migrations grant to it by name, so it exists everywhere, but `sql/bootstrap.sql` creates it as an **inert placeholder**: NOLOGIN, NOBYPASSRLS, NOINHERIT, no password, a member of nothing and with no members, and named in no grant or default privilege there. `sql/bootstrap-test.sql` makes it the login, and only docker-compose's init directory (and `pnpm dev`) and `packages/testing` apply it. Outside development and test, `runMigrations` refuses a database where the role is usable (LOGIN, BYPASSRLS, any other role power, or any membership in either direction), and so do the API and the worker at boot (`refuseUsableTestAdminAtBoot`, on the app pool). The one exemption: a membership in the role with neither SET nor INHERIT (ADMIN-only, in PostgreSQL 16's `pg_auth_members`) whose member is SUPERUSER or CREATEROLE, the shape managed Postgres records for its provisioning admin, which could make the role usable anyway. An ADMIN-only membership held by any other role, login or not, is refused: ADMIN OPTION lets the holder `GRANT kasuwa_test_admin TO` itself `WITH SET TRUE` and then `SET ROLE` (T-0117 security review M1). `runMigrations` also refuses, before connecting: an unset NODE_ENV unless the connection string itself names a local host (a URL naming no host is NOT local, whatever PGHOST or pg's default would say; a loopback tunnel such as cloud-sql-proxy or `kubectl port-forward` is a documented limit, which the API and worker boot checks catch at the next deploy); and, outside development and test, any environment variable whose name starts with `PG` (PGHOST, PGPASSWORD, PGUSER, PGPASSFILE, PGOPTIONS, PGPORT, PGSSLMODE and the rest) or NODE_PG_FORCE_NATIVE, or a connection whose effective password (as `pg-connection-string` parses it: `?password=` overrides and percent-encoding included, compared after SASLprep as pg's SCRAM does) is one of the repository's dev passwords (the superuser's `postgres` included). `apiEnv` and `workerEnv` refuse the last two too, and refuse an unset NODE_ENV outright (D-L95): dev and test entry points set it per process (`tools/dev.mjs`, the e2e harness, vitest), never in `.env`. Known limit: a default `~/.pgpass` file (no PGPASSFILE) is not inspected, so a dev password stored there is not detected. Never give the test role a grant in `bootstrap.sql`; if the harness needs more, it goes in `bootstrap-test.sql`.

11. `kasuwa_relay` (ADR-0018, D-L156, T-0098) is the outbox relay's LOGIN role, used only by apps/worker's relay and sweep through their own pool (`DATABASE_RELAY_URL`, max 2), and by `relayOutboxBatch`, `sweepOutbox` and `readOutboxBacklog` in this package, each of which refuses to run unless `current_user` and `session_user` are both `kasuwa_relay`. It is LOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE and NOREPLICATION; a member of no role, and no role is a member of it. **Unlike the sweeper, it is never granted to `kasuwa_app`**, so no injected `SET ROLE` on an app connection reaches it (the ADR-0013 reasoning). It owns nothing; `sql/bootstrap.sql` gives it CONNECT and USAGE on `public` only (never on `app`: its policies call no accessor). Migration 0041 gives it, on `outbox_event` alone, SELECT, DELETE and UPDATE on (`published_at`, `attempts`, `last_attempt_at`, `dead_at`); no INSERT (it cannot forge an event), nothing on any other relation, sequence or function, and asserts all of that at migrate time, failing loudly if bootstrap has not created the role. Its three policies are `TO kasuwa_relay` and admit only undispatched rows, rows it marked in the current transaction (`published_at = now()` or `dead_at = now()`, D-L156), and rows past retention (7 days published, 30 days dead); its UPDATE's WITH CHECK requires both timestamps to be NULL or exactly `now()`, so nothing can be back-dated into retention. **Never add `kasuwa_relay` to an `ALTER DEFAULT PRIVILEGES`, never grant it anything outside `outbox_event`, never make it a member of anything, and never put `DATABASE_RELAY_URL` in the shared `.env`**: the API, realtime, web and the operator commands refuse the variable by presence, and `tools/dev.mjs` hands it to the worker alone. The retention windows live in both the policies and `sweepOutbox`: change both.

## Which bootstrap file runs where (T-0117)

| File | Applied by | Never applied by |
|---|---|---|
| `sql/bootstrap.sql` | real provisioning, docker-compose's init directory (`10-`), `pnpm dev` (re-applied), `packages/testing` | |
| `sql/bootstrap-test.sql` | docker-compose's init directory (`20-`, after the first), `pnpm dev` (re-applied), `packages/testing` | **real provisioning**, ever |

Both run as the superuser, before any migration, and both are idempotent. `bootstrap.sql` leaves an existing role alone, so it never undoes `bootstrap-test.sql` on a dev volume and never resets a password provisioning set.

## Upgrading a database bootstrapped before a role was added

`sql/bootstrap.sql` runs only when the Postgres volume is first created (docker-compose init directory) or when Testcontainers starts a fresh container. A role added to it later — `kasuwa_sweeper` in T-0045, `kasuwa_auth` in T-0049, `kasuwa_relay` in T-0098 — does not exist in an older local database, and the migration that needs it stops with a message saying so (0020, 0024 and 0041 do). Fix, either:

- re-apply the bootstrap, which is idempotent, as the superuser:
  `docker exec -i kasuwa-postgres psql -U postgres -d kasuwa -v ON_ERROR_STOP=1 < packages/db/sql/bootstrap.sql`
  (and, on a DEV database only, the same with `packages/db/sql/bootstrap-test.sql`; `pnpm dev` does both)
  then `pnpm db:migrate`; or
- drop the dev database volume and start again: `pnpm dev:down`, then `docker volume rm <project>_kasuwa-pgdata` (find the exact name with `docker volume ls`; the prefix is the compose project, normally the checkout's directory name), then `pnpm dev`.

Real environments apply `sql/bootstrap.sql`, and only that file, through their own provisioning before migrating. Create `kasuwa_migrator`, `kasuwa_app`, `kasuwa_auth` and `kasuwa_relay` with their secrets-manager passwords first; the bootstrap's `IF NOT EXISTS` then leaves each password alone and only asserts the role's attributes. If provisioning forgets, the roles get the repository's dev passwords, and the runner, the API and the worker refuse to run on them outside development and test (D-L94). Never apply `sql/bootstrap-test.sql` to a real cell.

Use the `create-rls-migration` skill. Run `migration-reviewer` before opening a PR.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
