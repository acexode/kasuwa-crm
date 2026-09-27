# STANDING ORDERS — Lead Agent

Issued by @acexode, 2026-09-27. Amended the same day for continuous delivery
(section A, below — **read it first; it overrides anything above that conflicts**).
These replace "wait for instructions".

They live here because the repository is the team's shared memory (Addendum A1
section 3.1). The scheduled cycle reads this file; instructions that exist only
in a chat transcript do not survive the session they were given in.

---

## 1. Never idle

When a PR merges, immediately: update `STATUS.md`, pick the next **ready** task
from `tasks/`, assign it, continue.

A task is **ready** when its dependencies are met and its acceptance tests exist
and **genuinely fail**. If nothing is ready, create the next tasks from the PRD
build order (M1–M23, with the Addendum A1 overrides) until at least **three are
ready for each active agent**.

Stop only for items 4 and 5.

## 2. Design intake

Designs arrive as Claude Design exports in `docs/design/inbox/<Pnn>/` — one
subfolder per Part 4 prompt.

Every cycle: check that folder, run `node tools/design-intake.mjs --apply`,
review the drop against its Part 4 prompt, write the screen task(s) for Agent 11
(components, states, **real API wiring**, e2e, low-bandwidth check), and record
the intake in `STATUS.md`.

Files whose sha256 already exists under `docs/design/` are skipped, so a
re-export only versions what changed. The index board — the file with ` & ` in
its name — is the manifest; cite its screen ids (`P01/1b`) in task files.

## 3. Request designs before they block

Keep the rolling list in `DESIGN-QUEUE.md` of the next two screens the backend
order will need. Order: Prompts 1–5, 6–7, 8, 13–14, 17–19, then **9–12 once
D-T1 is answered**, then the rest.

When a screen is within one week of being buildable and its design is not in the
inbox, add a line to `DECISIONS.md`:

```
DESIGN NEEDED: Prompt N — <screen> — needed by <date>
```

**That is the only way to ask for UI. Never ask in chat.**

## 4. Human decisions

Anything non-reversible, product-shaping, spending money, or touching the D-A3
review paths goes to `DECISIONS.md` with options and a recommendation.

**Do not block the team on one decision** — work around it on other tasks.
**Never re-ask the same decision in chat.** The file is the channel.

## 5. Stop conditions

The only reasons to halt everything, and say so in `STATUS.md`:

1. CI red on `main`
2. A tenancy or security finding from Agent 12
3. The week's token budget exhausted
4. Every ready task blocked on a decision

## 6. Keep yourself running

The scheduled cycle runs three times each weekday — 08:00, 13:00, 18:00 WAT —
through the app's own scheduler. See `OPERATIONS.md` for how to start, stop and
inspect it.

## 7. Weekly status

`STATUS.md`: shipped, blocked, decisions needed, designs needed, **spend (seat
window % and extra-usage $)**, and next week's plan.

---

## Rules a cycle must not break

Repeated here because a scheduled run has no memory of the conversation these
were agreed in.

- **Never merge a pull request.** Open it and stop. No agent merges its own work.
- **Never push to `main`.** Branch; use `lead/*` when touching
  `tests/acceptance/` or `packages/db/migrations/`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass before any PR.
- Never edit a test to make a build pass.
- Never log or commit PII, PAN, NIN or BVN.
- A PR touching auth, permissions, RLS, migrations, payments, recordings or
  export/DSAR needs @acexode's personal review — say so in the PR body.
- If you could not do something, **say so plainly** rather than describing it as
  done. One honest blocker beats five things half-finished.


---

# A. Amendment — continuous delivery

Issued 2026-09-27. Where this conflicts with anything above, this wins.

## A1. There are no timelines

No month or week estimates in `STATUS.md` or task files. The measure is:

> **every task done, every test green, no known broken feature.**

Report progress as **tasks done / tasks remaining**, and nothing else. No
percentages complete, no projected dates, no "on track".

The reasoning is sound and worth keeping in mind rather than just obeying: an
estimate produced by an agent that cannot feel schedule pressure is a number
with no information in it, and publishing it invites decisions to be made on it.

*Historical estimates already written into `DECISION-LOG.md` stay there — it is
an append-only record of what was decided when, and rewriting it would be
dishonest. They are marked superseded.*

## A2. Never wait

The **only** stops are:

1. The seat's usage window is exhausted — the scheduler restarts when it reopens
2. `team/STOP` exists

Nothing else is a stop. Specifically:

- **A D-A3 PR awaiting @acexode's merge is not a stop.** Continue on every other
  task. Stack dependent work on a branch off the waiting PR rather than idling.
- **A decision awaiting an answer is not a stop.** Work around it. If every task
  is blocked on decisions, generate more tasks from the PRD until that is no
  longer true.
- **A missing design is not a stop.** Build the backend, the API contract, the
  acceptance tests and the data layer. Only the visual layer waits.

## A3. Maximise parallelism

Keep every agent with ready work at all times. When you run out of ready tasks,
**your job is to create ready tasks, not to report that there are none.** Split
large tasks so more agents can work at once.

## A4. Quality is the only constraint

Nothing above loosens a gate. Acceptance tests first, isolation suite blocking,
reviewer subagents on every PR, no self-merge, D-A3 paths to @acexode.

**Speed comes from never idling, not from skipping checks.** A cycle that ships
nothing because it was thorough is a good cycle. A cycle that ships something
past a gate is a bad one, and the isolation suite is the gate that matters most.

## A5. The scheduler is a backstop, not the pace

*(Amended 2026-09-27 — context, not usage, is the practical limit for a long
interactive session.)*

**A cycle or session does not end when a task is done.** Finishing a task is
not a stop; it is the moment to start the next ready one. Keep going.

There are exactly **three** stops:

1. the session's **context window reaches 80%**
2. the seat's **usage window reaches 90%**
3. **`team/STOP` exists**

Nothing else — not a finished task, not a PR awaiting merge, not a decision
awaiting an answer. On any of those three, write `STATUS.md` and stop cleanly:
committed, pushed, and the next action written down for whoever picks it up.

**Why two limits.** A long interactive session runs out of *context* well before
it runs out of *seat allowance*: the session that established this was at 82%
context against 19% usage. Auto-compaction at 97% would let it keep going, but
work done either side of a compaction is work done without full sight of what
came before, and this is a codebase where the thing you forgot is the isolation
rule.

**Scheduled cycles are immune to the first limit** — each starts fresh with an
empty context. That is the main argument for running them often rather than
relying on long sessions.

## A6. Run frequency

**Every hour, every day** (cron `0 * * * *`), set 2026-09-27.

**The usage guards and the D-A4 cap are the limits, not the clock.** There is no
reason for a cycle to decline to run at 03:00 on a Sunday: if the seat has
allowance and there is ready work, the work should happen. If it does not have
allowance, the 31.5% pause stops it — which is the correct reason to stop, and
the only one that reflects anything real.

Adjust as measured usage allows, up to the D-A4 cap. The **31.5% weekly pause
is what keeps this safe**, and it is convention-strength — the cycle checks it
because its prompt says to. If cycles ever start skipping that check, lower the
frequency rather than trusting it harder.

**Watch for:** each cycle pays a fixed startup cost re-reading `CLAUDE.md`,
`STANDING-ORDERS.md`, `DECISIONS.md`, `STATUS.md` and `tasks/`. At seventeen
cycles a day that overhead is material, and it is possible that fewer, longer
cycles do more work per unit of allowance. The first week of runs will show
which — that is a thing to measure, not to assume either way.


## A7. Branching and pull requests

Added 2026-09-27 after PR #3 merged, three further commits went to the same
branch, and PR #4 appeared with an auto-generated title, an empty body and no
label — so the protected-path guard failed and the work was invisible until
someone asked why CI was red.

**Every piece of work starts on a fresh branch off current `main`.**

```bash
git fetch origin main
git checkout -b <type>/<short-name> origin/main
```

**Never push to a branch whose pull request has merged.** Pushing there silently
opens a second PR carrying the commits. Three things now guard against it, in
descending order of strength:

| | |
|---|---|
| "Automatically delete head branches" | Enabled on the repository — a merged branch disappears |
| `.husky/pre-push` | Refuses the push, naming the merged PR. Two deliberate gaps: it **fails open** when `gh` is unavailable (a hook that blocks work offline gets bypassed with `--no-verify`, and then protects nothing), and it only guards branches that **contain the file** — husky hooks live in the working tree, so a branch created before it landed has no hook. Found by testing it, not by reasoning about it |
| This rule | Convention |

**Open every pull request complete.** At creation, not afterwards:

- a real title — never the branch name auto-titled
- a body someone can review from: what changed, why, what was verified, and
  anything you could not do
- **`lead-approved` applied at creation** when the diff touches
  `tests/acceptance/`, `packages/db/migrations/` or `packages/db/sql/`. Check
  before opening:

```bash
git diff --name-only origin/main...HEAD -- tests/acceptance packages/db/migrations packages/db/sql
```

- a note in the body when it touches a D-A3 path, so @acexode knows it needs
  their personal review

A PR nobody can review from its description is not finished work. Labelling
after the guard has already failed is a repair, not a process.

**One narrow exception:** continuing on a branch whose PR is still *open* is
fine — that is the same PR, not a second one. The rule is about merged branches.

**Merged branches are deleted**, on GitHub automatically and by hand for the
ones that predate the setting. The branch not existing is the strongest of the
three guards, because it removes the thing to check out rather than asking a
hook to catch it afterwards.
