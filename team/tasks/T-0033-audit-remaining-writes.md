# T-0033 — Audit the writes that landed after T-0025

**owner** Agent 1 · **status** `done` · **priority** P1 · **deps** T-0028 merged · **budget** 1 session

## Goal
Wire the T-0025 audit writer into `updateProgrammeSla`, `updateProgrammeRetention`, `invitePortalUser`, and the disposition writes, if they are marked `x-kasuwa-audited`. One event per successful write, in its transaction; none on refusals. A portal invite records the address only as a redacted change (D-L52). Add an acceptance assertion that every `x-kasuwa-implemented` + `x-kasuwa-audited` operation in the spec writes an event, so a future write cannot ship unaudited.

## Acceptance test
`tests/acceptance/admin/audit-coverage.acceptance.test.ts`

## Done when
Suite passes unmodified in CI; tenancy and security reviewers pass.
