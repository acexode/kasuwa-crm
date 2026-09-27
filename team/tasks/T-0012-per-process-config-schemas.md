# T-0012 — Per-process environment schemas in `@kasuwa/config`

| Field | Value |
|---|---|
| **id** | T-0012 |
| **status** | `not-assigned` |
| **module** | Cross-cutting |
| **owner** | Agent 1 — Platform & Security |
| **priority** | P2 |
| **PRD refs** | — |
| **dependencies** | none |
| **decisions** | **D-P8** — this task is the answer |
| **budget** | 1 session before escalating |

## Why

`CLAUDE.md` section 4: no `process.env` outside `@kasuwa/config`. The web
process **cannot comply**. `@kasuwa/config` parses a single schema that demands
`DATABASE_URL`, and `apps/web` has none and must never have one — a browser-facing
process holding a database URL is the mistake the rule exists to prevent.

So the rule pushed the one process it most needed to constrain outside itself.
T-0007 worked around it correctly — `NEXT_PUBLIC_API_URL` in `next.config.mjs`,
already lint-exempt, rewritten same-origin so no application code reads the
environment — and raised the gap rather than widening the exemption, which was
the easier move and the wrong one.

**The rule is right; the implementation is too narrow.**

## Scope

1. **A shared base schema** for what every process needs (`NODE_ENV`, log level,
   cell identity).
2. **Per-process schemas over it**: `apiEnv()`, `webEnv()`, `workerEnv()`,
   `realtimeEnv()`. Each parses exactly what its process needs and nothing else.
3. **`webEnv()` must not accept `DATABASE_URL` at all** — not "not require";
   not accept. A schema that tolerates it invites someone to set it.
4. **Fail at boot, in the process that needs it.** A missing `DATABASE_URL`
   should fail the API's startup and be irrelevant to the web build, rather
   than failing everything or nothing.
5. Migrate `apps/web` off `next.config.mjs`'s direct read, and narrow the lint
   exemption to whatever genuinely remains.

## Things to get right

- **`assertAuthModeIsSafe` must keep running.** It is what stops stub auth
  booting under `NODE_ENV=production`, it is called from `parseEnv` today, and
  it must be called from every process schema — not just the API's. A refactor
  that silently drops it from one process is the worst outcome of this task.
- `NEXT_PUBLIC_*` variables are **inlined into the browser bundle** by Next at
  build time. Anything a web schema accepts is public. Say so in the schema,
  next to the fields, not in a README.
- Do not add a dependency for this. Zod is already there.

## Non-goals

- Secret management, key rotation, or anything D-L13 covers.
- Changing what any process currently reads. This is where the parsing lives,
  not what it parses.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/platform/config-schemas.pending.acceptance.test.ts`.

Behaviours they will name:

- `webEnv()` **rejects** `DATABASE_URL` rather than ignoring it
- a missing API-only variable fails `apiEnv()` and does not fail `webEnv()`
- `assertAuthModeIsSafe` runs in every process schema, demonstrated by a stub
  mode + production combination failing in each
- no `process.env` read remains outside `@kasuwa/config` except the narrowed,
  named exemption

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- Next's build-time inlining makes it impossible to keep the web process's
  configuration out of the browser bundle without a server component boundary
  that does not exist yet. That is a finding about the app shell, not about
  config, and it belongs in `DECISIONS.md`.
