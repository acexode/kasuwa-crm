# OPERATIONS.md — running the lead agent

How the autonomous cycle is started, stopped and inspected (D-L24, Option 2).

## What it is

A scheduled task in **this app's own scheduler**, not an OS-level cron.

| | |
|---|---|
| Task id | `kasuwa-lead-cycle` |
| Schedule | **08:00, 13:00, 18:00 WAT, Monday–Friday** (cron `0 8,13,18 * * 1-5`) |
| Prompt | `~/.claude/scheduled-tasks/kasuwa-lead-cycle/SKILL.md` |
| Does | Reads `team/`, continues per `STANDING-ORDERS.md`, opens PRs |
| Does **not** | Merge anything, push to `main` |

Chosen over an OS scheduled task deliberately: it is supervised, visible in the
sidebar, and stoppable from the UI. An unattended `claude -p` loop with
auto-accepted edits, pushing to a shared repository every two hours, is a
standing capability that should not live behind a Task Scheduler entry nobody
looks at.

**It only runs while this app is open.** If the app is closed when a run is due,
it fires on next launch. That is a real limitation: a weekend with the laptop
shut means no cycles, and Monday morning may fire a backlog.

## Start, stop, inspect

**From the UI:** the *Scheduled* section in the sidebar. Enable, disable, "Run
now", and the run history with each run's session are all there.

**Run one now** — worth doing once before relying on the schedule, so the task
pre-approves the tools it needs and later runs do not pause on a permission
prompt.

**Stop it, two ways:**

1. **Disable the task** in the sidebar — stops the schedule.
2. **`team/STOP`** — create a file at that path with a line saying why. The
   cycle checks it first, before budget, before git, before anything that could
   itself fail, and halts. Use this one if something is going wrong in the
   repository rather than with the schedule; it stops the work without
   disturbing the automation, and it is visible to everyone in a `git status`.

```bash
echo "halted: isolation suite red on main, investigating" > team/STOP
git add team/STOP && git commit -m "chore: halt the lead cycle" && git push
```

Delete the file to resume.

## The guards, and how strong each actually is

| Guard | Enforced by | Strength |
|---|---|---|
| `team/STOP` | The cycle prompt, checked first | **Convention.** The agent checks it because the prompt says to. |
| Budget pause at 31.5% weekly | The cycle prompt | **Convention.** |
| CI red on `main` → fix only | The cycle prompt | **Convention.** |
| Never merge | Prompt + branch protection | **Real**, once code-owner review is on. |
| Never push to `main` | Branch protection | **Real**, once configured. |
| Acceptance tests not editable | CI label gate + hook | **Real** in CI. |

Worth being clear-eyed: the first three are the agent following its own
instructions. That is weaker than a wrapper script refusing to launch it, which
is what the OS-cron design would have given — and it is the trade for running
supervised inside the app. The controls that do not depend on the agent's
cooperation are branch protection and CI.

**So: branch protection on `main` is what makes this safe**, not the prompt. It
was committed to before PR #2 and should be verified before relying on the
schedule.

## Budget

Per D-A4, the lead may use up to **35% of the weekly all-models seat window**,
pausing at **31.5%** (90% of its allocation). The cycle checks this before
starting work and records both the seat-window percentage and any extra-usage
dollars in `STATUS.md`.

Seats are **per-user, not pooled** (confirmed 2026-09-27), so each agent needs
its own seat or API key from week 3. The monthly per-seat cap is being measured
rather than guessed — the first week of real runs replaces the estimate.

## When a run goes wrong

1. Open the run's session from the sidebar — each run is a full transcript.
2. If it left a branch half-finished, that is recoverable: nothing merges
   without a human, so the worst case is an abandoned branch and some spend.
3. If it pushed something wrong, `git revert` on a branch — never force-push.
4. If it is looping or misbehaving, `team/STOP` first, then disable the task.

## Changing the schedule or the prompt

The prompt is `~/.claude/scheduled-tasks/kasuwa-lead-cycle/SKILL.md`. It is
**outside the repository**, which means it is not version-controlled and not
reviewed — a real weakness. Keep it thin, and keep the actual instructions in
`team/STANDING-ORDERS.md`, which the prompt tells the cycle to read. Change
behaviour there, not in the prompt, so changes are reviewable.

## Working on the Windows machine (Phase 3)

What the plan and the lead's rulings say (`docs/phase3/PLAN.md` section 4, D-L205, D-L207). Nothing here is new policy.

- **Build in the main checkout**, `C:\dev\Outsource\kasuwa`. Create no other worktrees: about 10 GB of disk is free.
  Between tasks, switch branches in place; commit or stash first.
- **One verification worktree**: the lead's detached, short-path `C:\kw\verify`. Full runs, `next build` and e2e
  verification happen there, not in the main checkout. Never run two `next build`s, or a `next dev` plus an e2e build, in
  one checkout: they share `apps/web/.next`.
- **`git config core.longpaths true`** is set and approved. The main checkout's path is long enough to need it.
- **One Docker stack at a time.** Check `docker ps` first; the dialler stack counts. Every e2e run, and every acceptance
  suite that starts the e2e harness, goes through `tools/e2e-locked.sh` (T-0152). Do not start or stop Docker for the
  user.
- **Bounded parallelism:** vitest `--maxWorkers=2`, nx `--parallel=2`. At most two heavy jobs at once, which in practice is
  the main checkout plus `C:\kw\verify`.
- **The PR gate is the fast gate (D-L207).** Every PR runs lint, typecheck, unit, integration and the whole `isolation`
  project, and these are blocking. UI acceptance (`pnpm test:ui-acceptance`) and the full `pnpm test:e2e` run in the
  full gate: nightly on main (01:00 UTC), on demand (`gh workflow run CI --ref <branch>`), and on the Windows runner
  before a slice or the phase closes. Locally, run only the suite or e2e tags a task names. A PR that changes `apps/web`
  dependencies or a shared chunk also runs the byte-budget tags.
- **A migration or env-schema PR** gets a full acceptance run on its head before merge (D-L205).
