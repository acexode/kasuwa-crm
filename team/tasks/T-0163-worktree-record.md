# T-0163 — Worktree cleanup record and an operations note

**id** T-0163 · **status** `done` · **owner** Cursor · **priority** P3 · **module** Repo (docs) ·
**PRD** Phase 3 plan S0, section 7 · **deps** none · **tier** Docs · **budget** half a session

## Goal

The cleanup of the extra worktrees is on record, and `team/OPERATIONS.md` says how work is done on this machine.

## Context

- Record that @acexode asked for the other worktrees to be cleared, and that they were removed. The one kept is the
  `agent-a132f…` worktree (T-0083, uncommitted work), which is the lead's to dispose of.
- Add a short `team/OPERATIONS.md` section: build in the main checkout; the one verification worktree is `C:\kw\verify`;
  `git config core.longpaths true`; one Docker stack at a time. Per D-L207 the PR gate is the fast gate. State only what
  the plan and the lead's rulings say.

## Acceptance tests

None (docs-only, as the lead ruled for S0). Status flips to `done` in the build PR.

## Done check

`team/OPERATIONS.md` has the section, and `team/reports/T-0163.md` has the record. Links resolve.
