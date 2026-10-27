# T-0025 — Admin API: audit log and audit writer

**owner** Agent 1 · **status** `done` · **priority** P0 · **deps** prep PR · **migration** `0008` · **budget** 2 sessions

## Goal
Build `listAuditEvents`, `getAuditFilterOptions`, `createAuditExport` and `getAuditExport` per `docs/api/admin.openapi.yaml`, plus an audit writer that every `x-kasuwa-audited` write already built calls (roles, `updateProgramme`). This closes D-L38. The `audit_event` table is append-only for `kasuwa_app` (no UPDATE or DELETE grant), with RLS forced. The export itself is audited (CLAUDE.md 6.7). No PII in event payloads beyond what the spec names.

## Acceptance test
`tests/acceptance/admin/audit-api.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all CI gates are green; migration-reviewer, tenancy-reviewer and security-reviewer pass.
