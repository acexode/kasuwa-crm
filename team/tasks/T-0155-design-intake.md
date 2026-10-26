# T-0155 — Fix `tools/design-intake.mjs` for bundled exports

**id** T-0155 · **status** `not-assigned` · **owner** Cursor · **priority** P2 · **module** Repo (tools) ·
**PRD** Phase 3 plan S0; STANDING ORDERS item 2 · **deps** none · **tier** Docs · **budget** 1 session

## Goal
Design intake handles a bundled Claude Design export: it reads the manifest from `design-parity.mjs design Pnn`'s `index.txt`
(the "& " board is not there in a bundle), and the repo settles on one folder layout.

## Context
- `tools/design-intake.mjs` finds the manifest from a board whose name contains " & ". A bundled export has none, so intake
  produces an empty manifest. Teach it the `index.txt` form and keep the old form working.
- Settle one folder layout under `docs/design/` and say which in `docs/design/inbox/README.md`. Moving existing files is
  out of scope unless the layout cannot be settled without it.
- S1's P21 and S2's P23 designs arrive as bundles, so this has to work before they land.

## Acceptance tests
No new suite (docs-only, as the lead ruled for S0). Prove it with a throwaway fixture export in the PR and a small
`node --test`-free check in the report: a fixture yields a non-zero manifest. Status flips to `done` in the build PR.

## Done check
Running intake (read-only) on a fixture bundle prints a non-zero manifest; the old board form still works; `team/reports/T-0155.md`.
