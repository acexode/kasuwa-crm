# CLAUDE.md — @kasuwa/i18n

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

ICU MessageFormat catalogues and the locale fallback chain.

## Invariants

1. `en` is the complete catalogue and the extraction source. Regional locales are overlays holding only what differs.
2. A missing message THROWS. Rendering a blank hides the bug until a customer reports an empty button.
3. `en-XA` is the generated pseudo-locale, gitignored, built in CI. It reveals strings that were never externalised and layouts that break at ~140% length.
4. PRD 2.9 requires en, en-NG, pcm, ha, yo, ig, fr, sw, pt and ar (RTL). Adding them is a task, not a side effect.
5. No hard-coded currency symbols. Locale-aware formatting through `Intl`.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
