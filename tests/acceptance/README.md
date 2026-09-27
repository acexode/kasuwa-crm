# tests/acceptance

**These tests are owned by the lead agent and are blocking in CI.**

Addendum A1 section 3.3, principle 3: acceptance tests are written before a task
is assigned, from the PRD, by the lead. Builders cannot make them pass by
editing them. CI fails if any file in this directory changes in a pull request
that is not labelled `lead-approved`, and `.claude/hooks/` refuses edits here
outside the lead's session.

If a test here looks wrong to you, say so in your completion report. Do not
change it.

## What lives here

| Directory | Covers | Written from |
|---|---|---|
| `tenancy/` | Tenant and programme isolation across API, repository, URL and cursor surfaces | Founding pack 3.3, PRD US-1 AC2 |

## Conventions

- Files end in `.acceptance.test.ts` and run in the `isolation` vitest project.
- They use the seeded fixtures from `@kasuwa/db` (`packages/db/src/fixtures.ts`),
  never data they create inline, so a failure names a row you can go and look at.
- Tests that write must reseed afterwards.
- An isolation test asserts what a caller **cannot** reach. A test that only
  asserts the happy path is not an isolation test.
