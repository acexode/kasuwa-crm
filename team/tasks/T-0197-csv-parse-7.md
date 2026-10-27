# T-0197 — csv-parse 5 to 7

**id** T-0197 · **status** `assigned` · **owner** Cursor · **priority** P1 (before 2026-12-31) · **module** Worker (imports) ·
**PRD** Phase 3 plan S0; D-L206 · **deps** T-0153 · **budget** 1 session

## Goal

GHSA-8cw4-87c7-c6xx (csv-parse 5.6.0, CVSS 6.9) is fixed, not accepted. `apps/worker` runs csv-parse 7.0.2 or later, the
lockfile has no older copy, and the entry is gone from `osv-scanner.toml`.

## Context

- The only consumer is `apps/worker/src/csv-stream.ts` (options: `bom`, `relax_column_count`, `skip_empty_lines`,
  `max_record_size`; never `columns`). `import-jobs.ts` uses the stream.
- csv-parse 7 keeps a CJS build, but the worker is bundled by esbuild to CJS: confirm `pnpm build` for `apps/worker` and
  that the bundle still runs. If an option changed name or default, keep the worker's behaviour, not csv-parse's new default.
- D-L206 accepted the finding until 2026-12-31 as `runtime-bounded`; delete that entry in this PR.

## Acceptance tests

Committed and failing. Do not edit them. `apps/worker/src/csv-stream.test.ts` must pass unedited.

- `tests/acceptance/platform/csv-parse-7.acceptance.test.ts`

## Non-goals

Changing import limits or CSV behaviour; any zod change (T-0198); any other dependency.

## Definition of done

The named suite passes unmodified; the worker unit tests pass; `osv-baseline` and T-0037 still pass; any dependency change
has a one-line justification in the PR; `team/reports/T-0197.md`.
