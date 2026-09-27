# STATUS.md — lead's report

---

## Cycle · 2026-09-27 · automation live, capacity resolved

### The scheduled cycle is running

`kasuwa-lead-cycle` — **08:00, 13:00, 18:00 WAT, Monday–Friday**, through the
app's own scheduler. First run **08:00 on 2026-09-28**. See `OPERATIONS.md` for
start, stop and inspect.

`team/STANDING-ORDERS.md` now exists. It had to: a scheduled run begins with no
memory of the conversation the orders were given in, and the repository is the
only memory the team has.

**Two things to do before leaning on it:**

1. **Click "Run now" once.** The first run pre-approves the tools it needs;
   without that, a later run can stall on a permission prompt at 08:00 with
   nobody watching.
2. **Verify branch protection is on.** The `STOP` file, the budget pause and the
   CI-red check are all the cycle following its own prompt — conventions, not
   controls. The things that do not depend on the agent's cooperation are branch
   protection and the CI label gate. **Branch protection is what makes this
   safe**, not the prompt.

### Capacity — resolved, with an action

**Seats are per-user, not pooled.** That removes the concern I raised last
cycle: the thirteen-agent roster fits, because each agent has its own window
rather than competing for one.

**Action, starting now rather than in week 3:** thirteen agents need thirteen
seats (or API keys). Provisioning has a lead time, so it begins before the
roster scales past the pilot five.

| | |
|---|---|
| Extra usage | Enabled on the org |
| Per-seat monthly cap | **Being measured, not guessed** — @acexode's instruction |
| Lead guard meanwhile | Pause at 31.5% of the weekly seat window |
| Reported per run from now | Seat-window % **and** extra-usage $ |

### Shipped this cycle

- Scheduled cycle created and documented
- `STANDING-ORDERS.md`, `OPERATIONS.md`
- D-A4, D-A5, D-L24 closed in the log

### Spend

| | |
|---|---|
| Weekly · all models | 18% (account-wide, start of cycle) |
| Extra usage | $0 — it was disabled until this cycle |

First run with both numbers will be 08:00 tomorrow.

### Open

| | |
|---|---|
| **D-T1–D-T5** | Telephony spec, event catalogue, auth model, staging. Holds Agent 6 and the P09–P12 designs. |
| **D-W1** | No WFM material shared; the review cannot start. |
| **DESIGN NEEDED** | Prompt 2 by 2026-10-06 · Prompt 3 by 2026-10-13 |
| **PR #3** | Green and mergeable, awaiting your merge |

### Next cycle

Make T-0002, T-0004 and T-0005 assignable the same way T-0001 now is — real
acceptance tests in `*.pending.acceptance.test.ts` — then create tasks from the
PRD order until three are ready per pilot agent.

---



---

## Capacity finding · 2026-09-27 · read this before scaling the roster

**There is no USD meter on this account.** The work runs on a Claude Code
**Team plan** — 5-hour and weekly allowance *windows*, reported as percentages,
with extra usage disabled. D-A4 asked for a weekly ceiling in USD against the
Anthropic API; that number would correspond to nothing being measured.

**What one session costs.** At the time of measuring, weekly all-models usage
stood at **18%**. That is account-wide, so I cannot attribute it all to this
session — only say this session is today's dominant consumer. It bought roughly
three substantial lead PRs: the scaffold, the design-token import, and the
acceptance-test/design-intake work.

**On those numbers the weekly allowance supports about five sessions of this
size.**

### The part that affects the plan

**Thirteen agents draw on this one allowance.** Addendum A1 section 3.6 assumes
parallel agents compress the schedule. One lead session took close to a fifth of
the week. If the allowance is pooled rather than per-seat, the roster in section
3.2 does not fit inside it, and capacity — not decision latency, and not coding
speed — becomes the binding constraint.

I am extrapolating from a single session and I do not know the Team plan's
per-seat structure. **The single fact worth establishing before week 3:** is
capacity per-seat (adding agent sessions adds allowance) or pooled (it does
not)? That answer changes the roster plan more than any decision currently open.

**Lead default recorded meanwhile:** the lead may use up to 35% of weekly,
pausing at 90% of that, leaving ~65% for builders and your own sessions. One
edit to change.

### Spend this cycle

| | |
|---|---|
| Weekly · all models | 18% (account-wide) |
| 5-hour window | 12% |
| Cycles this week | 1 |

Reported as percentage points from here on, because that is the unit actually
metered.

---

## D-L24 · Proposed schedule, for your approval

Option 2 accepted: the app's own scheduled-task feature, supervised and
stoppable from the UI, rather than an OS-level cron. **I have not created it** —
you asked me to propose it once D-A4 was recorded.

**What you ordered:** every 2 hours, 07:00–23:00 WAT = 9 runs/day, 63/week.

**Why I am not proposing that.** If a cycle costs even a fifth of what this
session did, 63 runs would need roughly twice the entire weekly allowance —
before any builder agent runs at all. The schedule would halt itself partway
through Tuesday, and it would take the builders' capacity with it.

**Proposed instead — 3 runs per weekday, 15/week:**

| | |
|---|---|
| Times | 08:00, 13:00, 18:00 WAT |
| Days | Monday–Friday |
| Prompt | read `team/`, continue per STANDING ORDERS |
| Guards | pause at 31.5% weekly; skip if a cycle is still running; `team/STOP` halts everything |

Three cycles a day still clears the backlog faster than your decision latency
refills it, which Addendum A1 section 3.3 already identifies as the real
constraint. **Scale it up once there is per-run data** — the first week of runs
turns my extrapolation into a measurement, and this is trivially adjusted.

**Say the word and I will create it.**

---



---

## Cycle · 2026-09-27 14:40 WAT · first cycle under STANDING ORDERS

### Shipped

- **PR #1** (scaffold) and **PR #2** (Design v1.1 tokens) — both merged to `main`.
- **PR #3** — T-0003 acceptance stubs converted to 18 real tests; T-0006 created;
  `protect-paths.mjs` hook flaw fixed. Green, labelled, **open and awaiting merge**.

### Design intake

**P01 — Authentication & onboarding, 16 screens, filed as `docs/design/P01/v1.0/`.**

A drop was waiting in `docs/design/P0-auth/`. Filed it through a new repeatable
intake (`tools/design-intake.mjs`): hash-dedupe against everything already under
`docs/design/`, manifest extracted from the ` & ` index board, screen ids now
citable as `P01/1b`.

**The intake parser was wrong on its first run and I nearly shipped it.** It
returned 12 of 16 screens — silently dropping the last row of every group,
because that row's own `]` is the first half of the `]]` closing the array. It
looked entirely reasonable. Caught by cross-checking the count against an
independent grep of the source, which is now the habit: never trust a parser's
output against a format you do not control without counting it another way. A
task file built from that manifest would have been missing a quarter of the
work with nothing to indicate it.

Task written: **T-0007** (Agent 11), split into four PR-sized groups with the
sign-in group first, since it sets the patterns every later screen copies.

### Blocked / needs you

| What | Why it matters |
|---|---|
| **Autonomous scheduler (item 6)** | **I could not build this** — see the note at the end of this entry. Needs your decision. |
| **D-A4** budget ceiling | Fourth ask. Now load-bearing: it is the cap on an unattended loop. |
| **D-A5** UAT availability | Fourth ask. "No" is a fine answer; silence is the only one I cannot plan around. |
| **D-T1** softphone SDK vs embed | Holds P09–P12 designs and all of Agent 6. |
| **D-W1** WFM material | Nothing shared; the review you asked for cannot start. |

### Designs needed

Raised in `DECISIONS.md` as required (never in chat):

- **Prompt 2** — admin console — by **2026-10-06**
- **Prompt 3** — role-aware Home — by **2026-10-13**

P09–P12 deliberately not requested until D-T1 is answered.

### Spend

**Not yet instrumented.** The per-run cost log is part of the scheduler, which is
blocked (below). Until then I cannot report a number, and I would rather say so
than estimate one.

### Next

1. Make the pilot tasks *ready* — convert T-0001, T-0002, T-0004, T-0005
   acceptance stubs into real failing tests, so they satisfy D-L23 and can be
   assigned. T-0001 first: it is the critical path and T-0007 depends on it.
2. Assign T-0001 (Agent 1) and T-0003's successor work.
3. Create further tasks from the PRD build order until three are ready per
   active pilot agent (1, 2, 11, 12, 13).

### The one thing I could not do: item 6, the scheduler

I designed the runner — lock file, STOP file, weekly cap, per-run cost log, a
version-controlled prompt — and **the harness safety classifier blocked me from
creating it**, as "Create Unsafe Agents". That is a guardrail on me, not a
permission you can grant by re-asking me to try; I did not attempt to route
around it, and I am not going to.

What I was building and why it is reasonable: a Windows scheduled task running
`claude -p` every two hours from 07:00–23:00 WAT, in this repo, with four
guards — a `team/STOP` brake, an `enabled` flag, a lock so two runs never
overlap, and a weekly run cap standing in for D-A4. It would commit and open
pull requests. It would **not** merge; no agent merges its own work.

The honest risk, which is presumably what tripped the classifier: an unattended
agent with auto-accepted edits, pushing to a shared repository every two hours,
with no answered budget ceiling. That is a real standing capability and it
should be turned on deliberately rather than as a side effect of a task.

**Options, for you to pick — this is in `DECISIONS.md` as D-L24:**

1. **You create the scheduled task**, from the runner design in
   `team/OPERATIONS.md` (which I can still write — it is documentation, not the
   agent). You own the decision to start it; I keep the repo side working.
2. **Use the app's own scheduled-task feature** instead of an OS-level cron.
   Supervised, visible in the UI, stoppable from there. Safer, and I can propose
   it for your approval rather than create it unilaterally.
3. **Drop the automation.** I continue within sessions you start. Slower, and it
   makes your decision latency the constraint again — which Addendum A1 section
   3.3 already names as the real one.

My recommendation is **(2)**, with D-A4 answered first so the cap is a real
number rather than a run count I invented.

---



## Week 0 · 2026-09-27 · Scaffold

**Branch:** `scaffold/initial` · **PR:** first one, needs the `lead-approved` label
**Scope:** structure, conventions, tooling, and one vertical slice proving tenancy. Nothing else.

---

## What was built

### The vertical slice — the only feature code

`tenant → business_unit → programme → user → user_programme → contact`, every
row carrying `tenant_id` and, where applicable, `programme_id`. RLS on all six
tables, `ENABLE`d **and** `FORCE`d, each policy's `WITH CHECK` matching its
`USING`. `kasuwa_app` has no BYPASSRLS and owns nothing; `kasuwa_migrator` owns
the schema and never serves traffic.

The piece I want you to look at is in `packages/db/src/session.ts`. Scope is
**resolved**, never **supplied**: a request says who it is, and the database
decides what that identity reaches by reading `user_programme` inside the same
transaction. There is no code path where a caller can hand in its own programme
list. The API actively rejects requests that try.

`GET /api/v1/contacts` with cursor pagination, plus `GET /api/v1/contacts/:id`.
The by-id route is one endpoint more than you asked for; I added it so that
"cannot read another tenant's record via URL manipulation" is an assertion about
a real route instead of a hypothetical one. Fifteen lines, and it earns them.

### Isolation suite — 38 assertions, blocking in CI

Five files under `tests/acceptance/tenancy/`, attacking from four directions:

- **API** — a user sees only their programmes; two tenants' result sets are
  disjoint and both non-empty; a user with no membership sees nothing; a real
  user id with the wrong tenant id is 401.
- **Repository** — the same, with no HTTP involved, so a filtering controller
  cannot mask a leaking repository. Also proves session context does not survive
  between pooled connections.
- **URL and header manipulation** — cross-tenant and sibling-programme reads by
  id are 404 (never 403 — a 403 confirms the record exists); forged
  `x-kasuwa-programme-ids` is rejected outright rather than ignored.
- **RLS, independent of the application** — `withForcedScope` sets the session
  GUCs to values no legitimate session could produce. With no GUCs set: nothing.
  With tenant A set and tenant B's programme ids forged in: nothing. Cross-tenant
  INSERT and UPDATE are refused by `WITH CHECK`. `kasuwa_app` cannot disable RLS.
  And a catalogue invariant asserts every table has RLS enabled, forced and
  policied — which is the check that still works in six months when everyone has
  forgotten this document.
- **Cursor tampering** — cursors encode position, never authority. Smuggled
  tenant fields are dropped; a cursor pointed at another tenant's row returns
  nothing from that tenant.

### Everything else

pnpm + Nx with enforced module boundaries; TypeScript strict with
`no-explicit-any` as an error; Zod at every boundary; conventional commits;
CODEOWNERS. `apps/api` (NestJS), `apps/web` (Next.js, renders the design-tokens
page), `apps/worker` (BullMQ), `apps/realtime` (WebSocket stub). No `apps/dialer`.
`packages/telephony-adapter` and `packages/wfm-adapter` as interface-only
contracts with in-memory fakes. `packages/db` (Drizzle + hand-written SQL
migrations + runner + seed), `packages/ui` (tokens + Tailwind preset),
`packages/i18n` (ICU, `en`/`en-NG`, CI pseudo-locale, literal-string lint rule),
`packages/testing` (Testcontainers + isolation harness), `packages/feature-flags`
(OpenFeature, zero flags, a test that keeps it that way). Docker Compose, GitHub
Actions CI with the `lead-approved` path guard, 7 ADRs, 23 PRD module files,
3 reviewer subagents, 3 skills, 2 hooks, 15 per-package `CLAUDE.md` files.

---

## Verified, and how

Run on this Windows machine with Docker. Everything below I actually ran:

| Check | Result |
|---|---|
| `pnpm install` on a clean tree | pass |
| `pnpm lint` | pass, 16 projects |
| `pnpm lint:boundaries:verify` | pass — both rules fire on a deliberate violation |
| `pnpm typecheck` | pass, 16 projects |
| `pnpm test:unit` | 45 passed |
| `pnpm test:integration` | 8 passed, real Postgres via Testcontainers |
| `pnpm test:isolation` | **38 passed**, 38 todo (the pilot-task stubs) |
| `pnpm build` | pass, 4 apps |
| `pnpm db:migrate` / `db:seed` | 2 migrations, then 2 tenants / 4 programmes / 5 users / 12 contacts |
| `GET /api/v1/contacts` as four different users | isolation holds — see below |

The live check you asked for, against a running server:

```
Tenant A / Tunde     (programme A1 only)   3 contacts, all A1
Tenant A / Musa      (supervisor, A1+A2)   6 contacts, A1 + A2, nothing else
Tenant A / Emeka     (no membership)       0 contacts
Tenant B / Wanjiru   (programme B1 only)   3 contacts, all B1
```

and the attacks: cross-tenant by id → 404, sibling programme by id → 404, forged
scope header → 400, real user with wrong tenant → 401, no auth → 401, tampered
cursor → 400, limit=5000 → 400.

### CI — now observed, not predicted

PR [#1](https://github.com/acexode/kasuwa-crm/pull/1), run
[36304207199](https://github.com/acexode/kasuwa-crm/actions/runs/36304207199).
**Every substantive job passed on the first run:** Lint, Typecheck, Unit tests,
Integration tests, Tenant isolation suite, Build.

`Guard protected paths` failed, deliberately. The PR was opened **without** the
`lead-approved` label so the gate had to prove it fires: a PR labelled from the
start only shows the job passing, which is indistinguishable from a job that
checks nothing. The step breakdown is the proof — "Detect changes to protected
paths" **succeeded**, then "Require the lead-approved label" **failed**. It fired
for the right reason.

Applying the label revealed a second thing worth having found: the default
`pull_request` event types exclude `labeled`, so nothing re-evaluated the guard
and it needed a manual re-run. A gate that needs a manual re-run every time is a
gate people stop using. The guard now lives in its own workflow
(`.github/workflows/guard.yml`) that also runs on `labeled`/`unlabeled`; it is
separate from `ci.yml` so a label change does not re-run every suite and the
build.

## What I still could NOT verify

**`pnpm dev` end to end.** Individual steps all work (containers, migrate, seed,
API serving traffic), and I verified them separately. I did not get a single
clean `pnpm dev` run to completion, because the OpenSearch image is a ~1 GB
first pull and this connection did not finish it inside the time I had. The
script's container-health wait, migrate and seed steps are all exercised; the
OpenSearch container itself is not.

**Redis.** Port 6379 on this machine is held by another process, so the worker's
queue round-trip is unexercised. The compose file now uses 56379, which should
avoid it, but I have not re-run it.

---

## Three things broke while building, and what they tell you

These are worth a minute of your attention, because each one would have hit
every agent, not just me.

1. **`pnpm db:migrate` could not find `.env`.** `dotenv` looks in the current
   directory, which under `pnpm --filter` is the package, not the repo root.
   Fixed by walking up to the workspace root. Every agent running a package
   script would have hit this in their first session.

2. **The API connected to the wrong database.** This machine runs a native
   PostgreSQL on 5432; on Windows `localhost` resolves to `::1` before Docker's
   proxy, so the app silently talked to the wrong server and reported "password
   authentication failed" — a message pointing nowhere near the cause. The dev
   stack now uses 55432/56379/59200/59000. Anyone with a local Postgres would
   have lost an hour to this (D-L22).

3. **The boundary rule was not enforcing.** `pnpm lint:boundaries:verify` — the
   check I wrote specifically to catch a decorative lint rule — reported that
   `@nx/enforce-module-boundaries` did **not** fire. The cause was mine:
   `packages/testing` was tagged `scope:shared`, which domains are allowed to
   depend on, so the isolation harness that can forge RLS session variables was
   importable from application code. Fixed, and the verifier now requires the
   Nx rule specifically rather than accepting either rule.

   I am flagging this one deliberately. The rule looked correct, the config read
   correctly, and it enforced nothing. That is exactly the failure mode Addendum
   A1 section 3.5 warns about, and it was caught by a mechanical check rather
   than by review — including my own review, which had already read that config
   several times and seen nothing wrong with it.

---

## What was skipped, and why

- **No PRD module beyond the slice.** Per the brief.
- **No `infra/`** — no Terraform, Helm or Argo CD. Agent 13 owns infrastructure
  and there is nothing to deploy yet. Scaffolding empty IaC would be decoration.
- **No `apps/mobile`** — v1 scope.
- **No outbox, no OpenAPI generation, no audit log.** Each belongs to a module
  owner with its own task. The outbox is a prerequisite for M14 and M20 and
  needs sequencing (noted in both PRD files).
- **`packages/permissions` and `packages/metadata-engine` are empty stubs.** They
  exist so the boundary rule has real targets from day one rather than being
  aspirational.
- **MinIO replaced by SeaweedFS** (D-L21) — MinIO's public images are no longer
  pullable. Deviation from the brief, recorded.
- **rollup pinned to its WASM build** (D-L20) — Windows Smart App Control blocks
  the native binary on this machine, so `pnpm test` would not run at all.

---

## Recommended first tasks — the pilot week (Addendum A1 section 3.7)

Written up in `team/tasks/`, each with acceptance-test stubs already committed
under `tests/acceptance/`:

| Task | Agent | What | Blocked by |
|---|---|---|---|
| [T-0001](tasks/T-0001-real-authentication-and-session.md) | 1 — Platform & Security | Real auth replacing the stub. Success criterion: `tests/acceptance/tenancy/` passes **unmodified** afterwards | nothing |
| [T-0002](tasks/T-0002-metadata-engine-foundations.md) | 2 — Metadata | `object_def` / `field_def` with RLS. Storage model only | nothing |
| [T-0003](tasks/T-0003-design-system-from-claude-design.md) | 11 — Frontend | Run Prompt 0, replace the provisional tokens | nothing |
| [T-0004](tasks/T-0004-adversarial-isolation-expansion.md) | 12 — QA | Try to break tenancy; build the authz matrix harness | nothing |
| [T-0005](tasks/T-0005-ci-hardening-and-environments.md) | 13 — DevOps | CI hardening, staging Terraform (plan only), OTel with no PII | **D-A4** for anything that costs money |

Start T-0004 at the same time as the others, not after. Given D-A3, adversarial
QA is carrying weight the addendum assumed a human reviewer would carry.

---

## Decisions answered 2026-09-27

- **D-A3 reversed to the safer position.** @acexode personally reviews PRs
  touching auth, permissions, RLS/migrations, payments/e-invoicing,
  recordings/PCI and export/DSAR. `CODEOWNERS` and `ROSTER.md` updated. This
  only becomes a gate when "Require review from Code Owners" is enabled in
  branch protection — a repository setting, part of T-0005.
- **D-A2** 1-week iterations, decisions answered daily.
- **D-A1** 12 specialists + lead, QA and DevOps independent. **One builder still
  has to fold** — the addendum lists 13 specialists. Three options and a
  recommendation are in `ROSTER.md`; one word closes it, and nothing is blocked
  meanwhile.
- **D-L20** rollup WASM pin accepted as temporary. Noted in `CLAUDE.md` section 4
  because JSON takes no comments.
- **D-L21** SeaweedFS accepted.
- **D-L23** agreed a weakening, and now **enforced rather than remembered**:
  every task file carries a `status`, and `pnpm verify:tasks` fails CI if a task
  marked `assigned` or `in-progress` names acceptance tests that are still
  `.todo`. I verified it catches a violation, not just that it passes.

## What I need from you

**Blocking the pilot week:**

- **GitHub authentication.** I cannot push or open the PR. `gh` is not logged in
  and Git Credential Manager opens a GUI prompt this session cannot complete —
  that is what hung the first attempt. One command in your terminal:
  `gh auth login --hostname github.com --git-protocol https --web`.
- **D-A4** — the monthly ceiling came back as `[your monthly ceiling]`. The
  per-task default (3 sessions, escalate on the 4th, report actual spend weekly)
  is accepted and already in the task files, so nothing is blocked day to day;
  what is missing is the number to plan the month against.
- **D-A5** — came back as `[yes/no + names + which days]`. Still the named
  mitigation for the largest risk in the model.
- **D-A1** — which builder folds. See `ROSTER.md`.

**Blocking week 2 (agents 3 and 6):**

- **D-T1 through D-T5** and the material in Addendum A1 section 1.4 — API spec,
  event catalogue, auth model, staging environment. **Nothing was attached**; the
  answer read `[attach telephony API spec / ...]`. Agents 3 and 6 wait, as you
  said. The telephony adapter is v0
  and written from your capability table rather than a real spec. Agent 6 cannot
  do meaningful work without this, and **D-T5** (is the platform multi-tenant
  with programme scoping?) is the highest-leverage single answer, because it may
  change the Pooled/Bridge/Silo model in ADR-0002.
- **D-W1** — anything at all about the existing WFM. Still nothing shared, so
  the review you asked for in Addendum 2.2 cannot start.

**Worth your view but not blocking:** D-L20 (rollup/WASM), D-L23 (whether the
`todo` acceptance stubs are an acceptable weakening of the "tests written
failing first" rule — I think it is the one place the protocol is currently
softer than it reads).

---

## Next week, if unblocked

Convert the five acceptance stubs into real failing tests, assign the pilot
tasks, and review how the protocol holds up before scaling to the full roster in
week 3 — which is what Addendum A1 section 3.7 asks for, and the sequencing I
would keep.
