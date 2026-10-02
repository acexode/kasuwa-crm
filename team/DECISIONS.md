# DECISIONS.md — open decisions for the human

Format per Addendum §3.3: `id, context, options, recommendation, deadline`, plus **Blocked** (what
cannot proceed until this is answered) and **Reversibility**.

Rules of engagement:
- Where a decision is **trivially reversible**, I proceed on my recommendation and record it here as
  `PROCEEDING`. You can overturn it cheaply.
- Where it is **not** trivially reversible, or it is product-shaping, the status is `BLOCKED` and
  nothing in the code will depend on it.
- Answered decisions move to `DECISION-LOG.md` with your answer and date.

Status key: `BLOCKED` · `PROCEEDING` (recommendation adopted, reversible) · `ANSWERED` (moved to log)

Date opened: 2026-09-26 unless stated.

---

## A. Blockers for the Phase 1 scaffold PR

### D-L01 — No git repository or remote exists
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (https://github.com/acexode/kasuwa-crm)
**Context:** `C:\dev\Outsource\kasuwa` is not a git repository and there is no remote. The brief says
"work in a branch `scaffold/initial`, open one PR, wait for my review." I can create the branch
locally; I cannot open a PR without a remote.
**Options:**
1. You create an empty GitHub repo (private) and give me the remote URL + push rights.
2. I `git init` locally, commit on `scaffold/initial`, and you review the diff locally (`git diff main...scaffold/initial`); PR comes later.
3. I `git init` and you connect a remote afterwards.
**Recommendation:** (1) if you can do it now, else (2) — I will `git init` and commit on the branch so
no work is lost, and push the moment a remote exists. GitHub Actions CI cannot be *verified* running
until a remote exists; I will say so explicitly rather than claim CI passes.
**Blocked:** the PR itself, CI verification, CODEOWNERS enforcement, the `lead-approved` label gate.
**Reversibility:** n/a.

### D-L02 — CI label gate blocks its own first PR
**Status:** PROCEEDING
**Context:** The rule "CI fails if any file under `tests/acceptance/` or `packages/db/migrations/`
changes in a PR not labelled `lead-approved`" is self-blocking: the scaffold PR is the PR that
*creates* those directories.
**Options:** (a) label the scaffold PR `lead-approved`; (b) exempt PRs whose base has no such files;
(c) exempt the initial commit by SHA.
**Recommendation:** (a) — apply the label to the scaffold PR. Keep the rule dumb and strict. Also
note: GitHub labels are applied by anyone with write access, so the gate is a *convention*, not a
security control, until you restrict label permissions or move the gate to a CODEOWNERS-required
review on those paths. I recommend adding CODEOWNERS entries for those two paths pointing at you.
**Blocked:** nothing.
**Reversibility:** trivial.

### D-L03 — Monorepo tool: Nx vs Turborepo
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (Nx, ADR-0005)
**Context:** Founding pack §3.16 says "Nx (or Turborepo)". The hard requirement is *enforced* module
boundaries: `packages/domain/*` may depend on `db`, `permissions`, `metadata-engine`, never on
another domain's internals.
**Options:**
1. **Nx** — `@nx/enforce-module-boundaries` ESLint rule enforces exactly this via project tags, at
   lint time, with a clear error. Also gives affected-graph test selection for the post-edit hook.
   Cost: heavier config, a daemon, more opinionated generators.
2. **Turborepo** — simpler, faster to reason about, but has **no** boundary enforcement. We would
   hand-roll it with `eslint-plugin-boundaries` or `depcruise`, which is extra surface we maintain.
**Recommendation:** **Nx.** Boundary enforcement and `nx affected` are the two things this operating
model depends on most (13 agents, convention drift is the named risk, hooks need affected-test
selection). Turborepo's simplicity is not worth rebuilding both.
**Blocked:** nothing.
**Reversibility:** moderate — swapping later is a day of work, not a rewrite. Requires ADR-0005.

### D-L04 — DB access layer: Drizzle vs Kysely
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (Drizzle, ADR-0006)
**Context:** Founding pack §3.2 says "Drizzle or Kysely (SQL-first) + raw SQL for metadata engine".
**Options:**
1. **Drizzle** — schema-in-TS, ships `drizzle-kit` migrations and a runner, good RLS compatibility
   (it does not fight you about raw SQL), inferred types. Weaker at very dynamic query construction.
2. **Kysely** — best-in-class dynamic query builder (relevant later for the metadata engine's runtime
   SQL), but no migration tooling of its own; we would bring `kysely-migrator`/`node-pg-migrate`.
**Recommendation:** **Drizzle** for the schema, migrations and standard repositories; keep the door
open to using raw parameterised SQL (and later Kysely as a *query builder only*) inside
`packages/metadata-engine`, which is the one place dynamic SQL is genuinely needed. Note both are
irrelevant to RLS: policies are hand-written SQL in migrations either way.
**Blocked:** nothing.
**Reversibility:** moderate. ADR-0006.

### D-L05 — Stubbed auth context: how does the API learn tenant/programme/user before real auth?
**Status:** PROCEEDING (with a fail-closed guard)
**Context:** The slice needs `app.tenant_id`, `app.programme_ids`, `app.user_id` set per request, but
real auth (Agent 1, M2) comes later.
**Options:**
1. Dev-only request headers (`x-kasuwa-tenant-id`, `x-kasuwa-user-id`, `x-kasuwa-programme-ids`).
2. An unsigned JWT with the same claims.
3. A fixed in-process fake user selected by env var.
**Recommendation:** (1) **plus a hard fail-closed guard**: the stub provider is only registered when
`KASUWA_AUTH_MODE=stub`, and the app **refuses to boot** if `KASUWA_AUTH_MODE=stub` while
`NODE_ENV=production`. Headers make the isolation tests (including the URL/header-manipulation
cases) direct and honest. A test asserts the production refusal.
**Blocked:** nothing.
**Reversibility:** trivial — it is one provider behind an interface.

### D-L06 — Can a user be scoped to "all programmes in my tenant"?
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (no wildcard; explicit enumeration)
**Context:** Admins, supervisors and reporting users plausibly need tenant-wide reach. RLS needs to
express that. A wildcard (`app.programme_ids = '*'`) is a single character between "admin" and
"everything", which is exactly the class of bug the isolation suite exists to catch.
**Options:**
1. **No wildcard ever.** The session always carries an explicit, enumerated list of programme ids,
   computed at login from `user_programme`. Costs a list that can grow to hundreds of ids.
2. A `tenant_wide` boolean session var, with RLS reading `(tenant_wide OR programme_id = ANY(...))`.
3. A dedicated "all programmes" sentinel role in the permissions engine (M2), out of scope now.
**Recommendation:** (1) for the scaffold — explicit enumeration only. It is the safe default and it
makes the Phase 1 isolation tests meaningful. But the real answer belongs with M2 and I want yours
before Agent 1 builds the permissions engine, because retrofitting (2) means touching every policy.
**Blocked:** Agent 1's permissions-engine task (week 1/2). Not blocked: the scaffold.
**Reversibility:** low once policies exist across dozens of tables. ADR needed when answered.

### D-L07 — Database roles
**Status:** PROCEEDING
**Context:** Pack §3.3 requires the app role to have no BYPASSRLS and migrations to use a separate
role.
**Recommendation:** three roles — `kasuwa_app` (NOBYPASSRLS, no DDL, used by API/worker/realtime),
`kasuwa_migrator` (owns schema, runs DDL, used only by the migration runner), `kasuwa_test_admin`
(Testcontainers only, for harness setup). A test asserts `rolbypassrls = false` for `kasuwa_app` and
that `kasuwa_app` cannot `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. Table owners must also not be
`kasuwa_app`, since a table owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set — I will set
`FORCE` on every tenant table as belt-and-braces.
**Blocked:** nothing. **Reversibility:** trivial.

### D-L08 — Primary key strategy
**Status:** PROCEEDING — **UUIDv7 generated in application code**
**Context:** Postgres 16 has no native `uuidv7()` (that is PG18). v4 keys fragment B-tree indexes at
CRM scale (50M rows/tenant target).
**Recommendation:** UUIDv7 from a tiny library, generated in TS, with a DB default of `gen_random_uuid()`
only as a safety net for rows inserted outside the app. Revisit when we move to PG18.
**Blocked:** nothing. **Reversibility:** moderate (data migration), but the *type* stays `uuid`.

### D-L09 — i18n stack and the hard-coded-string lint rule
**Status:** PROCEEDING
**Context:** Pack §3.14 says "ICU MessageFormat (FormatJS/Lingui)"; brief requires `en`, `en-NG`, a
pseudo-locale for CI, and a lint rule that fails on hard-coded user-facing strings in `apps/web`.
**Recommendation:** FormatJS (`react-intl` + `@formatjs/cli` for extraction and pseudo-locale
generation), with `eslint-plugin-formatjs` for message correctness and a `no-literal-string` rule
(via `eslint-plugin-i18next`, scoped to `apps/web/**` with an allowlist for `className`, `data-*`,
`aria-*` attribute values that are not user-facing, and test files). Pseudo-locale `en-XA` generated
in CI, not committed. Note: `en-NG` will initially be an near-empty overlay on `en` — that is correct,
it exists to prove the fallback chain.
**Blocked:** nothing. **Reversibility:** moderate (message syntax differs between FormatJS and Lingui).

### D-L10 — Design tokens are provisional
**Status:** ANSWERED 2026-09-27 — Design v1.1 imported by T-0003. Deviations recorded in DECISION-LOG.md. One unreconciled figure (border-strong 3.79 vs measured 4.12/4.56) flagged there.
**Context:** `packages/ui` must hold colour scales, semantic tokens, type scale and spacing. Prompt 0
gives three brand anchors (indigo `#2B2A8C`, saffron `#F2A900`, green `#0B8A4B`) and "warm greys",
but no actual 50–950 scales — those come out of Claude Design.
**Recommendation:** generate perceptually-even scales from the three anchors, check every
text-on-surface pair against WCAG 2.2 AA in a unit test, and mark the file
`PROVISIONAL — replaced by Claude Design export (Prompt 0)`. Agent 11's first task is to run Prompt 0
and replace them. Nothing may hard-code a hex outside this package (lint rule).
**Blocked:** nothing, but the tokens are *not* the brand until Agent 11 replaces them.
**Reversibility:** trivial by design — that is the point of tokens.

### D-L11 — Feature-flag provider
**Status:** PROCEEDING
**Recommendation:** OpenFeature SDK with the in-memory provider, wired into API and web, exposing
zero flags. Unleash/GrowthBook evaluated when the first real flag is needed (Agent 13).
**Blocked:** nothing. **Reversibility:** trivial (that is OpenFeature's purpose).

### D-L12 — `contact` minimal fields for the slice
**Status:** PROCEEDING
**Recommendation:** `id, tenant_id, programme_id, account_id (null), display_name, given_names,
family_name, phones jsonb, emails jsonb, created_at, updated_at`. Explicitly **not** in this slice:
`consent_state`, `nin_token`, `bvn_token`, `custom jsonb`, `preferred_channel`,
`preferred_language`, network detection. Those are Agent 3's (M3) with their own acceptance tests,
and NIN/BVN need the field-encryption decision first (D-L13).
**Blocked:** nothing. **Reversibility:** trivial (additive migration).

### D-L13 — Field-level encryption for NIN/BVN
**Status:** BLOCKED for NIN/BVN (needed before M3). *Note 2026-10-02:* the envelope-encryption mechanism shipped for TOTP secrets in #39 (`@kasuwa/auth-crypto`, migration 0005) — **expand step only**; the plaintext `secret` column is still populated until a contract migration drops it. Report: `team/reports/D-L13-totp.md`.
**Context:** Pack §2.12 requires per-tenant KMS keys and blind indexes for equality search. That is a
significant design with key-rotation and search consequences.
**Options:** (1) `pgcrypto` + app-held per-tenant DEK wrapped by a KMS CMK; (2) a dedicated
encryption service; (3) tokenisation via the identity-verification provider (Smile ID/Dojah) so
Kasuwa never stores the identifier at all.
**Recommendation:** (3) where the provider supports it, falling back to (1). But this needs your
answer plus counsel's, and it shapes M3's schema.
**Blocked:** M3 contact fields carrying NIN/BVN. Not the scaffold.

### D-L14 — PRD split: verbatim or expanded?
**Status:** PROCEEDING
**Context:** Part 2 §2.7 modules are terse prioritised bullet lists. Splitting them into 23 files
gives 23 thin files.
**Recommendation:** split **verbatim** (bullets preserved exactly, so the source of truth is not
silently rewritten), then per file add: (a) addendum deltas clearly marked, (b) the relevant
cross-cutting requirements from §2.9–§2.13, (c) the user stories from §2.8 that touch the module,
(d) an `## Open questions` section listing what a builder cannot determine from the text. I will
**not** invent requirements. M9 and M11 get rewritten headers as integration modules per the
addendum, with the removed scope listed explicitly so no agent rebuilds it.
**Blocked:** nothing. **Reversibility:** trivial.

### D-L15 — Windows development environment
**Status:** PROCEEDING, flagged
**Context:** You are on Windows 11. Testcontainers and Docker Compose need Docker Desktop with the
WSL2 backend. Some Node tooling behaves differently on native Windows paths.
**Recommendation:** document Docker Desktop + WSL2 as the supported local setup; CI runs
`ubuntu-latest`. I will verify `pnpm install`, `pnpm dev` and `pnpm test` on **this Windows machine**
and report exactly what passed and what I could not verify. If Docker Desktop is not installed here,
integration and isolation tests cannot be run locally and I will say so rather than claim they pass.
**Blocked:** local verification of the Testcontainers-based suites if Docker is unavailable.

### D-L16 — Hooks cannot truly identify "the lead's session"
**Status:** PROCEEDING, flagged as a known weakness
**Context:** The brief asks for a hook that blocks edits to `tests/acceptance/` and migrations
"unless the session is the lead's". Claude Code hooks have no trustworthy session identity — any
agent session could set the same env var.
**Recommendation:** implement the hook as a **guardrail against accident, not an adversary**: it
blocks unless `KASUWA_LEAD_SESSION=1` is set in that session's environment, and prints why. The
*real* enforcement is CI (label gate) plus branch protection plus your review — those an agent
cannot set. I will document this honestly in `.claude/hooks/README.md` rather than imply the hook is
a security boundary.
**Blocked:** nothing.

### D-L17 — CODEOWNERS with non-existent GitHub teams
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (@acexode)
**Context:** CODEOWNERS referencing teams that do not exist produces repo warnings and, with
"require review from Code Owners" enabled, can make PRs unmergeable.
**Options:** (1) placeholder comments only, no active owner lines, until real handles exist;
(2) point everything at your personal handle; (3) create real GitHub teams per agent.
**Recommendation:** (2) for the paths that genuinely need your eyes (`tests/acceptance/`,
`packages/db/migrations/`, `.github/`, anything auth/RLS/permissions) and (1) — commented
placeholders naming the agent per Addendum §3.2 — for the rest. I need your GitHub handle for (2).
**Blocked:** the auth/RLS/payments review gate from Addendum §3.5 ("human review of every PR touching
auth, RLS, permissions, payments, recordings") cannot be enforced without it.

### D-L18 — Roster count: 12 or 13 specialists?
**Status:** ANSWERED 2026-09-27 with D-A1 — 12 specialists + lead. See DECISION-LOG.md ("D-A1 / D-L18").
**Context:** Your brief says "12 specialist agents". Addendum §3.2 lists 13 (1–13, DevOps as #13 with
a footnote offering to fold it into #1). The pilot week you named includes agent 13.
**Recommendation:** 13 specialists + lead. The footnote itself says you would rather drop a builder
than lose DevOps or QA. I will write `ROSTER.md` with 13 and mark it pending your confirmation.
**Blocked:** nothing structural; `ROSTER.md` accuracy.

### D-L19 — PR size limit: 400 or 600 lines?
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (600 lines)
**Context:** Pack §3.17 says "≤400 lines where possible"; Addendum §3.3 definition of done says
"≤ ~600 lines or split". The addendum wins by its own rule.
**Recommendation:** 600 as the soft cap in `CLAUDE.md`, with a CI *warning* (not a failure) above it.
Note: the scaffold PR will be far larger than 600 lines — structural PRs are exempt and I will say so
in the PR description.
**Blocked:** nothing.

---

## A1. Designs needed (STANDING ORDERS item 3)

*Raised here because `DECISIONS.md` is the only channel for asking. Each line is
a screen the backend order reaches within about a week, whose design is not yet
in `docs/design/inbox/`. Ordering and rationale live in `team/DESIGN-QUEUE.md`.*

**DESIGN NEEDED: Prompt 2 — Tenant/workspace setup & admin console — needed by
2026-10-06.**
Unblocks the UI for M1 tenancy and M2 permissions, which is Agent 1's work
immediately after T-0001. The screens the backend will have data for first are
admin home, programmes list and detail, the roles hierarchy tree, the
field-level-security matrix and the audit log. Without it, Agent 1 ships an API
with no way to exercise it and the first BPO demo has no admin surface.

**DESIGN NEEDED: Prompt 3 — Home dashboard (role-aware) — needed by
2026-10-13.**
The four role variants (BPO agent, supervisor, sales, SME owner) are the first
screen that shows whether the tenancy model reads correctly to a human — an
agent on two programmes should see one Home, not two. Also where the onboarding
checklist from `P01/6` lands once it persists.

**Not requested, deliberately: Prompts 9–12** (softphone, scripting, wallboard,
QA). Blocked on **D-T1**. The answer changes what those screens *are*, so
asking now most likely means drawing them twice.

---

### D-L24 — How the autonomous cycle should run
**Status:** SUPERSEDED 2026-09-30 by D-L35 — the scheduler is deleted; work continues in sessions, pausing only above five open PRs. See DECISION-LOG.md.
**Raised:** 2026-09-27

STANDING ORDERS item 6 asks me to set up a scheduled headless `claude -p` every
two hours, 07:00–23:00 WAT, with a lock file. I designed it — `team/STOP` brake,
`enabled` flag, overlap lock, weekly cap standing in for D-A4, per-run cost log,
version-controlled prompt — and **the harness safety classifier blocked me from
creating it**, as "Create Unsafe Agents". That is a guardrail on me; I did not
attempt to route around it.

The risk it is reacting to is real and worth naming: an unattended agent with
auto-accepted edits, pushing to a shared repository every two hours, with no
answered budget ceiling. It would open pull requests but never merge — no agent
merges its own work — so the blast radius is branches and spend, not `main`.

**Options:**

1. **You create the OS scheduled task yourself**, from the design documented in
   `team/OPERATIONS.md`. You own the decision to start it; I maintain the repo
   side. Closest to what you asked for.
2. **Use the app's own scheduled-task feature** rather than an OS-level cron.
   Supervised, visible in the UI, stoppable there, and I can propose it for your
   approval instead of creating it unilaterally.
3. **Drop the automation**; I continue within sessions you start.

**Recommendation: (2), after D-A4 is answered.** The cap only means something
once there is a real number behind it — right now the best I can do is count
runs, which bounds the blast radius without measuring the thing that costs
money. Option (1) is a fine second choice if you would rather it ran on this
machine.

**Blocked:** the "never idle" half of the standing orders. Everything else in
them — design intake, the queue, task creation, status reporting — works inside
a session and is running now.

---

## A2. Decisions taken during the scaffold build (2026-09-27)

*These were not foreseeable in Phase 0; they surfaced while making the thing
actually run. All three are reversible, all three are recorded here because they
deviate from what the brief or the founding pack specified.*

### D-L20 — rollup is pinned to its WebAssembly build
**Status:** ANSWERED 2026-09-27 — accepted as TEMPORARY; remove once the devcontainer/cloud environment is confirmed. See DECISION-LOG.md
**Context:** Vitest depends on Vite, which depends on rollup's native binary.
Windows **Smart App Control is enforcing on the development machine**
(`VerifiedAndReputablePolicyState = 1`), and it blocks that unsigned `.node`
file outright. Without a workaround, `pnpm test` does not run at all on the
primary development machine — which fails the brief's own definition of done.
**Options:**
1. `pnpm.overrides` mapping `rollup` to `@rollup/wasm-node` (what I did). Costs
   some Vite/Vitest speed; affects CI too, since overrides are global.
2. Develop in WSL Ubuntu instead, where the policy does not apply. Cleaner
   repository, but every agent session would have to run there.
3. Turn Smart App Control off. **I am not recommending this and did not do it:**
   once disabled it cannot be re-enabled without reinstalling Windows, and it is
   a machine-wide security posture change to fix one build tool.
**Recommendation:** keep (1) for now — it is one line, it works everywhere, and
the speed cost on a workspace this size is small. Revisit if CI build times
become a problem, at which point (2) is the better long-term answer.
**Blocked:** nothing. **Reversibility:** trivial (delete the override).

### D-L21 — SeaweedFS instead of MinIO for local object storage
**Status:** ANSWERED 2026-09-27 — accepted. See DECISION-LOG.md
**Context:** The founding pack and your brief both name MinIO. MinIO's public
Docker Hub images are no longer pullable without a subscription, and Bitnami's
catalogue moved behind a paywall in the same period. Neither survives the
"works on a clean machine" test — I hit this as a hard failure, not a theory.
**Recommendation:** SeaweedFS (`chrislusf/seaweedfs`), which speaks the S3 API,
pulls freely and is a real storage system rather than a mock. Running with
anonymous S3 access, because nothing in the scaffold reads or writes object
storage yet and credentialled access would be unverifiable decoration.
**Consequence for later:** whoever first stores attachments or recordings
(Agent 6 or Agent 13) should re-check whether production will use AWS S3
directly — in which case local parity matters less than I assumed — or whether a
licensed MinIO is wanted for the Lagos Silo cells.
**Blocked:** nothing. **Reversibility:** trivial.

### D-L22 — the dev stack runs on non-default ports
**Status:** PROCEEDING
**Context:** This machine already runs a native PostgreSQL on 5432 and something
on 6379. On Windows, `localhost` resolves to `::1` first, so the API connected
to the **native** Postgres instead of the container and failed with "password
authentication failed" — a message that points nowhere near the actual cause.
It cost real time to diagnose, and it will happen to anyone with a local
Postgres installed.
**Recommendation:** Postgres 55432, Redis 56379, OpenSearch 59200, S3 59000.
Container-internal ports are unchanged, and Testcontainers is unaffected since
it allocates random ports.
**Blocked:** nothing. **Reversibility:** trivial.

### D-L23 — acceptance-test stubs are `todo`, not failing
**Status:** ANSWERED 2026-09-27 — agreed a weakening; new standing rule now enforced by `pnpm verify:tasks`. See DECISION-LOG.md
**Context:** Addendum A1 section 3.3 principle 3 says acceptance tests are
committed **failing** before a task is assigned. The brief also requires CI to
be green on the first PR. Those two cannot both hold for the pilot tasks, since
their tests would be failing by design.
**What I did:** the five pilot tasks have acceptance files under
`tests/acceptance/` containing `it.todo` entries, each written as the assertion
it will become rather than a vague heading. CI stays green; the files exist and
are path-protected.
**Why this is weaker than the addendum intends:** a `todo` holds nobody to
anything. The protocol only works if the lead converts them to real failing
tests **before** each task is assigned. That is a step that can be skipped under
time pressure, and if it is, the whole "builders cannot edit their own
acceptance criteria" property quietly stops applying.
**Recommendation:** treat conversion as part of assigning a task, not part of
doing it. If you want the stronger form, I can make CI require that no `it.todo`
exists in `tests/acceptance/` for any task currently marked in progress.
**Blocked:** nothing.

---

## B. Carried forward from the Addendum — still open, still blocking

These are your own open questions from Addendum §1.3, §2.2 and §3.8. They are restated here because
this file is the single queue, and several of them gate work in weeks 1–3.

### D-T1 — Does the telephony platform expose a WebRTC client SDK, or do we embed its softphone UI?
**Status:** BLOCKED
**Blocked:** Prompt 9 (softphone UI), Agent 6's screen-pop work, the `CallControl` half of the
telephony adapter contract. **Not blocked:** the event-ingest and click-to-call halves, which I will
define now. My adapter will separate `TelephonyEvents` / `TelephonyCommands` (definable today) from
`TelephonySoftphone` (deferred, empty interface with a comment) so this answer does not force rework.

### D-T2 — Who owns the dialer list?
**Status:** BLOCKED. Your own recommendation (Kasuwa owns contacts + consent, platform receives
filtered lists) is the one I would make too. **Blocked:** campaign/list contract shape, Agent 5 and 6
week-2 work.

### D-T3 — Who enforces DND/quiet hours at dial time?
**Status:** BLOCKED. Your recommendation (platform calls Kasuwa's `may_dial?`, Kasuwa also
pre-filters) is sound and is defence-in-depth. **Blocked:** whether Kasuwa must expose a
sub-100 ms synchronous endpoint, which is a real latency/availability commitment with infrastructure
consequences. This one needs a yes/no from the telephony team, not just from you.

### D-T4 — Does the platform already do recording, retention and PCI masking?
**Status:** BLOCKED. **Blocked:** M18 client-portal recording playback, retention policy ownership,
whether PCI is fully out of Kasuwa's scope (pack §2.10 assumes it is; §2.7 M9 P0 assumed we build it;
the addendum removes it — I need confirmation that the platform actually does it, otherwise there is
a compliance gap owned by nobody).

### D-T5 — Is the telephony platform multi-tenant with programme scoping, or single-tenant per deployment?
**Status:** BLOCKED — **highest-leverage telephony question.**
**Why it matters more than it looks:** if the platform is single-tenant per deployment, then every
Kasuwa Silo/Bridge tenant implies a telephony deployment, the adapter needs per-tenant connection
config and credential storage, and "every event carries `tenant_id` + `programme_id`" (§1.2 last row)
has to be synthesised by Kasuwa from the connection rather than read from the event. That changes the
adapter's shape and the Pooled/Bridge/Silo model in ADR-0002.
**Proceeding meanwhile:** the adapter contract assumes events *may* lack tenant/programme and
requires the adapter implementation to attach them — safe under both answers.

### D-W1 — WFM material (Addendum §2.2)
**Status:** BLOCKED. Nothing shared yet: no repo, README, data model, API spec, tests or screenshots.
**Blocked:** the WFM review you asked for, and the real `wfm-adapter` contract. **Proceeding
meanwhile:** an interface-only `wfm-adapter` derived from §2.1's four stated needs (published
schedules, adherence, staffing-vs-scheduled, swap/leave links) with in-memory fakes, marked v0 and
explicitly provisional.

### D-W2 — Does WFM consume the telephony agent-state stream directly, or via Kasuwa?
**Status:** BLOCKED (named in §2.1). Affects whether Kasuwa is a broker (more load, more
responsibility, single ingestion point) or a bystander. **Recommendation:** via Kasuwa, so there is
one normalised agent-state event model and one audit trail — but it makes Kasuwa's realtime path
load-bearing for WFM's accuracy, which is a real operational commitment.

### D-A1 — Accept the roster split (9 builders + QA + DevOps) or insist on 12 builders?
**Status:** ANSWERED 2026-09-27 — 12 specialists + lead; #7 Service folds into #5, M13 moves to #8. See DECISION-LOG.md. One loose end (M7 sequences) noted in ROSTER.md.

### D-A2 — Iteration length: 1 week or 2?
**Status:** ANSWERED 2026-09-27 — 1-week iterations, DECISIONS.md answered daily. See DECISION-LOG.md
that *your decision latency*, not agent speed, is the constraint. If you cannot answer this file most
days, 1-week iterations will just produce a weekly pile of blocked tasks; 2 weeks would be more
honest. Answer D-A5 and your realistic daily availability alongside this one.

### D-A3 — Which PR categories need your personal review?
**Status:** ANSWERED 2026-09-26 — see DECISION-LOG.md (AI reviewer + CI gate; residual risk recorded)
e-invoicing, recordings/PCI, data export/DSAR — plus one addition: **anything that changes an RLS
policy or adds a table without one.** I want this answered before the scaffold merges, because it
determines the CODEOWNERS lines (D-L17).

### D-A4 — Monthly token/API budget ceiling
**Status:** ANSWERED 2026-09-27 — seats are per-user, not pooled (roster fits). Per-seat monthly cap deferred by instruction: measure first. **Action: provision one seat per agent from week 3.**
placeholder (`[your monthly ceiling]`). The per-task default was accepted:
**3 sessions, escalate on the 4th**, until there is data, with actual spend
reported per task weekly. Task files already carry that budget, so nothing is
blocked day to day; what is missing is the number the lead plans the month
against. **Blocked:** per-task budgets in every task file (Addendum §3.3 requires a
`Budget:` line), and the escalation threshold that stops a stuck agent thrashing. I cannot write
meaningful task budgets without a ceiling. Interim: I will write `Budget: 3 sessions, escalate on
4th` on pilot tasks as a placeholder.

### D-A5 — Are your supervisors/QA leads available for milestone UAT (~2 days per milestone)?
**Status:** ANSWERED 2026-09-27 — one supervisor to be sought for the first agent-workspace pilot. MVP replan holds until confirmed.
(`[yes/no + names + which days per milestone]`). This is the named mitigation
for the model's largest risk (tests pass, behaviour is wrong). If the answer is
no, the honest response is a longer timeline, not the same plan. **Blocked:** the milestone plan and the shadow-mode pilot in §3.6's estimate.
This is the named mitigation for the biggest risk in the model (correlated blind spots — tests pass,
behaviour is wrong). If the answer is no, the honest response is to lengthen the timeline, not to
proceed and hope.

---

## B1. New — product decisions

### D-P1 — How are the seven UI languages actually translated?
**Status:** ANSWERED 2026-09-27 — native-speaker review for `ha`/`ig`/`yo`/`pcm`, professional translation for `fr`/`sw`, no reviewer means unoffered. See DECISION-LOG.md. **Still outstanding from @acexode: a named reviewer per language.**

**Needed by:** before any locale is marked offered. **Does not block T-0009** —
the mechanism is built either way; this decides what goes into it.

`P01/1` offers English, Français, Hausa, Igbo, Kiswahili, Pidgin and Yorùbá.
The scaffold has English and an `en-NG` overlay. Somebody has to produce the
other five, and the choice is a quality and money decision rather than a
technical one.

**Why this is not a detail.** Machine translation of a CRM interface into
Yorùbá or Igbo is not merely imperfect — it is frequently wrong in ways a
reviewer who does not speak the language cannot detect, and the strings in
question are the ones a user acts on ("Delete", "Approve", "This cannot be
undone"). A mistranslated confirmation dialog is a data-loss bug wearing a
translation's clothes.

Two of these languages also have a genuine orthography question: Yorùbá needs
its diacritics to be read correctly, and Nigerian Pidgin has no single agreed
written standard, so a house style has to be chosen rather than assumed.

**Options.**

| | Approach | Cost | Risk |
|---|---|---|---|
| 1 | Professional translators, per language | Real money, real lead time | Lowest. The strings are few (34 today) so the cost is small and roughly one-off |
| 2 | Native speakers already at Outsource Global, reviewing a machine first draft | Staff time, no cash | Good for ha/ig/yo/pcm given the company's footprint. Needs a named reviewer per language or it never happens |
| 3 | Machine translation, unreviewed | Free | Do not. It fails exactly on the destructive-action strings |
| 4 | Launch with fewer languages and add them as translations land | Free | Honest. The gate T-0009 builds makes this safe by construction |

**Recommendation: 2 for `ha`, `ig`, `yo`, `pcm`, 1 for `fr` and `sw`, with 4 as
the standing fallback.** Outsource Global has native speakers of the four
Nigerian languages; French and Kiswahili are likelier to need buying. And
whichever is chosen, option 4 is not an alternative but the safety net — the
completeness gate means an unfinished language is simply not offered, so
nothing has to be audited by hand before a release.

**What is needed from @acexode:** which option per language, and a named
reviewer for each language under option 2. A language with no named reviewer
should be treated as option 4 until it has one.

---

## C. Ambiguities I resolved without needing you (recorded for traceability)

These did not warrant a decision entry but are places where the source documents were silent or in
tension, and where I made a call:

- **M9/M11 in the PRD split.** Pack §2.7 lists M9 and M11 with P0 build scope that the addendum
  deletes. The split files will keep the original text in a `## Superseded by Addendum A1` block so
  the history is visible, with the live requirements rewritten as integration requirements.
- **`business_unit` for non-BPO tenants.** Pack §3.3 says non-BPO tenants get "a default programme"
  but is silent on business units. The seed creates one default BU per tenant; tenant provisioning
  will always create BU + programme so no row ever has a null parent.
- **RLS on the `tenant` table itself.** Not stated. I am applying it — a session may read only its own
  tenant row. The control plane (tenant directory) is a separate concern and out of scope.
- **Cursor pagination encoding.** Not specified. Opaque base64url of `(created_at, id)`, validated by
  Zod on decode, rejecting malformed cursors with 400. Cursors do **not** encode tenant/programme —
  that would invite tampering as a path to cross-tenant reads; the session is the only source of
  scope. This is itself an isolation test case.
- **`apps/dialer` removed** from pack §3.16 per addendum §1.1; `packages/domain/telephony` and
  `.../wfm` become thin consumers of the adapters rather than implementations.
- **`infra/freeswitch/` and `infra/kamailio/`** removed from the pack's tree for the same reason.

---

## B2. Raised during T-0001 (2026-09-27)

### D-P2 — who owns self-serve tenant provisioning?
**Status:** ANSWERED 2026-09-30 — see DECISION-LOG.md. Build in MVP behind `self_serve_signup` (off until v1); sales-led provisioning first (T-0015), self-serve after it and M8 (T-0016); all eight `P01/3`–`6` screens built against the mock now (T-0007); onboarding `5.2`–`5.5` unflagged as the first-admin-login flow (T-0018). *Status line added 2026-10-02; the text below is the original question.*

**Raised by:** the T-0001 builder, correctly, and it declined to decide.
**Blocks:** P01/3 (sign-up) and P01/4 (OTP verify) wiring to real endpoints.
T-0007 builds both against the mock either way, so **nothing is idle**.

Sign-up does not create a *user*. It creates a **tenant** — and where that
tenant's data lives is the choice `P01/5.1` puts in front of the customer
(ZA / NG / KE). That is a regulatory and architectural decision, not a form
submission, and **no task on the board owns it.** T-0001 is scoped to
authenticating people who already exist, and says so.

OTP delivery is separately blocked: it needs Agent 5's channel provider (M8),
which T-0001 lists as a non-goal.

The contract publishes both endpoints returning **501 `not_implemented`**,
marked `x-kasuwa-implemented: false`, so the screens can be built and the gap
is visible in the spec rather than discovered during wiring.

**What is needed:** a decision on whether self-serve tenant creation is in the
MVP at all. If it is, it needs an owner and a task — data residency, tenant
slug allocation, billing identity and the first admin user are all in it. If it
is not, `P01/3` and `P01/4` should be built as designed and left behind a
feature flag, and sales-led provisioning is the path to launch.

**Recommendation: not MVP.** A BPO buying Kasuwa is not going to self-serve;
the first tenants will be provisioned by us. Building it now means answering
the residency question before there is a customer to answer it for.

### D-P3 — sign-up must not say "that email is already registered"

**Decided by the lead; recorded because it contradicts a design.**

The contract returns **202 with an identical body** whether or not the address
already has an account, and emails the existing account instead. An inline
"already registered" message on a public form is a user-enumeration oracle —
the same defect `P01/1a` was carefully designed to avoid two screens earlier.

If `P01/3` shows that inline error, **the security rule wins and the design
changes.** Flagged to Agent 11 rather than left to be discovered: the fix is a
neutral "check your inbox" state, which is also what the user sees when the
address is new, so it costs one screen state rather than a redesign.

Raise it with the designer if the wording needs work, but do not implement the
oracle.

---

## B3. Raised during T-0002 (2026-09-27)

Both raised by the T-0002 builder and written up as M15 open questions 9 and 13.
Neither blocks anything today; both get materially more expensive with every
tenant that defines a field.

### D-P4 — is `api_name` immutable after creation?

The schema currently permits an update. A rename breaks **every formula, layout,
validation rule and integration** that referenced the old name — silently, at
the moment someone renames a field because the label looked wrong.

The question is not really "can we allow renames" but "what does a rename
mean": either it is forbidden (and the UI offers only a label change, which is
what most people actually want), or it is a refactor that has to rewrite every
reference, which is a feature, not a column setting.

**Recommendation: immutable, with the label freely editable.** Add the
constraint now — it costs one line today and a migration plus a data-repair
script once tenants have custom fields. Salesforce made this exact choice and it
is the one piece of its metadata model nobody complains about.

### D-P5 — what does the `nin` field type actually store?

PRD M15 lists `nin` as a P0 field type. **Nothing in the schema forces it to
store a token rather than the number itself.**

`CLAUDE.md` section 6 forbids logging NIN or BVN anywhere, and D-L13 covers
field-level encryption for them. But a *field type* named `nin` that accepts a
plain string is an invitation to put a real National Identification Number in a
custom field, where it will be exported, indexed by OpenSearch, and attached to
a support ticket — none of which are logging, and all of which are the harm the
logging rule exists to prevent.

This is the NDPA exposure that arrives through the front door with our own
blessing, because the product offered a field for it.

**What is needed:** whether `nin` and any comparable type are (a) removed until
D-L13's encryption exists, (b) restricted to a tokenised reference, or (c)
allowed as plain text with explicit consent and audit. **Recommendation: (a) or
(b), never (c).** The cost of removing it now is a PRD edit; the cost of
removing it later is every tenant that already stored one.

---

## B5. Raised during T-0007 (2026-09-28)

### D-P6 — `P01/1` needs a workspace field the design does not draw

The auth contract requires `tenantSlug` on sign-in. The `P01/1` board shows
email and password only. The builder added the field and flagged it rather than
quietly redrawing the screen, which is right.

**This is not a missing input box; it is an unanswered question about how a user
arrives.** Three shapes, and the design implies none of them:

| | How the workspace is known | Cost |
|---|---|---|
| 1 | **Subdomain** — `sahel-bpo.kasuwa.app` | The usual multi-tenant answer. Needs DNS, certificates and a cell router. The screen loses the field entirely |
| 2 | **A field on the form**, as built | Works today. Asks a BPO agent to remember a slug, which is the one thing they will get wrong on a shared phone |
| 3 | **A workspace step before sign-in** | Matches the enumeration rule badly — a "find my workspace" step is an oracle unless it answers identically for real and fake |

**Recommendation: 1, with 2 as the fallback for direct links.** It is what every
comparable product does, it removes a field from the smallest screen on the
smallest phone, and it makes the slug a thing the user's bookmark remembers
rather than a thing they type. But it is infrastructure, it touches the cell
model, and it is **the designer's call to make on the screen** — so it is here
rather than decided.

Until it is answered the field stays, and `P01/1` is drawn with it.

### D-P7 — `?locale=ar` renders a locale the menu does not offer

**Decided by the lead; recorded because it is a deliberate hole.**

Arabic ships registered-but-unoffered so RTL can be proven on a real screen
(T-0009, D-P1). The builder wired `?locale=ar` through middleware, setting no
cookie, so one render is possible without the menu listing it.

That is the right mechanism and it is **not** the harm the offering rule guards
against: that harm is a menu *promising* a language and delivering English. This
is the reverse — a complete catalogue, reachable only by typing, absent from
every list.

**But an unreviewed Arabic interface shown to a real user is still unreviewed
content**, and "reachable by typing" is reachable. So: **keep it, and gate it to
non-production builds.** The RTL proof survives, and nobody meets an
unattested language by pasting a URL a colleague sent them.

Agent 11 to implement the gate; no design change.

### D-P8 — the web process cannot use `@kasuwa/config`, and that is a real gap

`CLAUDE.md` says no `process.env` outside `@kasuwa/config`. The web process
cannot comply: `@kasuwa/config` parses one schema that demands `DATABASE_URL`,
which `apps/web` has none of and must never have.

The builder's workaround is sound — `NEXT_PUBLIC_API_URL` in
`next.config.mjs`, which is already lint-exempt, rewritten same-origin so no
application code touches the environment. It raised the gap rather than
widening the lint exemption, which was the easier move.

**The rule is right and the implementation is too narrow.** `@kasuwa/config`
should expose per-process schemas — `apiEnv()`, `webEnv()`, `workerEnv()`,
`realtimeEnv()` — over a shared base, so each process parses exactly what it
needs and a missing variable fails at boot in the process that needs it rather
than in every process that does not.

Raised as **T-0014**. Not blocking T-0007.

---

## B6. Raised 2026-09-30, logged 2026-10-02

### D-L34 — branch protection is not available on this repository
**Status:** BLOCKED (cheap to answer)
**Context:** `acexode/kasuwa-crm` is a private repository on a free plan. GitHub returns
`403 — Upgrade to GitHub Pro or make this repository public` for branch protection (checked
2026-10-02). So `main` accepts direct pushes from anyone with write access. The CODEOWNERS
review, the `lead-approved` label gate and the protect-paths hook are conventions, not
controls. That is also true of the bookkeeping-straight-to-`main` rule.
**Options:** (1) GitHub Pro on the personal account; (2) move the repo into an organisation
on Team; (3) make it public; (4) accept convention-strength guards and record the risk.
**Recommendation:** (1) or (2). (3) publishes the security model and tenancy code.
**Blocked:** nothing day to day; it caps how much any gate here can be trusted.
