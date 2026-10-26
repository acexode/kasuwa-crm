# T-0126 — The TOTP step offers "Text a code to …" only when SMS is possible

| Field | Value |
|---|---|
| **id** | T-0126 |
| **status** | `done` |
| **module** | M01 — Platform & Security (P01 screens) |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P1 |
| **PRD refs** | `docs/prd/M01-*.md` (MFA); design `docs/design/P01/v1.0/Kasuwa Auth and Onboarding.html`, screens P01/2 and P01/2a |
| **dependencies** | none |
| **decisions** | D-L193 (hands-on finding), D-L197 (wave 0) |
| **budget** | 1 session |

## Goal

In the user's hands-on test, every demo user saw "Text a code to" followed by nothing on the code step. After this
task, the SMS alternative is offered only when the challenge's `sms` method is `available` and carries a masked
`deliveryHint`. When it is offered, its label shows that masked number. Today the live API never offers SMS, so
nobody sees the option until a channel provider exists.

## Context

- **Cause:** `apps/web/components/auth/sign-in-screen.tsx` goes to `/verify?challenge=…` and drops the challenge's
  `methods`. `apps/web/app/verify/page.tsx` and `components/auth/mfa-screen.tsx` then render the SMS button
  unconditionally, with `hint ?? ''`.
- **The fix must survive a reload of `/verify`.**
  - Do not put the masked number in the URL. It is personal data, and the URL lands in history and logs.
  - Carry what the screen needs in `sessionStorage`, keyed by the challenge id, or in the URL as a plain
    `sms=1`/`0` flag with the hint in `sessionStorage`.
  - If neither is present, hide the option.
- `applyChallenge` (after a reissue) already reads `methods`; keep the two paths consistent.
- The P01/2 layout itself is rebuilt in T-0131. Change only what this rule needs.

## Acceptance tests

- `tests/e2e/p01-mfa-sms.spec.ts` (new, five journeys, `@t0126`)
- `tests/e2e/p01-auth.spec.ts` P01/2a (now installs the mock with SMS available)
- `tests/e2e/support/auth-mock.ts` gains `smsMethod` (lead)

## Non-goals

- Restyling P01/2 (T-0131).
- Making SMS work. That needs a channel provider (M08).

## Definition of done

Root CLAUDE.md §5. Also: before/after `tools/design-parity.mjs` shots of P01/2 at 1440 and 360, light and
dark, linked from the PR.
