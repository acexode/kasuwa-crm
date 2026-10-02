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
| `/admin` | `P02/A`, `A1` | Admin home and the settings menu |
| `/admin/programmes` | `P02/B`, `B1` | Programmes list and its first-run empty state |
| `/admin/programmes/[id]` | `P02/B2`–`B5` | Tabs via `?tab=overview\|agents\|sla\|dispositions` |
| `/contacts/[id]` | — | Scaffolding. Exists so the tenancy e2e test can tamper with a **web** URL; replace it when M4 builds the real screen. |
| `/design/tokens` | — | The token gallery. It used to be at `/`. |

`P01/3`, `P01/4` and the onboarding wizard (`P01/5.1`–`5.5`, `P01/6`) are not
built — see `team/reports/T-0007.md`. `P02/B6`–`B9`, `C`–`C3`, `D`, `D1` and
`E`–`E2` are not built — see `team/reports/P02.md`.

Every admin read goes through `lib/admin-api.ts`, parsed with Zod, and every
screen renders its four states through `components/admin/panel.tsx`. Three
fields in that contract are nullable because the system does not know the
answer — agent `presence`, skill-cover `needed`, disposition `usageCount90d` —
and **null renders as "not known", never as "Offline", "0%" or "0 times".**

## Invariants

1. Every user-facing string goes through `@kasuwa/i18n`. A lint rule fails the build on literal JSX text.
2. Every colour, spacing and type value comes from `@kasuwa/ui` through the Tailwind preset. Never a raw value. Control classes live in `components/auth/button-classes.ts`; that is where `min-h-touch` and the focus ring are kept honest.
3. PRD 2.13 budgets: core workspace usable at 256 kbps with 300 ms latency, initial JS under 300 KB gzipped on the critical path. Treat these as requirements, not aspirations. `P01/1` measures 251 KB transferred in a production build, so there is not much room.
4. WCAG 2.2 AA, 44 px touch targets, visible focus, reduced-motion variants. There is **no axe exemption** in the e2e suite, and there must not be one again.
5. The real app shell — navigation, command palette, global search, agent state — is still to come (Prompt 2 onward).

## Two patterns worth copying

**Server resolves strings, a client island formats them.** `createTranslator`
closes over every registered catalogue; shipping nine of them to render one form
is most of what a user on 256 kbps waits for. Each screen declares its message
ids in `components/auth/message-ids.ts` — a module with **no** `'use client'`
directive, because a client module's exports become client references and a
server component importing one gets a proxy, which fails at request time and not
at compile time.

**The API is same-origin.** Every fetch is a relative `/api/v1/...` path;
`next.config.mjs` rewrites it. No `process.env` in app code, and no extra DNS
lookup, TLS handshake or CORS preflight on a 300 ms link.

## Icons

`<Icon name="…" />` takes a union generated from `packages/ui/icon-subset.txt`.
An icon outside that subset renders as a blank box — silently, only in
production. Add the name, run `pnpm ui:fetch-fonts`, and the union regenerates.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e -- --grep @p01`.
Nothing here may contradict an open decision in `team/DECISIONS.md` — if it
would, stop and escalate.
