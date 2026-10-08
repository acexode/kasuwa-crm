# T-0113 — Script authoring: tables and API (P10, manual mode)

**status** `not-assigned` (suite to be written) · **owner** Agent 6 · **priority** P2 · **decisions** D-L88, D-L91, D-L93,
D-P31, D-P32, D-L13, D-L89 · **migration** 0030 reserved

## Goal
An admin can write a script for a programme, translate it, and publish an immutable version, exactly as
`docs/api/scripting.openapi.yaml` (T-0112) describes for the authoring operations.
- **Tables (migration 0030):** `script` and `script_version`, in the 0027 pattern. RLS ENABLED+FORCED with WITH CHECK
  identical to USING; `TENANT_SCOPED_TABLES`; composite FKs RESTRICT to `programme`; the D-L76 allow-list key guard;
  `script_version` immutable once published (a trigger, no role exempt). The graph is Zod-validated jsonb with the 256 KiB
  cap (D-L93).
- **API:** listScripts, createScript, getScript, updateScript, listScriptVersions, publishScript, getScriptVersion and
  putScriptTranslation. Flip each served operation to `x-kasuwa-implemented: true`.
  - `script.write` (the admin set) to read or write; everyone else gets 404 (D-L91).
  - Publish runs the completeness checks in linear time, and refuses `branch_on_withheld_field` and `sensitive_field`
    (D-L93).
  - The publish audit names the compliance nodes added, removed or changed.
  - `no-store` comes from the shared middleware.
- **`listProgrammeScripts`** (admin) is backed by the new tables and gated on `script.write` (404 otherwise).
- A new `script.write` permission in `packages/permissions`. Do NOT add `script.run`: that is T-0114's.

## Acceptance tests
`tests/acceptance/scripting/script-authoring.acceptance.test.ts`, written by the lead. The T-0112 contract suite must still
pass.

## Non-goals
Runs (T-0114); the builder screen (T-0115); D-P31 form writes; anything call-bound.
