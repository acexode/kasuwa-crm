# T-0158 — `GET /me/capabilities`, and the web uses it (T-0079)

**id** T-0158 · **status** `assigned` · **owner** Cursor · **priority** P0 (S2 and S4 need it) · **module** Auth, web ·
**PRD** M02; D-L84 · **deps** T-0152 · **tier** Combined · **budget** 3 sessions

## Goal

The API says what the caller may DO, and the web stops drawing write controls the API would answer 403 to. A non-writer
cannot open the script builder.

## Context

- New operation `getMyCapabilities` in `docs/api/auth.openapi.yaml`: `GET /api/v1/me/capabilities`, tag `me`, closed
  shape `{ tenant: {admin, can[]}, programmes: [{id, can[]}] }`, `can` sorted, `no-store`, 200 or 401. It lives on
  `MeController`; compute it from `loadGrants` in `packages/permissions` (a `listCapabilities(grants)` helper with a unit test).
  Amend the `auth.openapi.yaml` header and `apps/api/CLAUDE.md` invariant 7, which say auth carries no scope: this is
  the one new, scoped read, and is a contract change the plan approves.
- Web: a small `lib/capabilities-api.ts` (zod) and a per-session cache, used by the accounts, account record, leads
  convert, activity composer, deals board and Studio controls, and by `/scripts`. No new flag: it rides the existing
  screen flags. Strings via `@kasuwa/i18n`. Update the `productionReady` comments that cite T-0079; flipping them is the lead's call.
- **E2E, flagged in the PR (the lead re-pins):** `@p04-accounts-writers` and `@p10-builder-access-404` are empty
  `test.fixme` bodies in `p04-accounts.spec.ts` and `p10-builder.spec.ts`. Filling them changes pinned specs, and every
  per-screen mock that serves `/auth/me` needs a `getMyCapabilities` answer, which changes pinned mocks.
- **Decided here:** a real HTTP 404 for `/scripts` needs a server-side read, but e2e mocks (`page.route`) only reach the
  browser. So the builder renders the existing client-side not-found (identical to a missing script) when the read says
  `script.write` is absent, and the spec asserts that, not an HTTP status. Say so in the PR.

## Acceptance tests

Committed and failing. Do not edit them.

- `tests/acceptance/permissions/me-capabilities.acceptance.test.ts`
- e2e tags, through `tools/e2e-locked.sh`: `@p04-accounts-writers`, `@p10-builder-access-404`.

## Non-goals

Programme names (`listMyProgrammes` has them); caching capabilities beyond one session; changing any permission.

## Definition of done

Named suite green; CI green; generated auth mock regenerated; `team/reports/T-0158.md` lists every mock and spec touched
so the lead can re-pin.
