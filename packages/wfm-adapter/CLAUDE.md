# CLAUDE.md — @kasuwa/wfm-adapter

> **Owner:** Agent 6 — Contact-Centre Integration
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

The single boundary between Kasuwa and the existing WFM system (ADR-0003).

## Invariants

1. Kasuwa does NOT build WFM. No shift schedules, no adherence calculation, no Erlang C, no intraday alerting. M11 became an integration module (Addendum A1 section 2.1).
2. Shift swap and leave are a LINK OUT to WFM, not a workflow here. Two sources of truth for who is working tomorrow is a worse problem than an extra click.
3. Read-only for now. Whether Kasuwa must also publish agent states into WFM is D-W2, open.
4. NOTHING about the real WFM has been shared (D-W1): no repo, data model, API spec or screenshots. These contracts are derived from prose. Treat them as a sketch, not a specification.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
