# T-0114 — Script runs: table and API (P10, manual mode)

**status** `assigned` (suite on `lead/T-0114-acceptance`, D-L104) · **owner** Agent 6 · **priority** P2 · **decisions** D-L88, D-L91, D-L93,
D-L96, D-L102, D-P31, D-P32 · **migration** 0032 (D-L104)

## Goal
An agent can run a published script for a contact by hand, from start to a completion with a disposition, exactly as the
run operations in `docs/api/scripting.openapi.yaml` (T-0112) describe.
- **Table `script_run`** (0027 pattern: RLS ENABLED+FORCED with WITH CHECK = USING, TENANT_SCOPED_TABLES, composite FKs
  RESTRICT to `script_version` and `contact`, D-L76 key guard). Answers classified `sensitive`; a unique partial index on
  in-progress runs (agent, contact, script).
- **`script.run`** in `packages/permissions` for agent, team lead, programme manager and admin; the publish check's
  `SCRIPT_RUN_SET_KEYS` then reads it (the pinning test in T-0113 flips).
- **The nine run operations**, every rule in D-L93: own-agent-only reads and writes (404 for everyone else);
  `completed` only at an end node or a stopped run, otherwise `interrupted`; idempotent start and the supersede rule;
  acknowledgements and answers unaudited; start, supersede and completion audited by outcome, stop reason and ids only;
  completion books the callback task and the `call` activity in its own transaction; branches evaluated on the server
  (`field_withheld`, `sensitive_field`); bounds, NUL and the 256 KiB answers cap; run error details never logged.
- Flip each served operation to `x-kasuwa-implemented: true`.

## Acceptance tests
`tests/acceptance/scripting/script-runs.acceptance.test.ts`, written by the lead.

## Non-goals
Call-bound runs and the call bar (M09); live push; supervisor or QA reads (M11); D-P31 form writes.
