---
name: add-standard-object
description: Add a new first-class CRM object (lead, account, deal, ticket…) end to end — migration, repository, endpoints, tests, i18n. Use when a PRD module introduces a new standard record type.
---

# Add a standard object

A "standard object" is a first-class record type shipped by Kasuwa, as opposed
to a customer-defined custom object (which is M15's metadata engine, a different
job entirely).

`contact` is the worked example in the repository. Read it before starting:
`packages/db/migrations/0001_tenancy_core.sql`,
`packages/domain/core/src/contact/contact.repository.ts`,
`apps/api/src/contacts/contacts.controller.ts`.

## 0. Check it is actually your task

New objects are product surface. If the object is not named in your task file
and its PRD module, stop and raise it. Do not add a table because the code would
be tidier with one.

## 1. Migration

Follow the `create-rls-migration` skill. Do not hand-roll this — the four
common mistakes it lists are the ones that leak data.

## 2. Domain package

The object belongs to exactly one domain package (see `team/ROSTER.md` for who
owns what). If it seems to belong to two, it is probably one object with a
relationship, or your boundary is wrong. Raise it.

```
packages/domain/<module>/src/<object>/
  <object>.types.ts        Zod schemas + inferred types. The boundary contract.
  <object>.repository.ts   Data access. Takes a TenantTx, never a Pool.
  <object>.service.ts      Domain rules, if there are any beyond CRUD.
```

Rules that are not negotiable:

- Repository functions take `TenantTx` as their first argument. There is no way
  to query without one, and that is the point.
- Repeat the `tenant_id` / `programme_id` predicates in the WHERE clause even
  though RLS enforces them. Two independent layers.
- Return `null` for "not found"; let the controller decide the status code.
- Money as minor units plus currency. Dates as `Date`, stored `timestamptz`.

## 3. API surface

```
apps/api/src/<objects>/
  <objects>.controller.ts
```

- `@Controller('api/v1/<objects>')`, `@UseGuards(StubAuthGuard)`,
  `@UseInterceptors(TenantTransactionInterceptor)`. All three, always.
- Parse every input with Zod — params, query and body. No `as`.
- Cursor pagination on list endpoints, with a maximum page size. Reuse
  `encodeCursor`/`decodeCursor`; do not invent a second cursor format, and do
  not put tenant or programme into it.
- Out-of-scope records are `404`, never `403`.
- OpenAPI annotations are mandatory (ADR-0004).
- Register the controller in `apps/api/src/app.module.ts`.

## 4. Events

If other modules need to react to this object, emit through the outbox rather
than calling them. Cross-domain imports are blocked by the boundary lint rule,
and routing around it with an event is the intended answer, not a workaround.

(The outbox does not exist yet — if you need it, that is a dependency to raise,
not something to improvise.)

## 5. i18n

Every user-facing string — object label, plural label, field labels, validation
messages, empty states — goes in `packages/i18n/src/locales/en.json`. The lint
rule fails the build on literal JSX text in `apps/web`.

## 6. Tests

- **Unit**: domain rules, validation, edge cases. In the domain package.
- **Integration**: repository against real Postgres, including pagination
  boundaries and ordering ties.
- **Isolation**: the acceptance suite. Ask the lead — `tests/acceptance/` is
  lead-owned and a PR touching it needs the `lead-approved` label.

The isolation coverage a new object needs, at minimum:

1. A user in tenant A cannot list, read by id, update or delete a tenant B row.
2. A user in programme 1 cannot do the same to a programme 2 row in their own
   tenant (if the object is programme-scoped).
3. A user with no programme membership sees nothing.
4. No query parameter, header or cursor changes which rows are returned.

## 7. Before opening the PR

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Run `tenancy-reviewer` and `migration-reviewer`, and put their verdicts in your
completion report at `team/reports/T-XXXX.md`.
