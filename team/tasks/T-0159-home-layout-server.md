# T-0159 — Home layout on the server (D-L196)

**id** T-0159 · **status** `assigned` · **owner** Cursor · **priority** P1 · **module** Records, web ·
**PRD** M16 (P03); D-L196, D-L204 · **deps** none · **tier** Full · **flag** `home_layout_server` · **budget** 3 sessions

## Goal

The P03 Home layout is stored per user on the server, not in localStorage, behind the unchanged `HomeLayoutStore`
interface in `apps/web/components/home/layout-store.ts`. The browser store stays as the flag-off path.

## Context

- **Migration 0045** (decided here; T-0157's grants migration takes the next number). Table `home_layout`: `tenant_id`,
  `user_id`, `role` (rep, manager, support, bpo, exec), `items jsonb` (array, at most 19), timestamps with the
  `app.touch_updated_at()` trigger, primary key `(tenant_id, user_id)`, composite FK to `"user"` and FK to `tenant`, both
  `ON DELETE CASCADE ON UPDATE RESTRICT`. One `FOR ALL TO kasuwa_app` policy: `tenant_id = app.current_tenant_id() AND
user_id = app.current_user_id()`, identical `WITH CHECK`. Grants: SELECT, INSERT, UPDATE (role, items, updated_at), DELETE.
  No `programme_id`, with a comment saying why. Copy `0044_notification.sql` and `0014_admin_alert.sql`; add the table and
  `TENANT_SCOPED_TABLES` entry in `schema.ts`; use the `create-rls-migration` skill and `migration-reviewer`.
- Three operations in `records.openapi.yaml` (tag `me`, `x-kasuwa-implemented`, `no-store`): `getHomeLayout` (404 when none),
  `putHomeLayout`, `deleteHomeLayout`. **The third is decided here** (Reset needs it): see the suite header.
- Controller beside `MeController`, repository in `packages/domain/core`, zod at the boundary (the widget list is the one in
  `home-model.ts`; keep one copy and import it, or pin both with a test).
- Flag `home_layout_server` (off by default, `productionReady: false`), registered in `flags.test.ts`, regenerate `team/FEATURES.md`,
  add to `tools/demo.mjs`. It picks the store in `home-screen.tsx`; no client module names the flag.
- **E2E, flagged in the PR:** a new `tests/e2e/p03-home.spec.ts` tagged `@p03-home`. `crm_home` is on no e2e web process, so
  `run-e2e.mjs` needs a Home process. **Decided here:** a separate process started only when the grep selects `@p03-home`
  (like the notifications one), in `jwt` mode with a real sign-in, so the p26 suite's one-process-per-flag-set check stays true.
  That edits `run-e2e.mjs` and `support/stack.ts`; the lead re-pins anything they pin.
- No migration of existing localStorage layouts (decided: not worth it).

## Acceptance tests

Committed and failing. Do not edit them.

- `tests/acceptance/records-ui/p03-home-layout.acceptance.test.ts`
- e2e tag, through `tools/e2e-locked.sh`: `@p03-home` (new).

## Non-goals

Role-based default layouts (S2); any widget change; drag and drop.

## Definition of done

Named suite green; CI green; migration reviewed; `@p03-home` green locally; `team/reports/T-0159.md`.
