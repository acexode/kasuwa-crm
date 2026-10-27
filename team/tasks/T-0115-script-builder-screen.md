# T-0115 — Script builder screen (P10, admin)

**status** `done` · **owner** Agent 11 · **priority** P2 · **decisions** D-L88, D-L91, D-L93,
D-L96, D-P32, D-L97, D-L102

## Goal
The P10 authoring screens (design `docs/design/P10/Kasuwa Scripting.html`), behind a new flag `crm_scripts` (off by default,
not production-ready), against T-0113's served authoring API.
- **Who:** the admin set (`script.write`), which also edits and publishes compliance wording (D-P32). Anyone else gets a
  real 404 for the screens, and no nav entry.
- **List:** a programme's scripts with draft and published state; keyset paging, no counts.
- **Editor:** the node graph (prompt, question, form, branch, compliance and end nodes) as the contract defines it.
  - Branch conditions pick from the contract's field references; nothing is free text.
  - Form nodes collect answers on the run only. They never write CRM fields (D-P31).
- **Versions:** publish creates an immutable version. The version list is read-only; a draft shows its diff in compliance
  nodes by name.
- **Translations:** `putScriptTranslation` for the design locales.
- **Saves** send `version` plus the changed fields only, and rebase after a 409 (D-L102).
- **Rules:** no UUID printed; i18n everywhere; no colour literals; nothing on the device; the byte budget is measured and
  pinned.

## Acceptance tests
`tests/acceptance/scripting-ui/script-builder.acceptance.test.ts`, `tests/e2e/p10-builder.spec.ts` and
`tests/e2e/support/scripting-mock.ts` (lead, D-L23).
