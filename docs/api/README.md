# docs/api — published HTTP contracts

Specs live here when another agent has to build against an endpoint that does
not exist yet. They are committed **before** the implementation, on their own,
so that a front-end task is not blocked waiting for a back-end task to merge.

| Spec | Owner | Task | Consumers |
|---|---|---|---|
| `auth.openapi.yaml` | Agent 1 — Platform & Security | T-0001 | T-0007 (P01 auth screens) |

## Running a mock server

No dependency is added for this; run it ad hoc.

```bash
npx @stoplight/prism-cli mock docs/api/auth.openapi.yaml --port 4010
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

## Reading the spec

- `x-kasuwa-implemented` on each operation says whether the endpoint is real
  yet: `true`, `partial` or `false`. A `false` operation is published so the
  screen can be built; it is not wired.
- `x-kasuwa-screens` names the design ids the operation serves, so a screen and
  its error states can be traced to concrete response bodies.
- Switch on `error.code`, never on `error.message`. `message` is an English
  fallback; the web app localises from the code as `auth.error.<code>`.

## When the contract changes

The spec is the interface between two agents working in parallel, so a change
to it is a message, not a commit. Change it in its own commit, say exactly what
moved, and tell the lead — somebody has already built a screen against the old
shape.
