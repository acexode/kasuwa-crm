# T-0121 — Every API answer carries the error envelope and `no-store`

**status** `done` · **owner** Agent 1 · **priority** P2 · **decisions** D-L90, D-L96, D-L97

## Goal
No answer the API gives, however malformed the request, escapes the shared Error envelope or `Cache-Control: no-store`.
- **Body-parser failures:** a malformed JSON body (400) and an over-limit body (413) are mapped to the shared envelope with
  a stable `code` and no echo of the input (V8's parse message names a position in the caller's text).
- **Path decode failures:** a malformed `%`-encoding in any path parameter (Express's "Failed to decode param") is the
  route's own 404 or 400 body, not Express's.
- **`no-store` on all of the above**, installed before the body parser.
- **The urlencoded no-op** (T-0113) sets its function name explicitly, so a bundler rename cannot reinstall the real parser.
  Add a production-bundle smoke test.
- **Optional:** scope the 512 KiB JSON limit to `/api/v1/scripts` and keep 100 KB elsewhere. That needs `express` as a direct
  dependency, so it is a decision; raise it.

## Acceptance tests
`tests/acceptance/platform/error-envelope.acceptance.test.ts`, written by the lead.
