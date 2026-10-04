# T-0044 — Migration runner: a marked non-transactional mode

**status** `not-assigned` (builder running: Agent 1, `agent1/T-0044-runner-no-transaction`; suite on `lead/T-0044-acceptance` f9d07ec) · **owner** Agent 1 · **priority** P1 (must land before the first populated cell, D-L65) · **decisions** D-L65

## Goal
`packages/db/src/migrate.ts` always wraps a file in BEGIN/COMMIT, so `CREATE INDEX CONCURRENTLY` and similar
statements are impossible. Add an explicit, narrow opt-out:
- A migration marked `-- kasuwa:no-transaction` on its first line runs without a wrapping transaction.
- A marked file may contain only statements that are safe outside a transaction: `CREATE/DROP INDEX CONCURRENTLY`
  and `ALTER TABLE ... VALIDATE CONSTRAINT`. The runner refuses anything else.
- Checksum, ordering and record-keeping are unchanged.
- If a marked file fails, the runner records nothing and the file can be re-run. Document how to clean up an
  INVALID index left behind by a failed `CONCURRENTLY`.
- Update the `create-rls-migration` skill to point at this mode.

## Acceptance tests
`tests/acceptance/platform/migration-runner.acceptance.test.ts`, written by the lead.
