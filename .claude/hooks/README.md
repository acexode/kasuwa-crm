# .claude/hooks

Two hooks, configured in `.claude/settings.json`.

| Hook | Fires on | Does |
|---|---|---|
| `protect-paths.mjs` | `PreToolUse` for Edit/Write | Refuses edits under `tests/acceptance/`, `packages/db/migrations/` and `packages/db/sql/` unless `KASUWA_LEAD_SESSION=1` |
| `post-edit-tests.mjs` | `PostToolUse` for Edit/Write | Runs the **unit** tests for the package containing the edited file |

Git hooks live in `.husky/`: `pre-commit` runs affected lint and typecheck,
`commit-msg` enforces conventional commits.

## What these hooks are, and are not

`protect-paths.mjs` is a **guardrail against accident, not a security control.**
It checks an environment variable, and any session could set that variable. It
stops an agent wandering into a protected file mid-task. It would not stop one
that decided to route around it.

The control an agent cannot set is in CI: `guard-protected-paths` in
`.github/workflows/ci.yml` fails a pull request that touches those paths without
the `lead-approved` label. That in turn depends on repository settings (branch
protection, who may apply labels) that only @acexode can configure — closing
that gap is part of task T-0005.

This is written down rather than glossed over because a guardrail everyone
believes is a wall is more dangerous than one they know the shape of. See
`team/DECISIONS.md` D-L16.

## If a hook is in your way

Say so in your completion report. Do not delete the hook, and do not commit with
`--no-verify`. A hook that is wrong is a finding worth fixing for everyone.
