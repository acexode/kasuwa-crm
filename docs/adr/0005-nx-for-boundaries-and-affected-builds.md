# ADR-0005 — Nx over Turborepo, for boundary enforcement

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Lead agent (recommendation), @acexode (accepted)
- **Source:** Decision D-L03; founding pack 3.16 leaves the choice open

## Context

The founding pack says "Nx (or Turborepo)". The hard requirement is not task
running or caching — both tools do those well — it is **enforced** module
boundaries: `packages/domain/*` may depend on db, permissions and
metadata-engine, never on another domain's internals (ADR-0001).

## Decision

Nx, in package-based mode: each package keeps its own `package.json` scripts,
Nx provides the task graph, caching and `nx affected`, and tags live under
`nx.tags` in each manifest.

The decisive feature is `@nx/enforce-module-boundaries`, which enforces tag
constraints at lint time with a legible error. Turborepo has no equivalent; the
same rule would have to be rebuilt with `eslint-plugin-boundaries` or
`dependency-cruiser` and then maintained by us.

The secondary feature is `nx affected`, which the post-edit hook uses to run
only the tests a change can plausibly break. Without it the hook is either slow
enough to be disabled or narrow enough to be useless.

## Consequences

**Good.** The boundary rule is declarative and lives next to the rest of the
lint config. Affected-graph selection makes the post-edit hook viable.

**Bad.** Heavier configuration than Turborepo, a background daemon, and
generators we do not use. Nx's own conventions occasionally fight package-based
layouts.

**Guard against inertness.** A boundary rule that silently stops firing is worse
than none, because the team stops thinking about boundaries. `pnpm
lint:boundaries:verify` (`tools/verify-boundaries.mjs`) writes a file that
deliberately violates the constraints, lints it, and fails if ESLint is happy.
It runs in CI on every PR.

**Reversibility.** Moving to Turborepo later is roughly a day: the scripts are
already per-package, so it means replacing `nx.json`, rewriting the boundary
rule against another plugin, and keeping `verify-boundaries` pointed at whatever
replaces it.
