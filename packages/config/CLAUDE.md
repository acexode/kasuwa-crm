# CLAUDE.md — @kasuwa/config

> **Owner:** Agent 1 — Platform & Security
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Environment loading and validation for every process.

## Invariants

1. This is the ONLY place in the repository that may read `process.env`. A lint rule enforces it.
2. Zod parses the environment at startup. A process refuses to boot on an invalid environment rather than failing confusingly later.
3. `assertAuthModeIsSafe` refuses to start with `KASUWA_AUTH_MODE=stub` under `NODE_ENV=production`. That single check is what keeps the header-based stub auth out of a live deployment (ADR-0007). Do not weaken it, and do not add a bypass flag. **Every process schema runs it** (`apiEnv`, `workerEnv`, `realtimeEnv`, `webEnv`, `migratorEnv`), and `KASUWA_AUTH_MODE` lives in the shared base so no schema can leave it out. The one parse that skips it is `webBuildEnv`, because `next build` is not a boot; `next start` runs `webEnv`.
4. One schema per process over a shared base (T-0014). Each parses what its process reads and nothing more. `webEnv` **refuses** the database URLs and the other server credentials (`WEB_FORBIDDEN` in `schemas.mjs`) rather than ignoring them.
5. **Importing this package has no side effects.** `.env` is loaded only by an explicit `loadWorkspaceEnv()` call, which the server processes and operator commands make first thing. The web process imports `@kasuwa/config/web`, which loads nothing; lint bans the main entry in `apps/web/**`. `.env` is found by walking up to the workspace root, because scripts run with `pnpm --filter` have the package directory as their cwd. Real environment variables always win over the file.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
