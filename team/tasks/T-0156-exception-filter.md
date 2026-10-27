# T-0156 — A global exception filter that never logs `exception.message` (D-L42)

**id** T-0156 · **status** `done` · **owner** Cursor · **priority** P2 · **module** API ·
**PRD** observability; D-L42 · **deps** none · **tier** Combined

## Outcome: already delivered as T-0036
The Phase 3 plan listed this as new work because D-L42 still reads `OPEN` in `team/DECISIONS.md`. It is not open:
- `apps/api/src/common/unexpected-error.filter.ts` (T-0036) is registered globally in `app.module.ts` through `APP_FILTER`. It
  answers one fixed 500 body and logs only the error class, the SQLSTATE or system code and the route template.
- `collectTelemetry` in `@kasuwa/testing` returns span events (`packages/testing/src/telemetry.ts`), with a unit test.
- `tests/acceptance/platform/exception-log-pii.acceptance.test.ts` is the probe-grep suite, and `team/reports/T-0036.md` exists.

## What this PR does
Nothing to build. The acceptance suite the plan named (`exception-filter.acceptance.test.ts`) would duplicate the one above, so it
is not written. The lead should set D-L42 to closed (T-0036) and T-0036's task file to `done`; both are lead-owned.
`team/reports/T-0156.md` records the evidence.
