# T-XXXX — <short imperative title>

<!--
Written by the LEAD, from the PRD, before the task is assigned.
Acceptance tests are committed and failing before a builder starts.
Copy this file, do not edit it in place.
-->

| Field | Value |
|---|---|
| **id** | T-XXXX |
| **status** | `not-assigned / assigned / in-progress / blocked / done` |
| **module** | M<nn> — <name> |
| **owner** | Agent <n> — <role> |
| **priority** | P0 / P1 / P2 |
| **PRD refs** | `docs/prd/M<nn>-<slug>.md` section <n>; US-<n> AC<n> |
| **dependencies** | T-XXXX, or "none" |
| **decisions** | Open decisions this task depends on, or "none" |
| **budget** | Max <n> sessions before escalating |

## Goal

One paragraph. What must be true when this is done, in terms a supervisor on a
Lagos floor would recognise — not in terms of files changed.

## Context

- Packages and files involved: `packages/...`, `apps/...`
- Related ADRs: `docs/adr/...`
- Prior art in the repo: point at the closest existing pattern to copy.
- Anything surprising about this area that would otherwise cost a session to
  discover.

## Acceptance tests

Already committed and currently **failing**. Do not edit these files.

- `tests/acceptance/<area>/<name>.acceptance.test.ts`

## Non-goals

Be specific. This section exists to stop scope creep, so name the adjacent
things that are *not* in scope and say which task or agent owns them instead.

## Definition of done

- [ ] Named acceptance tests pass, unmodified
- [ ] Unit tests added; they fail without the change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`,
      `pnpm test:isolation` pass
- [ ] OpenAPI updated (if a controller changed)
- [ ] i18n keys added (if user-facing strings were added)
- [ ] Migration reviewed by `migration-reviewer`; every new table in
      `TENANT_SCOPED_TABLES` with RLS enabled, forced and policied
- [ ] ADR written if architecture changed
- [ ] Completion report at `team/reports/T-XXXX.md`
- [ ] PR ≤ ~600 lines, or split, with a description naming the task id

> **Before setting `status` to `assigned`:** the acceptance tests named above
> must exist and fail for a real reason. `tools/verify-task-readiness.mjs`
> fails CI otherwise. See `team/DECISION-LOG.md` D-L23.

## Escalate if

- An open decision blocks you — name it, stop, do not guess.
- An acceptance test looks wrong — say so, do not edit it.
- You exceed the budget above.
