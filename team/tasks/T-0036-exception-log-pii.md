# T-0036 — No PII through Nest's exception logger (D-L42)

**owner** Agent 13 · **status** `not-assigned` · **priority** P0 before real users · **deps** none · **budget** 1 session

## Goal
Nest's built-in exception handler logs `exception.message` and the stack trace, and a pg error message can carry row values. That path is outside OpenTelemetry, so the observability PII suite cannot see it. Add a global exception filter that logs only the error class, code and request route template, never `message`, `detail` or stack frames containing values. Extend `collectTelemetry` (in `@kasuwa/testing`) to return span events, so a future `recordException` stays inside the PII grep.

## Acceptance test
`tests/acceptance/platform/exception-log-pii.acceptance.test.ts`

## Done when
The suite passes unmodified; a request that triggers a pg unique violation carrying a PII value leaves that value in no log line, span, span event or response body.
