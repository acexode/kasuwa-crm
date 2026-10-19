# docs/api — published HTTP contracts

Specs live here when another agent has to build against an endpoint that does
not exist yet. They are committed **before** the implementation, on their own,
so that a front-end task is not blocked waiting for a back-end task to merge.

| Spec | Owner | Task | Consumers |
|---|---|---|---|
| `auth.openapi.yaml` | Agent 1 — Platform & Security | T-0001 | T-0007 (P01 auth screens) |
| `admin.openapi.yaml` | Agent 1 — Platform & Security | T-0021 | P02 (22 admin-console screens) |
| `records.openapi.yaml` | Agent 3 — Core CRM records | T-0039 | T-0041 (contacts API), T-0042 (P04 Contacts list) |
| `scripting.openapi.yaml` | Agent 6 — Contact-Centre Integration | T-0112 | T-0113, T-0114 (scripts and runs APIs), T-0115, T-0116 (P10 screens) |

## What a browser sees: the BFF's variance from `auth.openapi.yaml` (ADR-0019)

The specs describe the API as any client calls it, with `Authorization: Bearer`. A browser never does: the web app's
route handler at `/api/v1/*` (T-0125, ADR-0019) is its only door, and it differs from the specs in exactly these ways.

- **`POST /auth/mfa` and `POST /auth/mfa/enrol/confirm`.** On a 200 the BFF puts `accessToken` into the HttpOnly
  `__Host-kasuwa_session` cookie (`Max-Age` until `expiresAt`) and removes `accessToken` and `tokenType` from the
  body. The browser receives `{ expiresAt, user }` (plus `backupCodes` on enrolment confirm), never the token. An
  answer that does not parse is a 502.
- **`POST /auth/sign-out`.** Clears the cookie and sends `Clear-Site-Data: "cache"` whatever the API answered.
- **Any 401** from a route that needs a session clears the cookie. The body is the API's, verbatim.
- **Every unsafe method** must carry `Origin` equal to the web origin, `x-requested-with: kasuwa-web`, and (with a
  body) `Content-Type: application/json`; otherwise `403 { code: "csrf_rejected" }`, before the API is reached.
- **A scope header** is the API's own `400` (`scope_header_not_accepted`), before the API is reached.
- **A top-level navigation** to `/api/*` is the API's unknown-route `404`.
- **Every answer** carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; a JSON body over 1 KB is gzipped.
- An unreachable API is `502` with the `internal_error` code.

Non-browser clients (tests, integrations, a future mobile app) call the API directly with Bearer and see the specs
exactly as written.

## Running a mock server

No dependency is added for this; run it ad hoc.

```bash
npx @stoplight/prism-cli mock docs/api/auth.openapi.yaml --port 4010
npx @stoplight/prism-cli mock docs/api/admin.openapi.yaml --port 4011
npx @stoplight/prism-cli mock docs/api/records.openapi.yaml --port 4012
npx @stoplight/prism-cli mock docs/api/scripting.openapi.yaml --port 4013
```

Prism serves the `example` on each response, which is why every failure in the
spec has a concrete example rather than a description of one.

To get a specific failure back from the mock rather than the happy path, ask
for it by status and example name:

```bash
curl -sS http://localhost:4010/api/v1/auth/mfa \
  -H 'content-type: application/json' \
  -H 'Prefer: code=401, example=expired' \
  -d '{"challengeId":"7d2b2e14-9f4a-4a0e-8b1f-0c2a6d5e4f31","code":"000000"}'
```

### The admin console specifically

`admin.openapi.yaml` is the contract for all 22 P02 screens. **Generate the
mock from it; do not hand-write one.** A hand-written mock drifts silently and
the wiring step then finds 22 screens built against a fiction — which is why an
acceptance test asserts the mock is generated.

Almost every operation in it is `x-kasuwa-implemented: false` today, so Prism's
`example` is the only data behind those screens, and the file's examples are
written to be the ones the design shows. Every screen id in
`docs/design/P02/MANIFEST.md` appears in at least one `x-kasuwa-screens`; if you
find a screen that needs a shape that is not there, that is a change to the
contract, which is a message (see the last section), not a local workaround.

Three behaviours the mock will not teach you, because they are policy rather
than payload:

- **Scope is resolved, never supplied.** No operation takes `programmeIds` or a
  tenant argument. A `{programmeId}` in a path is a record identifier.
- **A record outside your scope is `404`, not `403`.** Build the out-of-scope
  case as "not found". `403 not_permitted` means only "you can read it and you
  may not do *this* to it".
- **`PUT /field-security/matrix` returns `501` and will keep doing so**, because
  its semantics depend on a decision nobody has taken (tenant-wide versus
  per-programme grants). Build the screen; do not wire the save. Ask the mock
  for the success shape with `Prefer: code=200`.

Two ad-hoc checks, neither of which needs a dependency in the repo:

```bash
# parses, and every $ref resolves
npx @redocly/cli lint docs/api/admin.openapi.yaml
npx @redocly/cli lint docs/api/records.openapi.yaml
npx @redocly/cli lint docs/api/scripting.openapi.yaml

# a specific failure rather than the happy path
curl -sS 'http://localhost:4011/api/v1/admin/roles/hierarchy' -X PUT \
  -H 'content-type: application/json' \
  -H 'Prefer: code=409, example=cycle' \
  -d '{"version":11,"moves":[]}'
```

## Reading the spec

- `x-kasuwa-implemented` on each operation says whether the endpoint is real
  yet: `true`, `partial` or `false`. A `false` operation is published so the
  screen can be built; it is not wired.
- `x-kasuwa-screens` names the design ids the operation serves, so a screen and
  its error states can be traced to concrete response bodies.
- `x-kasuwa-audited: true` (admin spec only) marks an operation that must write
  an audit row when it is implemented. Guardrail 6.7 is not satisfied by a
  comment, and an operation carrying this flag with no audit row is a review
  finding.
- Switch on `error.code`, never on `error.message`. `message` is an English
  fallback; the web app localises from the code as `auth.error.<code>`,
  `admin.error.<code>`, `records.error.<code>` or `scripting.error.<code>`.

## When the contract changes

The spec is the interface between two agents working in parallel, so a change
to it is a message, not a commit. Change it in its own commit, say exactly what
moved, and tell the lead — somebody has already built a screen against the old
shape.
