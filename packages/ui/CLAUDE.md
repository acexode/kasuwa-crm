# CLAUDE.md — @kasuwa/ui

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Design tokens and, later, the component library synced from Claude Design.

## Invariants

1. `src/tokens.ts` is the single source of truth. `src/tokens.css` is GENERATED (`pnpm ui:tokens`) and CI fails if it drifts. Never hand-edit the CSS.
2. This is the ONLY package that may contain colour literals. A lint rule enforces it everywhere else. A one-off colour is how a design system dies.
3. Every pair in `SEMANTIC_CONTRAST_PAIRS` is asserted at WCAG 2.2 AA in both themes. Do NOT lower a `minimumRatio` to make a colour fit — if a brand colour cannot meet AA in a role, that is a finding about the brand.
4. The tokens are currently PROVISIONAL, derived from three anchors in Prompt 0 (D-L10). Agent 11 replaces them wholesale from the Claude Design export in T-0003.
5. The Tailwind preset references CSS variable NAMES, which are stable. Replacing token values must not require touching the preset.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
