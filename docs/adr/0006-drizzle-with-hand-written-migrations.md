# ADR-0006 — Drizzle as a typed query builder; migrations are hand-written SQL

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Lead agent (recommendation), @acexode (accepted)
- **Source:** Decision D-L04; founding pack 3.2 leaves the choice open

## Context

The founding pack says "Drizzle or Kysely (SQL-first) + raw SQL for the metadata
engine". Either works. The question that actually matters is not which library
but **what owns the schema**, because Kasuwa's schema carries security
semantics — RLS policies, `FORCE ROW LEVEL SECURITY`, grants, composite foreign
keys — that no TypeScript schema DSL can express.

## Decision

Drizzle for schema types and repository queries. **Migrations are hand-written
SQL and are the source of truth.** `drizzle-kit generate` is not used.

`packages/db/src/schema.ts` is a typed *mirror* of the migrations, and says so at
the top. The migration runner (`packages/db/src/migrate.ts`) is ~120 lines:
filename-ordered, one transaction per file, sha256-checksummed, advisory-locked.

Drift between mirror and migrations is caught by the catalogue invariant in the
isolation suite, which asserts that the set of tables in the database exactly
matches `TENANT_SCOPED_TABLES` and that each has RLS enabled, forced and
policied.

For the metadata engine's genuinely dynamic SQL (M15), raw parameterised SQL is
expected, and adopting Kysely there as a query builder only is open and would
not disturb this decision.

## Consequences

**Good.** RLS policies cannot be silently dropped by a regenerated migration —
which, given ADR-0002, is the failure mode with the worst blast radius. Reviewers
read the SQL that will actually run. The runner is small enough to audit.

**Bad.** The schema exists in two places and can drift; the catalogue invariant
catches structural drift but not, say, a column type that differs between mirror
and migration. Writing migrations by hand is slower and more error-prone than
generating them, which is why `migration-reviewer` exists.

**Constraint.** Migrations are append-only. The runner refuses to proceed when an
already-applied file's checksum changes, so expand → migrate → contract is
enforced rather than merely recommended. Line endings are normalised before
hashing, because the team develops on Windows and CI runs on Linux.
