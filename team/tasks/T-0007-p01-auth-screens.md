# T-0007 — Build the P01 authentication and onboarding screens

| Field | Value |
|---|---|
| **id** | T-0007 |
| **status** | `not-assigned` |
| **module** | M19 + M2 UI |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M02-security-and-identity.md`; founding pack Part 4 Prompt 1; PRD 2.13 |
| **design** | `docs/design/P01/v1.0/` — 16 screens, manifest in `team/DESIGN-QUEUE.md` |
| **dependencies** | **T-0001** (real authentication) for anything that talks to the API |
| **decisions** | Data-region copy on `P01/5.1` is regulatory wording — see "Escalate if" |
| **budget** | 6 sessions before escalating |

## Goal

A person can sign in, pass a second factor, sign up, verify, and complete
onboarding — against the real API, on a mid-range Android phone on a slow
connection, in any of the seven languages, without reading a word of English
they did not choose.

This is the first real UI in Kasuwa. What it establishes — how a screen consumes
tokens, how it handles an error, how it degrades on 2G — is what every later
screen will copy. Spend the effort here.

## Split this task

Six sessions is the budget for all sixteen screens, which is tight. Take them in
this order, and open a PR per group rather than one at the end:

1. **`P01/1`, `1a`, `1b`, `1c`, `1d`** — sign in and its four failure states.
2. **`P01/2`, `2a`, `2b`** — two-step verification.
3. **`P01/3`, `4`** — sign up and verification.
4. **`P01/5.1`–`5.5`, `6`** — the onboarding wizard and success checklist.

Group 1 is the one that sets the patterns. If the budget runs out, it is far
better to have group 1 finished properly than four groups half-done.

## Context

- **Design:** `docs/design/P01/v1.0/`. The index board (` & ` in the filename)
  is the manifest; the screen file holds the actual designs. Open them with
  `docs/design/v1.1/support.js` alongside.
- **Tokens:** `@kasuwa/ui`. Every colour, size, space and duration comes from
  there. No raw values — an acceptance test scans for hex literals and will fail
  the build.
- **Icons:** `packages/ui/icon-subset.txt`. An icon not in that list renders as a
  blank box. Add the name and re-run `pnpm ui:fetch-fonts`. See T-0006.
- **i18n:** `@kasuwa/i18n`. A lint rule fails the build on literal JSX text.
  Seven languages are named on `P01/1`; the catalogue currently has `en` and
  `en-NG`, so **adding the other five locale files is part of this task** — the
  language menu must not offer a language that renders as English.
- **Auth API:** from T-0001. Do not invent endpoints; if one is missing, that is
  a dependency to raise, not to stub.

## Things in these designs that are easy to get wrong

Called out because each is a decision the designer already made, and
"simplifying" it would undo the point:

- **`P01/1a` does not say which field was wrong.** That is deliberate — it is the
  same rule as the API's "not authenticated" (`CLAUDE.md` section 6): an error
  that distinguishes "no such user" from "wrong password" is a user-enumeration
  oracle. Keep the lockout counter, keep the ambiguity.
- **`P01/1b` names when to try again *with the timezone*.** "Try again in 15
  minutes" is useless to someone whose phone clock is on a different zone from
  the tenant.
- **`P01/1d` is not a spinner.** Skeleton, then "Still connecting…" at 4s, then
  an offer to switch to low-bandwidth mode. This is the 256 kbps NFR made
  visible, and it is the screen most likely to be cut for time. Do not cut it.
- **`P01/2` needs paste support and auto-advance.** Six separate boxes that
  reject a pasted code is the single most irritating thing in any OTP form.
- **`P01/5.3` must not hard-code WhatsApp prices.** Meta changes them; the design
  explains the cost *types* and the 24-hour window instead. Keep it that way.
- **Onboarding is resumable.** `P01/6` says the checklist persists on Home until
  finished, so wizard state is server-side, not component state.

## Non-goals

- The app shell, navigation and command palette (Prompt 2 onward).
- Any screen behind sign-in beyond the onboarding wizard.
- Real WhatsApp/Meta embedded signup — `P01/5.3` wires the UI and the handoff;
  the BSP integration is Agent 5's (M8).
- Real import execution — `P01/5.4` wires mapping and submission; the importer
  is M20/M21.

## Definition of done

Standard (`CLAUDE.md` section 5), plus, for each group:

- [ ] Every screen in the group matches its design in both themes
- [ ] **Wired to the real API**, not fixtures. A screen that only renders a mock
      has not been built.
- [ ] Every state in the manifest is reachable and tested, including the failure
      ones — those are most of this task
- [ ] Keyboard-complete, focus visible, focus returned on dialog close; 44px
      targets; `prefers-reduced-motion` respected (the global layer handles the
      CSS, but check nothing re-introduces motion in JS)
- [ ] **Low-bandwidth check, measured not asserted**: throttle to 256 kbps /
      300 ms and record first-contentful-paint and transferred bytes in the PR.
      PRD 2.13 budgets the critical path at under 300 KB gzipped.
- [ ] RTL verified on at least one screen with `dir="rtl"` and `lang="ar"`
- [ ] e2e covering the happy path plus at least two failure states per group
- [ ] No new icon used without adding it to `icon-subset.txt`

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/auth-ui/`. They will cover, per screen id:

- the failure states render and are reachable
- `P01/1a` response is identical for unknown email and wrong password
- no literal string bypasses i18n; every offered language resolves
- the 256 kbps budget holds

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- **The data-region copy on `P01/5.1` needs to say something the design does not
  cover.** It explains NDPA in plain words and the design is explicit that it is
  not legal advice. Anything beyond the words in the export is a question for
  counsel via `DECISIONS.md`, not a paraphrase.
- The seven languages on `P01/1` cannot all be sourced. Shipping a menu entry
  that falls back to English is worse than offering fewer languages.
- T-0001 has not landed the endpoint a group needs.
