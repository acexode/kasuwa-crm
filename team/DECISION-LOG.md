# DECISION-LOG.md — closed decisions

Answered decisions move here from `DECISIONS.md`, with the answer, the date and
any consequences. **Read this before re-asking a question** — the whole point of
the log is that agents stop re-litigating settled ground (Addendum A1 section
3.5, "Product-judgement gaps").

Format: id, date answered, question, answer, consequence.

---

## D-L01 — Git repository and remote
**Answered:** 2026-09-26 · **Answer:** `https://github.com/acexode/kasuwa-crm`
**Consequence:** repo initialised locally on `scaffold/initial`, remote added.
The repository was empty at that point, so the scaffold PR creates `main`.

---

## D-L17 — GitHub handle for CODEOWNERS
**Answered:** 2026-09-26 · **Answer:** `@acexode`
**Consequence:** `CODEOWNERS` routes the protected paths (acceptance tests,
migrations, `.github/`, tenancy source, `team/`, `docs/adr/`) to @acexode.
Per-agent team entries remain commented out until real GitHub teams exist —
CODEOWNERS entries naming non-existent teams can block merges.

---

## D-A3 — Which PR categories need the human's personal review?
**Asked:** 2026-09-26 · **First answered:** 2026-09-26 · **REVISED:** 2026-09-27

**Final answer:** @acexode personally reviews every pull request touching:
auth, permissions, RLS and migrations, payments and e-invoicing, recordings and
PCI, and data export or DSAR. Everything else the lead merges on green CI plus
reviewer-subagent verdicts.

**Note on the reversal, because it matters for how the scaffold reads.** The
first answer was "none — an AI agent reviews and I merge on green CI". I raised
that Addendum A1 section 3.5 names human review of exactly these categories as
the mitigation for the model's biggest weakness, and that an AI reviewer shares
those blind spots by construction. The answer was revised the next day to the
list above, which is the addendum's own recommendation.

Anything in the repository written under the first answer — chiefly the note in
`CODEOWNERS` and the framing in `ROSTER.md` — has been corrected. The
compensating measures built while the first answer stood are all still in place
and still worth having: the isolation suite attacks the database directly with
forged session variables rather than trusting the application; a catalogue
invariant fails if any table exists without RLS enabled, forced and policied;
conventions that used to rely on a reviewer noticing are lint rules; and
`pnpm lint:boundaries:verify` proves the boundary rule fires rather than
sitting inert.

**Consequence:** `CODEOWNERS` routes those paths to @acexode. For this to be a
gate rather than a label, **"Require review from Code Owners" must be enabled in
branch protection** — a repository setting only @acexode can change. That is
part of T-0005, and until it is on, CODEOWNERS is a routing hint.

**Still open:** an external penetration test before commercial GA
(Addendum A1 section 3.5). Not scheduled.

---

## D-L06 — Can a session be scoped to "all programmes in my tenant"?
**Answered:** 2026-09-26 (read as acceptance of the recommendation)
**Answer:** No wildcard. The session always carries an explicit, enumerated list
of programme ids resolved from `user_programme`.

**Consequence:** `app.programme_ids` is always a concrete uuid array; there is no
sentinel value and `packages/db/migrations/0000` documents its absence.
Supervisors and admins who need tenant-wide reach get an explicit membership row
per programme. If that proves unworkable at scale — a tenant with hundreds of
programmes producing a very large GUC — it comes back as a new decision, not as
a quiet wildcard.

**Still to settle separately:** how the permissions engine (M2) expresses
tenant-wide *permissions* as distinct from programme *membership*. That is
Agent 1's design question and is not covered by this answer.

---

## D-L03 — Nx or Turborepo
**Answered:** 2026-09-26 (proceeding on recommendation, reversible)
**Answer:** Nx. **Consequence:** ADR-0005. `@nx/enforce-module-boundaries`
provides the boundary enforcement the operating model depends on;
`pnpm lint:boundaries:verify` proves it is live rather than decorative.

---

## D-L04 — Drizzle or Kysely
**Answered:** 2026-09-26 (proceeding on recommendation, reversible)
**Answer:** Drizzle for schema and repositories; hand-written SQL migrations.
**Consequence:** ADR-0006. Drizzle is a typed query builder only —
`packages/db/migrations/*.sql` is the source of truth, because RLS policies,
`FORCE ROW LEVEL SECURITY` and grants have no Drizzle representation and a
generated migration would silently omit them.

---

## D-L19 — PR size limit
**Answered:** 2026-09-26 · **Answer:** ~600 lines (the addendum supersedes the
founding pack's 400). **Consequence:** recorded in `CLAUDE.md`; structural PRs
are exempt with a note in the description.

---

## D-A1 / D-L18 — Roster size
**Answered:** 2026-09-27 · **Answer:** 13 total — 12 specialists plus the lead.
Independent QA and DevOps are kept.

**Consequence and a follow-up question:** Addendum A1 section 3.2 lists **13**
specialists (agents 1–13). Keeping QA (#12) and DevOps (#13) independent while
capping specialists at 12 means exactly one builder from #1–#11 must be folded
into another. The addendum anticipated this — "I'd rather drop a builder than
lose independent QA or DevOps" — but did not say which builder.

I have not guessed. `ROSTER.md` carries the three candidate merges and my
recommendation; one word from you closes it. Nothing is blocked in the meantime,
because the folded agent would be a week-3 start either way.

---

## D-A2 — Iteration length
**Answered:** 2026-09-27 · **Answer:** 1 week, with `DECISIONS.md` checked daily.
**Consequence:** the lead replans weekly and writes `STATUS.md` weekly. Daily
decision turnaround is what makes 1-week iterations viable rather than a weekly
pile of blocked tasks — Addendum A1 section 3.3 is explicit that your decision
latency, not agent speed, is the constraint.

---

## D-L20 — rollup pinned to its WASM build
**Answered:** 2026-09-27 · **Answer:** accepted as **temporary**. Agents will run
in a devcontainer or cloud environment; remove the pin once that is confirmed.
**Consequence:** the override lives in `pnpm.overrides` in the root
`package.json`. JSON takes no comments, so the pointer is here and in
`CLAUDE.md` section 4 instead — check both before assuming it is permanent.
Removing it is a one-line change plus a lockfile update. The environment itself
is not yet chosen; that is part of T-0005.

---

## D-L21 — SeaweedFS instead of MinIO
**Answered:** 2026-09-27 · **Answer:** accepted.
**Consequence:** local object storage is SeaweedFS with anonymous S3 access.
Whoever first stores attachments or recordings should re-check whether
production uses AWS S3 directly, in which case local parity matters less than
assumed, or whether a licensed MinIO is wanted for the Lagos Silo cells.

---

## D-L23 — acceptance-test stubs
**Answered:** 2026-09-27 · **Answer:** agreed it is a weakening. **New standing
rule: no task is assigned until its acceptance tests exist and fail for a real
reason.**

**Consequence:** this is now enforced rather than remembered. Every task file
carries a `status` field, and `tools/verify-task-readiness.mjs` fails CI if a
task marked `assigned` or `in-progress` names acceptance tests that are still
`it.todo`, or names none at all. The five pilot tasks are `not-assigned`, so the
stubs are legal exactly until the lead converts them and assigns the work.


---

## Branch protection on `main`
**Stated:** 2026-09-27 · **Commitment:** require a pull request, required status
checks, and code-owner review — **on before PR #2.**

This is what turns three things from convention into control: the `lead-approved`
label gate, the D-A3 review categories in `CODEOWNERS`, and "no merging past a
red isolation suite". Only @acexode can set it. Recommended required checks:
`Lint`, `Typecheck`, `Unit tests`, `Integration tests`, `Tenant isolation suite`,
`Build`, `Guard protected paths`.

Note that `Guard protected paths` now lives in its own workflow
(`.github/workflows/guard.yml`) so it re-evaluates when the label is applied.
On PR #1 it did not, because the default `pull_request` event types exclude
`labeled` — the gate worked, but needed a manual re-run to clear.


---

## D-L10 — Design tokens (CLOSED by T-0003)
**Answered:** 2026-09-27 · **Answer:** Design v1.1 approved and imported.

The provisional scales the scaffold derived from three brand anchors are gone.
`packages/ui` is now generated from the Claude Design export committed unchanged
under `docs/design/v1.1/`.

### Deviations from the import, recorded as the hand-off requires

None of these change a token **value**. They are naming and packaging choices
made while turning an HTML export into a build.

1. **CSS custom property prefix is `--k-`, not `--kasuwa-`.** The export uses
   `--k-`, and the hand-off says to generate from those properties. The scaffold's
   `--kasuwa-` names are gone. Consequence: every Tailwind class name in
   `apps/web` changed (`text-text-primary` → `text-text`, `bg-action-primary` →
   `bg-primary`).

2. **Scale steps are emitted as `--k-scale-<family>-<tone>`**, not
   `--k-<family>-<tone>`. Without the `scale` segment, `--k-primary-500` (a ramp
   step) sits confusingly beside `--k-primary` (the action fill), which are
   different things — one is a palette entry, the other a role. In Tailwind the
   scales are exposed as `primary-scale-500` and the semantic tokens as their own
   names (`bg-primary`, `text-text-muted`).

3. **Colours are machine-extracted, not transcribed.**
   `pnpm ui:import-design` parses the export; `tokens.colours.generated.ts` is
   the output and CI fails on drift. Over 150 hex values would be wrong
   somewhere if typed by hand, and a mistyped semantic token is a contrast
   failure nobody sees. The importer also **fails** if light and dark define
   different token names — a token present in one theme only renders as `unset`.

4. **Type, spacing, radius, elevation and motion are hand-encoded** in
   `tokens.ts`, because the export carries them as rendered markup rather than
   as data. Each block cites the export section it came from. That is a dozen
   values, not a hundred and fifty.

5. **Noto Sans Arabic ships the `arabic` subset only.** Google also serves it
   with Latin subsets; Noto Sans already covers Latin, and shipping both would
   add ~30 KB of duplicate glyphs on a 256 kbps connection.

6. **Fonts live in `apps/web/public/fonts/`** and the generated `fonts.css`
   references `/fonts/…`. That couples `packages/ui` to the web app's public
   path. The alternative — shipping fonts inside the package and copying at
   build time — is more correct and more machinery than one app justifies.
   Revisit when the Expo app needs the same fonts.

7. **`tokens.css` is now `tokens.generated.css`**, and the Tailwind preset is
   generated too. The preset was hand-written in the scaffold; with 53 semantic
   tokens and 77 scale steps it would have gone stale, and a stale preset does
   not fail — it silently omits a utility, and someone works around the gap with
   a raw value.

### One number did not reconcile — reported, not silently accepted

The hand-off quotes an independently computed **3.79** for
`border-strong on surface`. My computation gives **4.12 (light)** and
**4.56 (dark)**.

Everything else matches: the text pairs come out at **5.54–11.59** against the
quoted 5.5–11.6, which is agreement to the precision given and is strong
evidence the import is faithful. Only this one figure differs, and mine is
*higher* — the ≥3.0 requirement passes either way, in both themes.

No pairing of `border-strong` in the token set produces 3.79. The nearest are
**3.88** against `--k-bg` and **3.62** against `--k-surface-sunken`. So 3.79 is
most likely either a different background than `surface`, or a value carried
over from v1.0.

**RESOLVED 2026-09-27.** @acexode: "3.79 was my error (I paired the dark value
`#8A8277` against the light surface). Your 4.12 / 4.56 are correct; contract
stays at ≥ 3.0. Continuing rather than blocking was the right call."

Confirmed to the digit: `contrastRatio('#8A8277', '#FFFFFF')` = **3.79** — the
dark `border-strong` against the light `surface`. A cross-theme pairing, which
produces a plausible-looking number that means nothing, because no user ever
sees those two colours together.

Worth keeping rather than just deleting, because it is an easy mistake to repeat
and it looks right. `tests/acceptance/design-system/tokens.acceptance.test.ts`
now pins the correct within-theme figures (4.12 and 4.56) **and** the erroneous
cross-theme one (3.79), asserting they differ. If anything starts mixing themes
again, that test fails and names the number.


---

## Hook design flaw, found and fixed
**Date:** 2026-09-27 · **Raised by:** the lead being blocked by its own hook

`.claude/hooks/protect-paths.mjs` documented `KASUWA_LEAD_SESSION=1` as the
lead's escape from the protected paths. It is not usable: an agent cannot set
its own session's environment, so the lead was blocked from the paths the lead
owns, and the only way through was to route around the hook with a shell
command — precisely the habit the hook exists to discourage.

The hook now also allows edits on a `lead/*` branch, which the lead can actually
set and which is visible on the pull request. This is **not** a control: any
session could name its branch `lead/…`. That is acceptable because the hook was
never a control (D-L16, and `.claude/hooks/README.md`). The controls are CI's
label gate and branch protection, neither of which an agent can set.

The general lesson, worth remembering when the next guardrail is written: a
guardrail whose documented escape hatch does not work does not fail safe. It
teaches people to bypass it, and then the bypass becomes the habit for the cases
that mattered.

---

## D-A4 and D-A5 — still unanswered after three asks
**Status:** OPEN · asked 2026-09-26, 2026-09-27, 2026-09-27

Both have come back as bracketed placeholders each time
(`[number]`, `[names / "no"]`). Recording the pattern rather than re-asking a
fourth time in the same words.

**Neither blocks day-to-day work.** Task files carry the agreed interim budget
(3 sessions, escalate on the 4th, spend reported weekly), and the pilot tasks
can all start.

**What each actually costs if it stays open:**

- **D-A4** — the lead cannot plan a month or say no to work on budget grounds.
  The consequence is discovering the ceiling by hitting it.
- **D-A5** — this is the named mitigation for the single largest risk in the
  delivery model (Addendum A1 section 3.5: tests pass, behaviour is wrong).
  Thirteen agents of the same model class reviewing each other does not catch a
  requirement that every one of them misread. Only the BPO floor does.
  **"No" is a perfectly good answer** — it costs timeline, not correctness, and
  it lets the milestone plan be honest. Silence is the only answer that cannot
  be planned around.


---

## Pending acceptance tests — reconciling D-L23 with the CI stop condition
**Date:** 2026-09-27 · **Decided by:** lead (reversible, recorded for traceability)

D-L23 says no task is assigned until its acceptance tests exist and **fail for a
real reason**. STANDING ORDERS item 5 makes **CI red on `main`** a stop-the-line
condition. Taken together those are contradictory: a backlog of properly-written
acceptance tests for unstarted work is, by definition, a red build.

Resolving it by weakening either side would have been worse. Keeping `it.todo`
stubs (the old approach) satisfies CI and holds nobody to anything. Committing
failing tests to the blocking suite makes "CI is red" mean "there is a backlog",
and once that is true nobody treats red as a stop condition again.

**Decision:** acceptance tests for unassigned work live in
`*.pending.acceptance.test.ts`.

- They are **real tests with real assertions**, and they fail.
- The `isolation` project — the blocking gate — excludes them.
- A new `pending` project runs exactly them: `pnpm test:pending`. That is what a
  builder runs before starting, and what they should see go red.
- **Assigning a task means renaming the file to drop `.pending`.** From that
  moment CI enforces it.
- `pnpm verify:tasks` fails if a task is marked `assigned` or `in-progress`
  while its tests are still pending, so the rename is not optional. Negative-
  tested: flipping T-0001 to `assigned` fails the check by name.

**Known weakness, stated rather than discovered later:** a pending test can pass
vacuously. T-0001's suite has ten tests; six fail because the endpoints do not
exist, and four pass — the two indistinguishability ones pass because *both*
requests 404 identically, which is true and meaningless. They become real the
moment the endpoints exist. The lead should read a pending suite's failures and
ask whether the passes are load-bearing, rather than counting red.


---

## D-A4 — Budget ceiling: the question needs reframing before it has an answer
**Answered:** 2026-09-27 (lead default, **please override with a number**)

You asked four times for a *weekly ceiling in USD against the Anthropic API*.
Rather than ask a fifth time, I measured what is actually being metered.

### There is no USD meter on this account

This work runs on a **Claude Code Team plan**, not API billing. What the account
has is usage *windows*, not a dollar spend: a 5-hour limit and a weekly limit,
reported as percentages. `extraUsage` is **disabled**, so there is no overage
charge accruing either.

A USD ceiling would therefore be a number that corresponds to nothing being
measured. The meter that exists — and the one that will actually stop work — is
**percent of the weekly allowance**.

### What one session costs, measured

At the point of writing, account usage was:

| Window | Used |
|---|---|
| 5-hour | 12% |
| Weekly · all models | **18%** |
| Weekly · Fable | 8% |

That 18% is **account-wide for the week**, so I cannot attribute all of it to
this session — I can only say this session is the dominant consumer today.
Treat it as an order-of-magnitude anchor, not an attribution.

What it bought: the scaffold (PR #1), the Design v1.1 token import (PR #2), and
PR #3 — acceptance tests, the design intake, P01 filing, T-0007, the pending
convention. Roughly three substantial lead PRs.

**So the weekly allowance supports on the order of five sessions of this size.**

### The finding that matters more than the ceiling

**Twelve builder agents and the lead all draw on this same weekly allowance.**

One long lead session consumed something close to a fifth of the week. The
delivery model in Addendum A1 section 3.6 assumes agents run in parallel, and
section 3.2 puts thirteen of them on the roster. On these numbers the plan does
not have the capacity for that, and the constraint arrives well before the
timeline does.

I am flagging this as a **planning input, not a crisis**: I am extrapolating
from a single session, I do not know the Team plan's per-seat structure, and I
do not know whether others share this account. But it is the first hard number
we have about delivery capacity, and it points the opposite way from "parallel
agents compress the schedule".

**Worth checking before scaling past the pilot week:** whether the plan's
capacity is per-seat (so adding agent sessions adds allowance) or pooled (so it
does not). That single fact changes the roster plan.

### Lead default, pending your number

- **Ceiling: the lead agent may consume up to 35% of the weekly all-models
  allowance.** Pause at 90% of that (≈31.5%), per your mechanism.
- Leaves ~65% for builder agents and your own interactive sessions.
- STATUS.md reports consumption per cycle as a delta in percentage points,
  which is the unit that is actually measured.
- Reviewed weekly, as you specified.

Reversible in one edit. If you would rather have a USD ceiling, that means
moving this work to API billing or enabling extra usage — a real decision with
its own trade-offs, not a config change.

---

## D-A5 — Milestone UAT: taking your stated fallback
**Answered:** 2026-09-27 (adopting the alternative you wrote, reversible)

The names came back blank a fourth time, but you wrote the alternative out:
*"No; extend milestone timeline accordingly and rely on adversarial QA + my own
UAT."* Taking that as the answer rather than asking again.

**Operating assumption:** no supervisor or QA-lead UAT. The compensating
controls are Agent 12's adversarial testing and your own UAT.

**What that costs, stated plainly so it is not a surprise later:**

- Addendum A1 section 3.5 names floor UAT as the mitigation for the model's
  largest risk — thirteen instances of one model class misreading a requirement
  the same way. Agent 12 catches what it can *think to test*; it shares the
  blind spot. Your own UAT is real but is one person's attention.
- The MVP estimate in section 3.6 assumed a 4–6 week shadow-mode pilot with the
  floor. Without supervisors in it, that pilot either takes longer to surface
  the same problems or surfaces fewer of them. **I am planning MVP as 4.5–6
  months rather than 3.5–5**, and will say so in the milestone plan.
- The failure this most likely produces is not a bug. It is a screen that works
  exactly as specified and that a Lagos collections agent cannot use at pace.

**Reversible the moment names appear** — if a supervisor becomes available for
even one milestone, the highest-value place to spend them is the first pilot of
the agent workspace, not a later one.


---

## D-A4 — capacity answered; the cap is being measured
**Updated:** 2026-09-27 (supersedes the reframing above)

**Seats are per-user, not pooled.** That answers the capacity question I raised
and removes the concern: the roster in Addendum A1 section 3.2 does fit, because
each agent gets its own seat window rather than competing for one.

**Consequence, and it is an action not a note:** one seat per agent (or an API
key) must be provisioned **from week 3**, when the roster scales past the pilot
five. Thirteen agents means thirteen seats. That is a procurement lead time, so
it starts before week 3, not during it. Tracked in `STATUS.md`.

**Extra usage is now enabled on the org.** The monthly per-seat cap is still
blank, and @acexode's instruction is *"measure first"* — so this is deferred by
decision, not blocked. Each cycle reports **both** numbers: the seat-window
percentage and extra-usage dollars for the run. After a week of real runs the
cap is set from data instead of from my extrapolation.

Interim guard unchanged: the lead pauses at **31.5%** of its weekly seat window.

---

## D-A5 — one supervisor may be available
**Updated:** 2026-09-27

@acexode will try to secure one supervisor for the **first agent-workspace
pilot** — which is where I recommended spending them, so the plan does not
change.

The MVP replan to 4.5–6 months stands until that is confirmed. If the supervisor
materialises, the estimate moves back toward 4–5 months; one pilot with a real
agent on a real floor catches a different class of problem than any amount of
adversarial testing, because it catches *"works as specified and is unusable"*.

---

## D-L24 — created
**Done:** 2026-09-27

Scheduled task `kasuwa-lead-cycle`, three runs per weekday at 08:00, 13:00 and
18:00 WAT, through the app's own scheduler. First run 08:00 on 2026-09-28.
Documented in `OPERATIONS.md`.

The standing orders now live in `team/STANDING-ORDERS.md` rather than in a chat
transcript. They had to: a scheduled run starts with no memory of the
conversation, and instructions that exist only in a session do not survive it.

**One honest weakness, recorded in `OPERATIONS.md` and repeated here.** The
`STOP` file, the budget pause and the CI-red check are all enforced by the cycle
*following its own prompt*. That is weaker than the wrapper script the OS-cron
design would have given, where a script refuses to launch the agent at all. It
is the trade for running supervised inside the app.

The guards that do **not** depend on the agent's cooperation are branch
protection and the CI label gate. **Branch protection on `main` is therefore
what makes this arrangement safe**, and it was committed to before PR #2 —
worth verifying it is actually on before leaning on the schedule.

---

## D-L25 — how D-L23 applies to a task whose deliverable is tests
**Decided:** 2026-09-27 · lead decision, reversible

D-L23 says no task is assigned until its acceptance tests exist and fail for a
real reason. T-0004 is the one task on the board where applying that literally
would defeat the task.

T-0004's deliverable **is** a set of adversarial tests. If the lead writes the
attacks first, Agent 12 inherits the lead's imagination, and the independence
the task exists for is gone before it starts. The value of T-0004 is entirely in
the attack nobody listed.

The risk is concrete, not theoretical: the tenancy scaffold and the tests
asserting it works were written by the same model in the same session. That is a
correlated blind spot by construction, and it is what Agent 12 is for.

**Resolution.** For a task whose deliverable is tests, the lead writes acceptance
tests asserting the **shape of the deliverable**, not its content:

- the stub's todos became real tests
- there are **more** tests than the stub listed — a transcription of the lead's
  nine guesses is the failure mode, so the tenth test is the deliverable
- the suite runs inside the blocking isolation gate
- the diff does not touch tenancy implementation (report defects, do not fix
  them — fixing makes the finder the author and costs the independence)
- a completion report exists that either names a new attack class or says
  plainly that none was found

Committed at `tests/acceptance/platform/authz-matrix.pending.acceptance.test.ts`.

**The weakness, stated.** "More than nine tests" is a count, and a count can be
satisfied by padding — which the task's own definition of done explicitly asks
Agent 12 not to do. The assertion is a prompt for a conversation on the PR, not
a control. A truthful "I could not break it beyond these nine" is a better
outcome than a tenth variation, and reviewing which one happened is a human
judgement that no assertion replaces.

---

## D-P1 — how the seven UI languages are translated
**Answered:** 2026-09-27 by @acexode

- **Native-speaker review** for `ha`, `ig`, `yo`, `pcm` (Outsource Global has
  speakers of all four).
- **Professional translation** for `fr` and `sw`.
- **A language without a named reviewer stays unoffered.**

This is the lead's recommendation, accepted as offered.

**What it means in practice, spelled out because it is easy to read as
permission to ship seven languages.** No reviewer has been named yet and no
professional translation has been bought. Until both change, the honest state of
the product is: **English offered, six languages pending.** The completeness
gate T-0009 builds is what makes that safe — an unfinished locale is simply not
in `SUPPORTED_LOCALES`, so nothing has to be audited by hand before a release,
and a language becomes offered because it is complete rather than because
someone edited a list.

**Still outstanding:** the named reviewer per language. Four names unblock four
languages. That is the whole remaining cost for `ha`, `ig`, `yo` and `pcm`.

---

## D-L26 — the lead executes tasks through builder subagents
**Decided:** 2026-09-27 by @acexode

**The gap this closes.** Six tasks were ready and no builder had ever run.
"Assigning" a task wrote a file; it did not start an agent. The backlog was
filling faster than it was emptying, and the lead was measuring readiness rather
than delivery — which is the wrong number to be optimising, and it was not
obvious from `STATUS.md` because "tasks ready" went up every cycle.

**The change.** From this cycle the lead executes ready tasks using builder
subagents: one per task, each in its own git worktree, under the persona
matching the task's owning agent. The lead reviews the result and opens the PR.
Order set by @acexode: T-0008 and T-0009 first, then T-0001 and T-0002.

**Honest note on how this started.** The instruction said to use "the matching
`.claude/agents` persona". Only three personas existed and all three were
**read-only reviewers** — there were no builder personas to match. They were
written as part of this change (`builder.md` plus one per pilot agent), and the
first two builders ran with their persona passed inline, because a persona file
written mid-session does not register as a selectable subagent type until the
session restarts. Recorded because the instruction assumed something that was
not there, and the gap is worth knowing about rather than quietly papering over.

**What does not change.** Every quality gate. Builders cannot edit
`tests/acceptance/` — a hook and CI both block it. Builders do not push and do
not open pull requests. Nobody merges their own work. The isolation suite stays
blocking, and a builder that turns it red is a stop-the-line event.
