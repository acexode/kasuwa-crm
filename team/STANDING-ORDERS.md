# STANDING ORDERS — Lead Agent

Issued by @acexode, 2026-09-27. These replace "wait for instructions".

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
