# CLAUDE.md — @kasuwa/web

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Next.js App Router shell. Routes today:

| Route | Screens | Notes |
|---|---|---|
| `/` | `P01/1`, `1a`, `1b`, `1d` | Sign in and its failure states |
| `/sso` | `P01/1c` | SSO by email domain |
| `/verify` | `P01/2`, `2a`, `2b` | Second factor |
| `/sign-up` | `P01/3` | **Behind `self_serve_signup`** (D-P2): a real 404 while it is off. No "already registered" state, ever (D-P3) |
| `/sign-up/verify` | `P01/4` | Behind the flag. Email by link, phone by OTP; shows only the server's masked hints |
| `/sign-up/region` | `P01/5.1` | Behind the flag. ZA selectable; NG and KE shown sales-only (D-P2) |
| `/onboarding` | `P01/5.2`–`5.5`, `P01/6` | First-admin login. **Never** behind the flag (T-0018). Step state is client-side until T-0018 gives it a server home |
| `/admin` | `P02/A`, `A1` | Admin home and the settings menu |
| `/admin/programmes` | `P02/B`, `B1` | Programmes list and its first-run empty state |
| `/admin/programmes/[id]` | `P02/B2`–`B9` | Tabs via `?tab=overview\|agents\|sla\|dispositions\|scripts\|retention\|portal`, plus the archive dialog |
| `/admin/roles` | `P02/C`–`C3` | Role hierarchy. Dragging is the shortcut; the "Reports to" picker is the control |
| `/admin/field-security` | `P02/D`–`D2` | Two axes and no programme selector (D-P9) |
| `/admin/audit` | `P02/E`–`E2` | The audit log and its export |
| `/translations` | — | Where the language menu's "help improve this translation" link lands (D-P1). Server-only, no client JS |
| `/contacts` | `P04/02`, `P04/05`, `P04/06` | **Behind `crm_records`** (T-0042, D-L64): a real 404 while it is off. The CRM shell (`components/crm/`), not the admin one. Read from the browser through `lib/records-api.ts` against the contract mock until T-0041 is live |
| `/contacts/[id]` | — | Scaffolding, **behind `crm_records`** (D-L64). Exists so the tenancy e2e test can tamper with a **web** URL; replace it when M4 builds the real screen. |
| `/design/tokens` | — | The token gallery. It used to be at `/`. |

All sixteen P01 screens are built (`team/reports/T-0007.md`, `T-0007b.md`), and
all twenty-two P02 screens.

**Feature flags are read on the server only**, through `lib/feature-flags.ts`.
A gated page calls `notFound()` before rendering anything, so the route — not
just the link to it — is hidden. The e2e run starts a second web server with
the flags on in its environment (`tests/e2e/scripts/run-e2e.mjs`); nothing a
browser sends can turn one on, and a test tries.

**`admin_live_api` (T-0035)** is the second flag, also not production-ready.
**It is not an access control and it does not gate the admin API**: the
console calls the same same-origin `/api/v1/admin` paths either way, and who
may read or write is decided by the API session and the permissions engine
(T-0032). What the flag changes is presentation: with it ON, KPIs (`P02/B2`)
and skill cover (`P02/B3`) — the two reads the API has not built — render
sample data from `lib/admin-sample.ts` inside `components/admin/
sample-data.tsx`, with `data-source="mock"` plus a visible, translated "Sample
data" label; and the e2e harness runs the live console on the flag-on process.
Sample data lives in the app, never in a test mock. The programme page reads
the flag and passes a `live` boolean down; no client module names the flag.
`tests/e2e/p02-live.spec.ts` (`@p02-live`) drives all twenty-two screens
against the real API and the seeded database with no interception;
`p02-admin.spec.ts` keeps the contract-mock states.

**`crm_records` (T-0042)** is the third flag, not production-ready until
T-0041 serves `q`, the filters and `withheldFields` live. The e2e harness runs
it on a third web process (`webRecordsUrl`): the SAME production build as the
default server, `next start` with `NODE_ENV=test` because the boot guard
refuses a not-ready flag under `production` (D-L64). The `/contacts` byte
budget is measured there. On `/contacts`: a withheld field is a lock and a
`null` is "Not set", decided per row; the programme chip and the owner and
account cells are neutral labels, never ids, until T-0043 adds names; the list
survives going offline in memory only, never on the device (D-L64); and the
search term never enters the URL.

**`?locale=en-XA`** renders the pseudo-locale, derived from `en` at runtime by
`@kasuwa/i18n` (`src/pseudo.ts`). Like `ar` it is a preview: on no menu,
persisted nowhere.

**A programme with no retention policy answers `404`** (D-L50). `P02/B7` shows
that as "no rules saved yet" with every period unchosen — never pre-selected —
and the first save sends `version: 0` (`components/admin/retention-model.ts`).

**`P02/B7` (retention) must not imply Kasuwa enforces retention on call
recordings.** D-T4 is BLOCKED and ADR-0003 says the telephony platform is not
ours; `admin.ret.scope.note` says so on the screen, and an e2e test asserts it
is there. If a copy change would force the claim, escalate rather than edit.

**The language menu is `languageOptions()` in `lib/locale.ts`**: the attested
`SUPPORTED_LOCALES` plus the complete-but-unreviewed `BETA_LOCALES` (D-P1,
answered 2026-10-03), each Beta entry with a translated badge and a "help
improve this translation" link to `/translations`. Both lists are derived in
`@kasuwa/i18n`; a reviewer's sign-off moves a language with no edit here.

Every admin read goes through `lib/admin-api.ts`, parsed with Zod, and every
screen renders its four states through `components/admin/panel.tsx`. Three
fields in that contract are nullable because the system does not know the
answer — agent `presence`, skill-cover `needed`, disposition `usageCount90d` —
and **null renders as "not known", never as "Offline", "0%" or "0 times".**

## Invariants

1. Every user-facing string goes through `@kasuwa/i18n`. A lint rule fails the build on literal JSX text.
2. Every colour, spacing and type value comes from `@kasuwa/ui` through the Tailwind preset. Never a raw value. Control classes live in `components/auth/button-classes.ts`; that is where `min-h-touch` and the focus ring are kept honest.
3. PRD 2.13 budgets: core workspace usable at 256 kbps with 300 ms latency, initial JS under 300 KB gzipped on the critical path. Treat these as requirements, not aspirations. `P01/1` is pinned at 252,000 transferred bytes (T-0035, within 5% of the 240,015 measured), and `/onboarding` has its own budget in `tests/e2e/fonts.spec.ts`. Fonts are self-hosted only, and `₦`/`₵` come from a ~3 KB subset (D-L43, D-L44, `packages/ui/CLAUDE.md`).
4. WCAG 2.2 AA, 44 px touch targets, visible focus, reduced-motion variants. There is **no axe exemption** in the e2e suite, and there must not be one again.
5. The real app shell — navigation, command palette, global search, agent state — is still to come (Prompt 2 onward).
6. **A server component may import only JSX from a `'use client'` module.** A client module's exports become client references; importing a plain value gets a proxy and fails at request time, with nothing at compile time to warn you. `app/client-boundary.test.ts` enforces it.

## Two patterns worth copying

**Server resolves strings, a client island formats them.** `createTranslator`
closes over every registered catalogue; shipping nine of them to render one form
is most of what a user on 256 kbps waits for. A `'use client'` module therefore
imports **`@kasuwa/i18n/bundle`**, which imports no catalogue — importing
`@kasuwa/i18n` from one pulls every catalogue in the repository into the browser
bundle, which it did, for 26.5 KB gzipped on every admin route. Each screen declares its message
ids in `components/auth/message-ids.ts` — a module with **no** `'use client'`
directive, because a client module's exports become client references and a
server component importing one gets a proxy, which fails at request time and not
at compile time.

**The API is same-origin.** Every fetch is a relative `/api/v1/...` path;
`next.config.mjs` rewrites it, reading the origin through `webEnv()` from
`@kasuwa/config/web` (T-0014). No `process.env` anywhere in apps/web (bar the
`...process.env` spread in `build.mjs`), and no extra DNS
lookup, TLS handshake or CORS preflight on a 300 ms link.

## Icons

`<Icon name="…" />` takes a union generated from `packages/ui/icon-subset.txt`.
An icon outside that subset renders as a blank box — silently, only in
production. Add the name, run `pnpm ui:fetch-fonts`, and the union regenerates.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e -- --grep @p01`.
Nothing here may contradict an open decision in `team/DECISIONS.md` — if it
would, stop and escalate.
