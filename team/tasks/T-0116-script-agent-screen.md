# T-0116 — Agent script screen, manual mode (P10)

**status** `done` · **owner** Agent 11 · **priority** P2 · **decisions** D-L88, D-L93, D-L104,
D-L107, D-P31, D-L97, D-L102

## Goal
The P10 agent screen (design `docs/design/P10/Kasuwa Scripting.html`), behind `crm_scripts`, against T-0114's served runs
API. Manual mode only: there is no call bar, screen-pop or wrap-up until M09 (D-L88).
- **Start:** from the contact record, offer the contact's runnable scripts (`listContactScripts`), then start the run, or
  resume an in-progress one (the idempotent 200).
- **Run:**
  - each node rendered as the server sends it, advanced on the server;
  - compliance nodes acknowledged;
  - form answers recorded on the run only (D-P31);
  - a stop on a withheld or sensitive field shown as a message, never a guess.
- **Complete:** a mandatory live disposition (paged list); a follow-up task when the disposition requires one; the
  interrupted outcomes.
  - A 409 re-reads the run.
  - An exact repeat of a completion is a success, not an error.
- **Rules:**
  - no UUID printed;
  - answers never stored on the device or logged;
  - i18n everywhere;
  - no colour literals;
  - no offline writes;
  - the byte budget is measured and pinned.

## Acceptance tests
`tests/acceptance/scripting-ui/script-agent.acceptance.test.ts`, `tests/e2e/p10-agent.spec.ts`, and the shared
`tests/e2e/support/scripting-mock.ts` (lead, D-L23).
