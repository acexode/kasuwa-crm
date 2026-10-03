# CLAUDE.md — @kasuwa/permissions

> **Owner:** Agent 1 — Platform & Security
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Permission policy engine (M2). Built in T-0032 to the model in `team/DECISIONS.md` D-L53:
`policy.ts` is the pure decision, `grants.ts` loads its inputs inside the request's tenant
transaction. Covers the admin API's writes today; field- and record-level decisions are a
later task.

## Invariants

1. Tenancy (which tenant and programme a session can reach) is NOT this package. That is RLS plus `packages/db`. This package answers "may this session do this", which is a different question with a different failure mode.
2. A permission never widens scope (D-L06). Every programme decision first requires the programme to be in the session's resolved scope, tenant admin included.
3. Grants are re-read from the database on every decision. Never cache them in the token, the session object or process memory.
4. Tenant admin is `"user".is_tenant_admin`, never derived from membership. A set grants programme-scoped actions only, through the allow-list in `policy.ts`; an unlisted set grants nothing.
5. The caller answers 404 for an unreachable record BEFORE asking this package, so a 403 never confirms existence.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
