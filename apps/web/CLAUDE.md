# CLAUDE.md — @kasuwa/web

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Next.js App Router shell. Currently renders only the design-tokens page.

## Invariants

1. Every user-facing string goes through `@kasuwa/i18n`. A lint rule fails the build on literal JSX text.
2. Every colour, spacing and type value comes from `@kasuwa/ui` through the Tailwind preset. Never a raw value.
3. PRD 2.13 budgets: core workspace usable at 256 kbps with 300 ms latency, initial JS under 300 KB gzipped on the critical path. Treat these as requirements, not aspirations.
4. WCAG 2.2 AA, 44 px touch targets, visible focus, reduced-motion variants.
5. The real app shell is Agent 11's from the Claude Design output. The current page is scaffolding that proves tokens and i18n work end to end, not a design to build on.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
