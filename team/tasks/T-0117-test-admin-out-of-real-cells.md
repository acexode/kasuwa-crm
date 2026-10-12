# T-0117 — `kasuwa_test_admin` is unusable in a real cell (D-L92, D-L94)

**status** `done` (#114, 2026-10-12) · **owner** Agent 1 · **priority** P0 (before any populated cell) · **decisions**
D-L92, D-L07, D-L65, ADR-0013

## Goal
A real environment's database has no usable test login, and no role whose password is in the repository. **D-L94 replaces the
original "absent" plan below**: the role stays as an inert placeholder, because 14 applied migrations grant to it.
- **Split the bootstrap.** `packages/db/sql/bootstrap.sql` (applied by real provisioning, docker-compose and Testcontainers)
  stops creating `kasuwa_test_admin` and stops naming it in grants and default privileges. A new
  `packages/db/sql/bootstrap-test.sql` creates it and grants what the harness needs. Only docker-compose's init directory and
  `packages/testing`'s containers apply it.
- **Migrations.** Every migration that names `kasuwa_test_admin` today must keep working where the role is absent: grants to
  it are guarded by a role-exists check, or moved into `bootstrap-test.sql`. Applied migrations are never edited (checksums),
  so this is done forward-only: a new migration, or guards that already exist. List each one and say which.
- **A guard.** The migration runner refuses to run against a database where `kasuwa_test_admin` exists unless the environment
  is development or test (read through `@kasuwa/config`), and says why.
- **Docs.** `packages/db/CLAUDE.md` and the bootstrap header say which file real provisioning applies.

## Acceptance tests
`tests/acceptance/tenancy/test-admin-absent.acceptance.test.ts`, written by the lead: a database bootstrapped with
`bootstrap.sql` alone migrates cleanly to head and has no `kasuwa_test_admin`; with both files, the harness behaves as today;
the runner's guard refuses in a production configuration when the role exists.

## Escalate if
An applied migration cannot run where the role is absent.
