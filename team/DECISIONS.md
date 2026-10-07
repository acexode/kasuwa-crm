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
**Status:** ANSWERED 2026-10-02: envelope encryption via `@kasuwa/auth-crypto` plus an HMAC blind index. See DECISION-LOG.md. NDPA counsel review still advised before a real NIN is stored.
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
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
**Blocked:** Prompt 9 (softphone UI), Agent 6's screen-pop work, the `CallControl` half of the
telephony adapter contract. **Not blocked:** the event-ingest and click-to-call halves, which I will
define now. My adapter will separate `TelephonyEvents` / `TelephonyCommands` (definable today) from
`TelephonySoftphone` (deferred, empty interface with a comment) so this answer does not force rework.

### D-T2 — Who owns the dialer list?
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
filtered lists) is the one I would make too. **Blocked:** campaign/list contract shape, Agent 5 and 6
week-2 work.

### D-T3 — Who enforces DND/quiet hours at dial time?
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
pre-filters) is sound and is defence-in-depth. **Blocked:** whether Kasuwa must expose a
sub-100 ms synchronous endpoint, which is a real latency/availability commitment with infrastructure
consequences. This one needs a yes/no from the telephony team, not just from you.

### D-T4 — Does the platform already do recording, retention and PCI masking?
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
whether PCI is fully out of Kasuwa's scope (pack §2.10 assumes it is; §2.7 M9 P0 assumed we build it;
the addendum removes it — I need confirmation that the platform actually does it, otherwise there is
a compliance gap owned by nobody).

### D-T5 — Is the telephony platform multi-tenant with programme scoping, or single-tenant per deployment?
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
**Why it matters more than it looks:** if the platform is single-tenant per deployment, then every
Kasuwa Silo/Bridge tenant implies a telephony deployment, the adapter needs per-tenant connection
config and credential storage, and "every event carries `tenant_id` + `programme_id`" (§1.2 last row)
has to be synthesised by Kasuwa from the connection rather than read from the event. That changes the
adapter's shape and the Pooled/Bridge/Silo model in ADR-0002.
**Proceeding meanwhile:** the adapter contract assumes events *may* lack tenant/programme and
requires the adapter implementation to attach them — safe under both answers.

### D-W1 — WFM material (Addendum §2.2)
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
**Blocked:** the WFM review you asked for, and the real `wfm-adapter` contract. **Proceeding
meanwhile:** an interface-only `wfm-adapter` derived from §2.1's four stated needs (published
schedules, adherence, staffing-vs-scheduled, swap/leave links) with in-memory fakes, marked v0 and
explicitly provisional.

### D-W2 — Does WFM consume the telephony agent-state stream directly, or via Kasuwa?
**Status:** DEFERRED 2026-10-02 by @acexode: ignored until reopened.
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
**Status:** ANSWERED 2026-10-03: every language ships; any language without a named reviewer's sign-off shows **Beta** in the menu with a "help improve this translation" link; native speakers test once the app is feature-complete and their sign-off removes Beta. (Reopened 2026-10-02.) **Note (T-0035 security review, 2026-10-03):** Beta catalogues now reach users, including compliance-sensitive strings (`region.law.*` NDPA guidance, `admin.ret.scope.note` on recording retention, D-T4). Those strings should be first in line for native-speaker review, or shown in English until reviewed. Direction given: every language goes live; once the app is complete, native speakers test each one and make recommendations. The "English + `en-NG` only at launch" answer recorded earlier the same day is withdrawn. Until the discussion, nothing changes in code. Previous answer, for reference: native-speaker review for `ha`/`ig`/`yo`/`pcm`, professional translation for `fr`/`sw`, no reviewer means unoffered. See DECISION-LOG.md. **Still outstanding from @acexode: a named reviewer per language.**

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
**Status:** ANSWERED 2026-10-02 — lead recommendation adopted. See DECISION-LOG.md ("the lead's recommendations"). Immutable.

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
**Status:** ANSWERED 2026-10-02 — lead recommendation adopted. See DECISION-LOG.md ("the lead's recommendations"). Remove `nin`/`bvn` types now; reintroduce as encrypted-only.

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
**Status:** ANSWERED 2026-10-02 — lead recommendation adopted. See DECISION-LOG.md ("the lead's recommendations"). Subdomain target, field fallback stays.

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
**Status:** ANSWERED 2026-10-03 by @acexode: **no GitHub Pro.** The repo moves to an organisation at the end of development; branch protection is configured then. Until then guards are convention-strength by design (see DECISION-LOG 2026-10-03 "answers").
**Context:** `acexode/kasuwa-crm` is a private repository on a free plan. GitHub returns
`403 — Upgrade to GitHub Pro or make this repository public` for branch protection (checked
2026-10-02). So `main` accepts direct pushes from anyone with write access. The CODEOWNERS
review, the `lead-approved` label gate and the protect-paths hook are conventions, not
controls. That is also true of the bookkeeping-straight-to-`main` rule.
**Options:** (1) GitHub Pro on the personal account; (2) move the repo into an organisation
on Team; (3) make it public; (4) accept convention-strength guards and record the risk.
**Recommendation:** (1) or (2). (3) publishes the security model and tenancy code.
**Blocked:** nothing day to day; it caps how much any gate here can be trusted.

---

## B7. Raised 2026-10-02

### D-L36 — no feature may be quietly buried
**Status:** ANSWERED 2026-10-03: adopt `team/FEATURES.md`, generated from the PRD, task files, `x-kasuwa-implemented` flags and the flag registry, with a CI check that fails on any flag, deferral or mock-only screen without a row. Agent 13, after T-0032 starts.
**Context:** @acexode: "this app has lots of features, I don't want any to be accidentally
buried." The real risk is features that are flag-gated (for example `self_serve_signup`), held
back as "not MVP", deferred (telephony, WFM), or mock-only with no backend (P02 today). Each one
is reasonable on its own, and together they let a feature disappear without anyone deciding it
should.
**Lead proposal for the discussion:** one register, `team/FEATURES.md`, listing every PRD
feature with its state (built / mock-only / flagged off / deferred / not started), the flag
name if any, and the decision that put it there. It is regenerated from the PRD, task files,
`x-kasuwa-implemented` flags and the feature-flag registry, so it cannot drift. A verifier
fails CI if a flag or a deferral has no row.

---

## B8. Raised during T-0017 (2026-10-02)

### D-P10 — the first messaging provider
**Status:** ANSWERED by @acexode, 2026-10-04: **Dotgo for now.** This replaces the Termii/AT
recommendation below, which stays on record as the fallback analysis.
- **What Dotgo is:** a Gupshup company. It provides RCS Business Messaging and runs MTN Nigeria's RBM
  launch with Google (2021).
- **Lead caveat 1, reach:** RCS reaches only RCS-capable (mostly Android) handsets on networks that
  support it. OTP and MFA recovery need **SMS fallback** for every other phone, and that includes
  numbers on the DND register. Before T-0016 is built, the lead confirms with Dotgo/Gupshup that they
  provide SMS fallback, on which Nigerian route, and at what naira rate.
- **Lead caveat 2, data:** the three sales questions below still apply unchanged. That covers rates,
  NDPA data location plus a DPA, and per-tenant sender IDs.
- **Engineering:** the vendor name lives only in `packages/channel-adapter` (CLAUDE.md 2.8).
  Everything else stays provider-neutral, so switching to Termii or AT later is one adapter.
- Per-SMS market context found 2026-10-04: Nigerian transactional routes cost about ₦5.80–₦9.00, after
  the February 2025 increase approved by the NCC. Sender-ID / DND whitelisting takes about 4–6 weeks.
**Research (vendor pages read 2026-10-03; no vendor contacted):**

| | Termii | Africa's Talking | Twilio (reference) |
|---|---|---|---|
| NG price/SMS | Not published | ~₦5–6 transactional (search copy, unconfirmed) | US$0.3868 (~60× the local routes) |
| Reaches DND numbers (OTP) | Yes, explicit DND route | Yes, per-telco transactional route | Not reliably (its own Nigeria guidance) |
| DND lookup API | **Yes** (`dnd_active`) | None found | None |
| Delivery reports | Signed webhooks (HMAC-SHA512) | Callbacks (docs blocked) | Yes |
| Sender ID lead time | Not stated | ≥2 weeks (CAC certificate, ID, letter per telco) | 2–3 weeks |
| Data location | **Not disclosed** | **Not disclosed** | US by default |
| GH / KE / ZA | Unverified | KE, ZA yes | Yes |
| WhatsApp | Yes | Yes | Yes |

**Recommendation:** **Termii primary, Africa's Talking fallback.** Termii is the only one with a DND-route
plus DND-lookup API (needed later for promotional compliance, not just OTP) and has signed webhooks. AT is a
different upstream (so one failure does not take out both), has real KE/ZA reach, and reported naira pricing.
**Start AT's sender-ID registration on day one** (≥2 weeks). **Not Twilio** (cost; unreliable to DND numbers).
**Three questions for sales before signing:**
(1) Naira rate on the DND/transactional route per telco at our volume; is the DND lookup billed per call;
are failed or DND-rejected messages charged?
(2) NDPA: where are numbers and message content processed and stored, for how long, and with which cloud?
Will you sign a DPA with transfer clauses and list sub-processors (upstream aggregators, telcos)?
(3) Direct-to-telco or via resellers; OTP delivery rate to DND numbers per telco; real sender-ID lead time
per telco; can sender IDs be per tenant (BPO client)?
**The NDPA cross-border assessment is blocked on question 2:** no Nigerian vendor publishes data location.
Sources are in the lead's research notes (vendor pricing, developer docs, help articles).
**Context:** T-0017 built `@kasuwa/channel-adapter` against a fake provider only. OTP for
self-serve sign-up (T-0016) and MFA recovery (T-0012) both need a real one. Choosing it is spend
and a contract.
**Lead recommendation:** **SMS through a Nigerian aggregator first**, for OTP only: it reaches every
phone with no opt-in or template approval. **WhatsApp through a BSP second**, when M8 proper
(conversations, templates, the 24-hour window) starts. The lead has **no verified pricing**. Before
signing, get quotes from two aggregators and record the per-message NGN cost and whether DND lookup
is included or billed per lookup (T-0017's escalation trigger).
**Blocked:** T-0016 OTP delivery and T-0012 recovery in production. Nothing in development.

### D-L37 — `send` needs an idempotency key before T-0016
**Status:** PROCEEDING (lead decision, reversible).
A retry after a timeout the provider actually accepted would send a second OTP. The lead will add a
required `idempotencyKey` to `SendRequest`, with a matching acceptance assertion, as the first step of
T-0016. Until then, the adapter treats unclassified send errors as **non-retryable**, so nothing
retries into a double send.

**Carried from the T-0017 security review (2026-10-02), for T-0016/T-0012 and D-P10:**
- `TenantScope` on `send`/`getDeliveryStatus` is caller-supplied. The first callers (T-0016, T-0012)
  must derive it from the session, never the request (CLAUDE.md 2.2). `tenancy-reviewer` checks this on those PRs.
- A caller can mislabel a campaign `transactional` and skip DND. Audit the stated `purpose` per send
  once campaigns exist (Agent 8).
- Once a real provider is chosen, every number and message body leaves the region. D-P10 needs an
  NDPA cross-border transfer assessment alongside the price.

---

## B9. Raised during T-0022 / T-0024 (2026-10-02)

### D-L38 — admin writes are live but unaudited until the audit log exists
**Status:** PROCEEDING (lead decision, reversible). @acexode may overturn.
**Context:** `createRole`, `updateRole`, `deleteRole`, `updateRoleHierarchy` (T-0022) and
`updateProgramme` (T-0024) are marked `x-kasuwa-audited`, and CLAUDE.md 6.7 says permission changes
are audited. No audit table exists. The acceptance suites exercise these writes, so putting them
behind a default-off flag would fail tests that may not be edited.
**Decision:** merge them unaudited, on three conditions: (1) **the audit log is Agent 1's next task**
(table, writer, and the four `audit` endpoints P02 already draws); (2) **no environment with real
users is deployed before it lands**. None exists today, and T-0005 applies no Terraform. (3) Each
unaudited operation is listed in its PR and report, so the gap is named, not buried (D-L36).
**Reversibility:** trivial. Audit is additive.

### D-L39 — one wiring pattern for admin modules
**Status:** PROCEEDING (lead decision).
Three builders each solved "the auth guard needs `AUTH_MODE`" differently: Agent 1 made the root
module global and exported it; Agent 2 passes it into a dynamic module; Agent 3 registered the
controller on the root module. **Adopt Agent 1's pattern** (global `AUTH_MODE`, one-line module
import per admin area) when the three PRs merge, and move the shared admin error filter to
`apps/api/src/admin/`. Whichever of #44/#45 merges after #43 is rebased onto it.

### D-L40 — renaming a programme can confirm a sibling programme's name
**Status:** TRACKED RISK. Fix rides on the permissions engine.
**Context (tenancy-reviewer on T-0024):** `programme` names are `UNIQUE (tenant_id, name)`, and
unique checks ignore RLS. A user assigned only to programme A2 can PATCH A2 to a guessed name and
learn from the 409 `duplicate_name` that a sibling programme of that exact name exists. In a BPO,
names carry the end client ("Bank X Collections"), which is sensitive between client teams. No id
or row leaks; only the name is confirmed.
**Why not fixed in T-0024:** no remapping helps (any failed write differs from a success), and the
task forbids a migration. With no 403 check yet, any programme member can probe.
**Extended 2026-10-03 (T-0029 tenancy review):** `createProgramme` has the same oracle, and it is
cheaper there: it needs only a business-unit id from the caller's own tenant.
**Resolution (lead):** when the permissions engine lands, `updateProgramme` **and `createProgramme`** are
restricted to tenant admins, who can reach every programme, so the oracle stops crossing a boundary. Until then: no
environment with real users is deployed (same condition as D-L38).

---

## B10. Raised during T-0005 (2026-10-02)

### D-L41 — 36 known vulnerabilities already in the lockfile
**Status:** PROCEEDING (lead decision, reversible).
**Context:** The new blocking dependency scan (osv-scanner, PR #48) found 36 existing advisories
(1 critical, 13 high). Blocking on all of them would turn every PR red on day one.
**Decision:** baseline all 36 in `osv-scanner.toml` with a **hard expiry of 2026-10-31**; any new
advisory blocks immediately. **Triage first:** `drizzle-orm 0.38.4` (GHSA-gpj5-g38j-94v9,
CVSS 7.5), which is in the API's runtime path through `@kasuwa/db`. It becomes a task for Agent 1
right after the audit log. Each remaining baselined advisory needs an upgrade or a written
not-reachable note before the expiry.

### D-L42 — Nest's own exception logger can carry PII
**Status:** OPEN. Follow-up task to be written.
In production, Nest's built-in exception handler logs `exception.message` and the stack trace, and a
pg error message can contain row values. That path is outside OpenTelemetry, so the PII suite
cannot see it. Fix: a global exception filter that logs only the error class and code, with a test
that greps the process output for a probe value. Also extend `collectTelemetry` to return span
events, so a future `recordException` stays inside the PII grep.

---

## B11. Raised during T-0010 (2026-10-02)

### D-L43 — self-hosted fonts silently fall back to Google
**Status:** OPEN. Agent 11 owns it, alongside the 168 KB latin-ext fix (HANDOFF item 6).
`packages/ui/src/fonts.generated.css` lists `fonts.gstatic.com` as a fallback source in every
`@font-face`. If a self-hosted font fails, the browser fetches from Google: a third origin on a
256 kbps link, and **user IPs sent to a third party** (an NDPA processing question we never decided
to take on). Fix in `fetch-fonts.mjs`: self-hosted sources only, plus a test that greps the
generated CSS for any external origin.
**Also from T-0010, for Agent 11:** the P01 sign-in budget (270,336) now has 12.6% headroom over the
measured 240,015 and should be re-pinned.

---

## B12. Raised during T-0007b (2026-10-03)

### D-P11 — copy on the sign-up region screen (`P01/5.1`) needs counsel or the designer
**Status:** ANSWERED 2026-10-03: lead recommendation adopted. Remove the "choose Nigeria" sentence from the self-serve screen; use "Nigerian data residency is set up with our sales team."; counsel signs off the final wording before the flag is lifted.
The NDPA panel is the design's text verbatim, and its last sentence tells the user to "choose
Nigeria", which D-P2 makes unselectable during self-serve sign-up (ZA only; NG and KE are sales-led).
Two new strings also need review: "Talk to sales" and "Our sales team sets this region up with you.
It cannot be chosen during sign-up." The exact text is in `team/reports/T-0007b.md`. Behind
`self_serve_signup` (off), so no user sees it until v1.

### D-L44 — naira and cedi signs pull in the 168 KB font
**Status:** OPEN. Agent 11, folded into D-L43 / HANDOFF item 6.
₦ and ₵ fall in Noto Sans Latin Extended (168 KB). `/onboarding` first measured 399,576 bytes,
over the 300 KB ceiling, purely from one currency sign. T-0007b worked around it by setting
amounts in JetBrains Mono (now 243,325 bytes), but **every future screen that shows a naira amount
will hit this.** Fix in `packages/ui` / `fetch-fonts.mjs`: a small subset carrying the currency
symbols, served ahead of the full Latin-Extended file.

### Also from T-0007b, for T-0018
`P01/6` says "This list stays on your Home page", which is untrue until T-0018 persists onboarding
state. Fix the copy or the state in T-0018.

---

## B13. Wave decisions (2026-10-03, lead, reversible)

### D-L45 — field-security matrix semantics (T-0026)
**Status:** PROCEEDING.
The spec is silent on five points; the lead settles them so the builder does not guess:
- **`classification`** gets a column on `field_def` (migration 0009, Agent 2's area). It is not derived.
- **Default level** for a never-saved cell is `edit`, matching today's effective behaviour (no FLS is
  enforced yet). Admin is always `edit`. Tightening the default is a product decision for later.
- **Locked column:** a change to a locked permission set gets 403 `not_permitted`.
- **Atomic PUT:** a refused change (locked, or an unknown or cross-tenant field or set) applies
  **nothing**; the whole request fails.
- **Unknown field or set** inside `changes` gets 404 `not_found`, the same as an unknown object.
- Also fix the stale `FieldSecurityWrite.description` in the spec that still says "undecided / 501".

### D-L46 — creating a programme under RLS, without a third SECURITY DEFINER (T-0029)
**Status:** PROCEEDING (lead). **D-A3: changes an RLS policy → @acexode reviews the PR.**
The `programme` policy's WITH CHECK requires the row's id to be in the session's programme ids,
which a new programme can never satisfy, and T-0020 sealed the session GUCs so a transaction cannot
re-scope itself. **Ruling:** migration 0012 adds a permissive `FOR INSERT` policy on `programme`
whose WITH CHECK is `tenant_id = app.current_tenant_id()` only. The existing `FOR ALL` policy (WITH
CHECK = USING, programme-scoped) is unchanged, so reads and updates stay programme-scoped. The
creator's `user_programme` row is inserted in the same transaction (that table is tenant-scoped).
The response is built from the inserted values, not a re-read the session cannot yet see. **No
SECURITY DEFINER function, so no ADR (CLAUDE.md 2.7).** Who may create a programme is an
authorisation question for the permissions engine; until then, any tenant user can (same gap as D-L40).
Also for T-0029: a new programme starts `active`; the unfiltered list includes every status (the
spec's `status` filter narrows it); archiving an already-archived programme is an idempotent 200;
archive deletes nothing, and assigned users keep **read** access. Enforcing "losing access" waits
for the permissions engine, and there is no restore endpoint yet (named, not buried: D-L36).

### D-L47 — dispositions and admin-home semantics (T-0027, T-0031)
**Status:** PROCEEDING (lead).
- **Dispositions:** delete is soft. A deleted disposition is absent from `listDispositions` and
  excluded from the "complete list" `reorderDispositions` expects. Its `code` stays reserved (not
  reusable), so historical outcomes never change meaning. A reorder with a foreign or unknown id is
  400 `validation_failed`. A new disposition is appended last.
- **Admin home:** alerts belong to a programme. A tenant-wide alert is stored once per programme it
  concerns; there is no programme-less alert in this wave. `userCount` and `seats.used` count
  distinct users who share at least one programme with the caller (a caller with no programme
  counts only themselves). Restoring a never-dismissed alert is an idempotent 204.

### D-L48 — audit-log conventions (T-0025)
**Status:** PROCEEDING (lead).
The writer's pinned conventions are adopted: `objectType` is `role` or `programme`, plus `audit_export`
for export events; `changes[].field` uses API field names (`name`, `parentRoleId`); an export records
`includeIpAddresses` as a change; events are newest-first; a new export is `queued`; `sourceIp` is
null for everyone until a permission grants it. **Visibility:** an event with a `programmeId` is
visible only to members of that programme; an event with no programme (role changes) is visible to
every user of the tenant until the permissions engine restricts audit reading to admins.
`deleteRole` records the destination role id and the moved-user count as changes
(`reassignedToRoleId`, `movedUserCount`).

### D-L49 — the channel adapter gains an `email` channel (T-0030)
**Status:** PROCEEDING (lead). An adapter contract change, recorded per CLAUDE.md section 8.
`ChannelKind` becomes `sms | whatsapp | email`, as a discriminated union: SMS and WhatsApp keep
the E.164 rule, and email requires an RFC-valid address. The DND check applies only to sms and
whatsapp. Never log the address (CLAUDE.md 6.1). Still the fake provider only (D-P10).
The API takes `AppModuleOptions.channelProvider` (default `FakeChannelProvider`) so tests can observe sends.
**Portal invites:** a re-invite of the same address to the same programme is a **resend**: 202, the
same id, and a **rotated** token (the old one stops working). The list **never** returns a full
address, only `emailMasked`; the spec text saying otherwise is wrong and is corrected in T-0030.

### D-L50 — SLA and retention semantics (T-0028)
**Status:** PROCEEDING (lead).
An unconfigured SLA returns the platform default policy (voice and WhatsApp targets defined in code,
version 0). An unconfigured retention policy is a 404, as the spec says; **the first retention
write sends `version: 0`**, and 0 is stale once a policy exists. `callRecordingsDays` is stored and
returned but **not enforced by Kasuwa**: recording retention belongs to the telephony platform (D-T4,
deferred), and the spec description must say so. Two targets for the same channel in one SLA write
are a 400. When a write is both stale and violates legal hold, `stale_write` wins (it is checked first).

### D-L51 — `user_programme` RLS is tenant-only: the database does not guard programme membership
**Status:** ANSWERED 2026-10-03: lead recommendation adopted. Fixed inside the permissions engine, Agent 1's next P0 task (T-0032).
**Found by:** migration-reviewer on T-0029 (0012). The gap predates the wave (0001:134-136).
`user_programme_isolation` checks only `tenant_id`. Any code path that inserts a `user_programme` row
can therefore enrol any user in **any existing programme** of the tenant, crossing the BPO client
boundary. Today the only insert is T-0029's `createProgramme`, which enrols the session user in the
programme it just created (the user id comes from the session; reviewed). So the API layer holds,
and CLAUDE.md rule 3 ("RLS is the last line, not the only line") is half-met.
**Lead recommendation:** tighten `user_programme`'s INSERT and UPDATE WITH CHECK so a row can only be
written for a programme already in `app.current_programme_ids()`, or for a programme created in the
same transaction (marked via a transaction-local setting the session cannot otherwise set). Do this
together with the permissions engine, which owns "who may assign people to programmes". Also add an
isolation test listing every permissive `FOR INSERT` policy, so a weak one cannot slip in unnoticed
(0012 introduced the first).

### D-L52 — auditing writes that sit outside session scope; no fake provider in production
**Status:** PROCEEDING (lead), from the T-0025 and T-0030 security reviews.
- **createProgramme** is audited with `programme_id` NULL (the new programme is not in the sealed
  session scope), and the event carries **only the new programme's id**, never its name or
  `clientName`, which would otherwise become visible tenant-wide (D-L40's boundary).
  **archiveProgramme** is a normal programme-scoped event. **updateFieldSecurityMatrix** is
  tenant-level (`programme_id` NULL, D-P9) and records only field api name, permission-set key and
  before/after level. D-L38 counts as closed only when every `x-kasuwa-audited` write on main
  writes an event.
- **Production never uses `FakeChannelProvider`** (amends D-L49). It would report "invited" when
  nothing was sent, and it keeps plaintext tokens and addresses in memory. Production defaults to a
  null provider that answers 503 until D-P10 picks a real one.
- **Gates on M18 (accepting a portal invite), from the T-0030 reviews:** an authorisation check on
  who may invite; an audit row per invite; the token in a URL fragment or POST exchange, never a
  query string; the send moved to an outbox (not inside the DB transaction); per-address rate
  limiting; a paginated list. The token lookup before any session exists needs a third
  SECURITY DEFINER function, so **an ADR first** (CLAUDE.md 2.7).
- Export `objectType` filters are restricted to known types; the raw `sourceIpPrefix` is not stored.

### D-L53 — permissions model for T-0032
**Status:** PROCEEDING (lead).
- **Tenant admin is a tenant-level flag on the user**, not "admin in every programme" (that definition
  would strip every other admin the moment one admin creates a programme). Seed: USER_A_SUPERVISOR and
  USER_B_AGENT_1 (tenant B's only seeded user) are tenant admins.
- **Tenant-level writes** (roles, the field-security matrix, programme create/update, audit export)
  require tenant admin. **Programme-scoped writes** (archive, dispositions incl. reorder, portal invite,
  SLA/retention) require the `admin` permission set in that programme or tenant admin, always only
  inside programmes the session can already reach (RLS scope unchanged, D-L06).
- **Order:** 404, then 403, then 400. Refused writes are not audited. Other permission sets are
  read-only for admin writes this round.
- **Deliberate behaviour change:** a non-admin's duplicate-name create is now 403, not 409 (this is
  D-L40's fix). One existing acceptance assertion (programme-lifecycle) is updated by the lead as a
  requirements change, recorded here, not to make code pass.
- **Two more lead edits, same reason (2026-10-03, commit 65522d4 on the T-0032 branch):**
  `tenancy/adversarial`: an out-of-scope membership INSERT now expects RLS to refuse it (42501). That is
  stronger than the old "accepted, but scope did not widen". `admin/audit-api`: the filter-options test makes
  agent 2 a tenant admin for that one test, because renaming a programme now needs one. Its visibility
  assertion is unchanged.

### D-L54 — provisioning and audit-coverage semantics (T-0015, T-0033)
**Status:** PROCEEDING (lead).
- **Provisioning runs as an operator command on the migrator connection.** No tenant exists yet, so
  there is no tenant context to open. This is the `db:seed` precedent, not an application "admin
  connection" (CLAUDE.md 2.1). `apps/api` has no migrator URL in its config, so the app cannot call
  it. Inside the command, the default programme is created through the same reusable
  `createProgramme` under a tenant transaction for the new tenant. **Amended 2026-10-03 (T-0015
  security review):** RLS is **not** exercised there, because `kasuwa_migrator` is BYPASSRLS, which
  overrides FORCE. Safety rests on explicit `tenant_id` predicates, freshly generated ids, the composite
  tenant FKs, and a savepoint adapter that throws on any unrecognised transaction statement. Running
  those writes under the app role (`GRANT kasuwa_app TO kasuwa_migrator` + `SET LOCAL ROLE`) is to be
  re-evaluated once Docker can verify it. `provisionTenant` lives on its own subpath, which `apps/**`
  may not import. The builder argues this in the PR. A third SECURITY DEFINER function still needs an ADR.
- **First admin:** a one-time setup credential (argon2id-hashed, printed once, never logged) that
  works as the sign-in password. MFA enrolment is required on first sign-in. Forcing a credential
  change waits for a change-password endpoint (with T-0012). The provisioning audit event waits for
  a system-actor policy (D-L52); recorded as a gap, not skipped silently.
- Region: ZA maps to `za-1`, recorded in `tenant.region_cell`. NG and KE cells are a later
  cell-routing decision. Reserved slugs are `admin`, `api`, `www`; length 2 to 63.
- **Audit objectTypes** added: `sla_policy`, `retention_policy`, `disposition`, `portal_user`.
  A reorder is one event per request. A portal re-invite is audited (it rotates the token). The
  invitee's address and display name never appear in an event; `email` is a redacted change.
  Change values are strings.

### D-L55 — permissions-engine hardening carried as known gaps (from the T-0032 security review)
**Status:** TRACKED. Not exploitable through any endpoint today; each needs a fix before an endpoint
that writes the relevant table ships.
- `user_programme.permission_set_id` is writable by kasuwa_app for any membership in a reachable
  programme (the T-0032 acceptance suite deliberately allows it). It must be column-restricted
  before any "assign permissions" endpoint exists.
- `user_programme` DELETE is still tenant-only (predates T-0032).
- No acceptance test yet proves kasuwa_app gets 42501 on `UPDATE "user" SET is_tenant_admin`, or
  that an UPDATE of an in-scope programme followed by a sibling membership INSERT is refused. The
  lead adds both before T-0032 is promoted from `dev` to `main`.
- Any future `ON UPDATE CASCADE` into `programme`, or an owner or definer trigger writing `programme`,
  creates a forge path for the creation marker and needs a security review.
Fixed in T-0032 itself: the creation marker also requires `created_at` within the current transaction
(xid wraparound); `permission_set.key` is no longer updatable by the app.

### D-L56 — auth gaps carried from the T-0012 / T-0013 reviews
**Status:** TRACKED (lead). None blocks the `dev` merge; each is a follow-up task or a decision.
- **First enrolment is password-only by design.** Whoever holds a factor-less account's password can
  enrol their own TOTP. Safety rests on the D-L54 setup credential (one-time, printed once). Before
  self-service password reset or invites ship, the setup credential needs an expiry and single use.
- **MFA audit events** (enrol, replace, regenerate codes) wait for the D-L52 system-actor policy and a
  new `mfa_factor` objectType. Recorded as a gap, not skipped silently.
- **Admin factor reset** for another user waits on a T-0032 permission plus the same audit decision.
- **Auth-table retention:** a worker job pruning `auth_challenge`, `auth_session`, `auth_rate_limit`
  (attacker-driven growth) with stated retention. Plus keying the rate-limit hash with HMAC, or correcting
  ADR-0009's "no personal data" claim.
- **Pool connection timeout** (5 s since T-0013) surfaces as 500, not 503; needs an exception mapping.
- **Bundled deploys** must ship `dist/hash-wasm.cjs` beside `main.js` (T-0013); add it to the image
  build when the Dockerfile exists.
- **`db:reset` drop list** in `packages/db/src/cli/reset.ts` is missing about 15 tables; replace it with
  a catalogue query.
- Step-up lockout is a flat 10 per 15 minutes per user and does not escalate; policy owner to decide.
- **Open (product): should replacing a factor invalidate the old backup codes?** Today they stay valid,
  and the T-0012 suite asserts that (`backupCodesRemaining` is unchanged after a replacement). The
  lead's recommendation is yes: return a fresh set on confirm. That needs a lead edit to the suite
  first. Not changed under the dev arrangement.

### D-L57 — lead suite fixes from the first Docker run on `dev` (2026-10-04)
**Status:** DONE (lead, approved by @acexode in chat). PR #70.
The first isolation run on `dev` (447/457) found three defects in lead-owned suites. They are fixed
without loosening any assertion:
- **permissions (T-0032):** the versions are now read before the supertest request is built. Awaiting
  another request inside `.send()` closed the shared listener (ECONNREFUSED).
- **permissions (T-0032):** archive confirms with the programme's current name. An earlier
  `updateProgramme` in the same loop renames it.
- **audit-coverage (T-0033):** the actor test grants agent 2 the `admin` set in A2 first. Since T-0032
  the `agent` set may not create dispositions.
The remaining failures were not code defects. The six T-0035 browser tests cannot run on this Windows
host (Smart App Control blocks Next's SWC binary, and `cmd.exe` splits the `--grep` on `|`), and are
**skipped at @acexode's instruction** until a Linux runner is available. The old auth timing test
(ratio < 3) failed once under host load and passed alone.

### D-L58 — replacing an MFA factor invalidates the old backup codes (answers the D-L56 open item)
**Status:** ANSWERED by @acexode, 2026-10-04 (adopted the lead's recommendation).
When a replacement factor is confirmed, every unused backup code of that user is marked used, and the
confirm response returns a fresh set of ten (`Cache-Control: no-store`). Codes kept with a lost device
must not outlive it. The lead edits the T-0012 lost-device assertion (`backupCodesRemaining`) first,
then a builder implements it. This is queued as a small follow-up task after `dev` is promoted to `main`.

### D-L59 — auth timing test flaky under full-suite load (follow-up for Agent 12)
**Status:** FIXED 2026-10-04 (#72). **Cause:** test state leaked between suites; it was not a code
asymmetry. T-0013's suite locks the same probe address, and the seed never truncated `auth_rate_limit`,
which has no tenant FK. A locked known user answered 429 without hashing. Agent 12 measured ratio
1.01–1.31 with the probe clear (including under full CPU load) and 6.10 with it locked. The seed now
truncates `auth_rate_limit`. **Still open (lead, suite edit):** assert that every timing sample is 401,
interleave the samples, and discard a warm-up request.
`tests/acceptance/auth/authentication.acceptance.test.ts`, "does not leak which addresses exist through
response timing" (unknown/known ratio < 3), failed in both full isolation runs on 2026-10-04 (ratio
about 4.1) and passed every time it ran alone. T-0013 moved hashing onto a worker pool, so the first
thing to check is a real unknown-vs-known asymmetry under CPU contention, for example dummy-hash
warm-up or queueing differences. Only after ruling that out may it be treated as noise. Do **not**
widen the threshold to make it pass.

### D-P12 — duplicate detection and merge semantics (PRD M03 Q3)
**Status:** OPEN, needs @acexode. It does **not** block the first Phase 2 slice: dedupe and merge come later.
PRD M03 makes dedupe and merge P0, but leaves undecided what counts as a match, which value wins, and
whether a merge can be undone.
**Lead recommendation:**
- **Match:** normalised E.164 phone (exact) or lower-cased email (exact), within one programme. Fuzzy name
  matching comes later, as *suggestions* only, never an automatic merge.
- **Merge:** the user picks the surviving record. Each field defaults to the most recently updated
  non-empty value, and the user can override it field by field.
- **Activities:** timelines and activities move to the survivor.
- **Undo:** the merged-away record is soft-deleted, and the merge can be undone for 30 days through a
  merge record. Each merge writes one audit event.
- **Scope:** never merge across programmes. That would break BPO isolation, and a duplicate in another
  programme is a different client's customer.

### D-L60 — Phase 2 shape: the first slice (lead, reversible)
**Status:** PROCEEDING. **Goal:** the first screen a real user recognises as a CRM, Contacts in P04's list
view, with real data behind it.
1. **T-0039 — records contract (Agent 3).** `docs/api/records.openapi.yaml`: contacts list with search
   ("name or number"), filters, sort and keyset paging; get, create and update. ADR-0004 (contracts first).
2. **T-0040 — contact fields and accounts (Agent 3; migration review by Agent 1).**
   - **Fields:** the M3 fields D-L12 deferred, namely owner, status, source, tags, preferred language and
     channel, State and LGA, DND flag, WhatsApp opt-in, consent state, and phone network.
   - **Accounts:** an `account` table, plus `contact.account_id`.
   - **Out of this slice:** NIN/BVN tokens (D-L13), which come in a later slice.
3. **T-0041 — contacts write, search and filter API (Agent 3)** against T-0039.
4. **T-0042 — CRM app shell plus the P04 Contacts list (Agent 11)**, behind a new `crm_records` flag:
   table view, search, filter chips, column chooser, the locked-column treatment, and the empty, loading
   and offline states.
**Next slice:** custom-field value storage (Agent 2, the T-0002 follow-up), accounts and leads screens,
P03 home, CSV import, then dedupe and merge (D-P12).
Each task waits for its acceptance suite (D-L23).

### D-P13 — total counts in record lists ("1–25 of 1,234", live chip counts)
**Status:** OPEN, needs @acexode. Does not block T-0039, which forbids totals for now and is easy to relax.
P04 shows "1–25 of 1,234", "Page 1 of 50", and live counts on filter chips and saved views. The T-0039
contract uses keyset paging (`data`, `nextCursor`) with no total, no offset and no page number, the
same as the live contacts endpoint.
**Lead recommendation:** keep keyset paging, and offer **an approximate total only on request**. It
would be capped (for example "1,000+"), computed within the caller's scope, and omitted when a filter
touches a field-secured column. Per-chip live counts are left out of MVP: a count per filter per page load
is costly on Postgres, and on a secured field a count reveals what exists. T-0042 then draws "Load more",
or next/previous without "Page X of Y".

### D-L61 — T-0040 value sets and the DND flag (lead, reversible)
**Status:** PROCEEDING. The value sets are pinned by the T-0040 suite (`lead/T-0040-acceptance`). The database stores
snake_case codes; display labels live in i18n.
| Field | Values |
|---|---|
| status | new, contacted, qualified, unqualified, customer |
| source | whatsapp, ussd, web_form, missed_call, import, api, manual, referral, walk_in |
| preferred_channel | whatsapp, sms, voice, email |
| consent_state | unknown (the default, NOT NULL), opted_in, pending, withdrawn |
| preferred_language | BCP-47 format check only |

- P04's Contacts list shows Active / Prospect / Former. Those can be added later; they are not rejected.
- **DND:** `dnd boolean NOT NULL DEFAULT false` cannot tell "checked against the NCC register, not listed"
  from "never checked". **No promotional send may rely on it** until a `dnd_checked_at` (or a register
  lookup at send time) exists. That gate belongs to M8/M13 and is recorded here so it isn't forgotten.
- Still open: what happens to contacts when an account or owner is deleted, and whether an owner must
  belong to the contact's programme.

### D-L62 — Next's SWC wasm fallback; browser tests run locally again (2026-10-04)
**Status:** DONE (#77). Temporary, like D-L20.
Smart App Control blocked `@next/swc-win32-x64-msvc`, so `next build` and all web e2e failed on this host.
`@next/swc-wasm-nodejs` (pinned to the resolved `next`, 15.5.26) lets Next fall back to wasm.
`pnpm test:e2e --grep @p02` now passes **86/86**, including every `@p02-live` journey. That is T-0035's browser
coverage, which had never run since T-0035 merged.
Remove the pin once agents run in the devcontainer or on Linux. Bump it with `next`.
**Still broken:** the T-0035 *acceptance wrapper* (`p02-live-api.acceptance.test.ts`) spawns
`pnpm test:e2e --grep "@p02|@locale-beta|…"` through `cmd.exe`, which splits on `|`. That is a suite
portability defect needing a lead edit to the suite (shell-quoting, or `shell: false`), which auto mode
blocks. Until it is fixed, the lead runs the tags directly.

### D-L63 — contacts API rulings pinned by the T-0041 suite (lead, reversible)
**Status:** PROCEEDING.
- **Permission:** a new programme-scoped action `contact.write` covers create and update. It is granted by the
  `admin` set in the target programme, or by the tenant-admin flag (the D-L53 rule unchanged). Every other
  set is read-only for contacts.
- **The tenant-admin flag does not lift field security.** A withheld field stays withheld for everyone
  the matrix withholds it from. Writing it gives 403 `not_permitted` with `field_not_editable`.
- **No contact name in audit labels.** It follows D-L54: a person's name is PII and stays out of events.
  The label is the record id.
- **Scope headers** get 400 `validation_failed` in the shared envelope. This changes the shared stub
  guard's body (Agent 1's), not its decision.

### D-P14 — may agents edit contacts? (P04 shows inline Owner and Status edits)
**Status:** OPEN, needs @acexode. Not blocking: T-0041 ships admin-only writes, and one test flips if the answer is yes.
**Lead recommendation:** yes, but narrowly. Add an `agent` permission for **status and owner reassignment
to themselves** only, on contacts in their programme. No other fields. This matches how BPO agents work a
queue, without letting them rewrite customer data.

### D-L64 — Contacts screen rulings from the T-0042 suite (lead, reversible)
**Status:** PROCEEDING.
- **Flag and e2e harness.** `crm_records` is `productionReady: false` until T-0041 is live. The e2e harness gets a
  `webRecordsUrl` process that serves the same build with the flag on. If the production boot guard refuses a
  not-ready flag, run that one process with `NODE_ENV=test`, the same way T-0035's `web:flags-on` handled
  `admin_live_api`. The guard itself is never loosened.
- **No contact rows on the device.** For offline use the list survives in memory only; it is never written to
  localStorage or IndexedDB. Storing personal data on the device is an NDPA decision nobody has made.
- **`/contacts/[id]` goes behind `crm_records` too.** It is existing scaffolding and is not gated today.
- **`q` (phone numbers) must be redacted** from API access logs and spans. This goes to T-0041 and Agent 1.
- **Contract gap, to become a new task (T-0043): display names.** The contract returns ids only, but the
  screen must never print a UUID, so it cannot show "Bank X – Collections" or an owner's name. T-0043 adds a
  scoped lookup: the caller's programmes with their names, plus owner display names within reach.
  Until then T-0042 shows a neutral label.
- **The pin is accepted.** The T-0042 suite pins its e2e spec and mock by sha256, because `tests/e2e` is not
  path-protected. Changing either file needs a lead edit.

### D-P15 — T-0042 waits on one test-file edit by @acexode (permission boundary)
**Status:** OPEN, needs @acexode. PR #81 (Contacts screen) passes 27/28 acceptance and every e2e tag
(`@p04` 23/23 + 1 fixme, `@p02` 86/86, `@locale-beta` 7/7, `@byte-budget` 1/1, `@harness` 6/6).
The one failure is the budget re-pin. Auto mode refused the builder's edit to
`tests/e2e/p04-contacts.spec.ts`, which changes `CONTACTS_BUDGET_BYTES = 240_000` to `226_000` (measured 216,100 B;
the rule is ≤ 1.05 × measured). This edit **tightens** the budget. The lead does not route around a block
placed on another agent, so the edit is left to @acexode: make it yourself, or switch auto mode off for that step.
**Also for @acexode:** the `en-XA` pseudo-locale preview is now reachable in production, as `ar` is. Should
it be dev-only? Lead recommendation: yes, dev and test only.

### D-L65 — migrations on hot tables: no populated cell yet, and the rule from now on
**Status:** PROCEEDING (lead). The 0019 migration review measured about 4.6 s of ACCESS EXCLUSIVE on `contact` at 5M rows,
because CHECK and FK validation and index builds scan the table. At PRD 2.13 scale that becomes about 25–60 s.
- **No populated production cell exists.** There is no deploy target (T-0005 scope 2 is unbuilt), so 0019 is
  accepted as written. Its header says so.
- **From the first deployed cell onward, migrations on `contact` and other hot tables must:**
  - add CHECKs and FKs `NOT VALID`, then `VALIDATE CONSTRAINT` in a later migration (SHARE UPDATE EXCLUSIVE);
  - build indexes `CONCURRENTLY`.
- **The runner can't build indexes concurrently yet.** It always wraps a file in a transaction
  (`packages/db/src/migrate.ts:103`). A **runner task** must add a marked non-transactional mode before the first
  cell is populated. That task belongs to Agent 1, before T-0005 scope 2.
- `version` is maintained by a trigger (added to 0019 after review M1), the same pattern as 0018's `updated_at`.

### D-L66 — the auth-table sweep gets its own NOBYPASSRLS role (supersedes ADR-0009's "run as migrator")
**Status:** PROCEEDING (lead). An ADR is required, and is drafted by the T-0045 builder.
- **The problem:** ADR-0009's amendment, and migration 0004's header, say the sweep "must run as kasuwa_migrator (BYPASSRLS)".
  But the sweep runs in `apps/worker`, and CLAUDE.md 2.1 and the db invariant 6 forbid any app process from holding the migration
  URL. A BYPASSRLS pool in a long-running worker is precisely the escape hatch the model rules out.
- **The decision:** a dedicated role, `kasuwa_sweeper`, created in `packages/db/sql/bootstrap.sql`:
  - **no BYPASSRLS, no LOGIN.**
  - **Granted to `kasuwa_app`.** The worker's prune enters it with `SET LOCAL ROLE` inside a transaction.
  - **Policies only for this role,** on `auth_challenge`, `auth_session` and `auth_rate_limit`, admitting **only rows already past retention**.
    The retention rule is the policy predicate.
  - **Grants:** `SELECT` and `DELETE` only.
- **What still holds after this change:**
  - exactly two SECURITY DEFINER functions;
  - nothing reachable from `kasuwa_app` has BYPASSRLS;
  - `kasuwa_app` itself still sees nothing across tenants. The T-0045 suite's adversarial guards check this.
- **Bootstrap edit:** this is the first edit to `bootstrap.sql` since it was written. It is a protected path, so the lead reviews the
  role diff line by line.

### D-L67 — a contact's owner must belong to the contact's programme (answers the open D-L61 item)
**Status:** DECIDED (lead, reversible). This came from the T-0041 tenancy review (major finding).
Without the rule, an agent in A1 could assign an A1 contact to a user who belongs only to A2, and in doing so learn
that the user id exists: a real id is accepted where an invented one gets 400. That is a programme-level existence
oracle across the BPO isolation boundary.
**Rule:** `ownerUserId` must have a `user_programme` row in the contact's programme. Anything else gets the same 400
`unknown_reference` body as an id that names nothing. T-0041 enforces this in the repository's owner check. A schema-level
guard (a trigger or FK through `user_programme`) can follow later under the D-L65 rules.

### D-L68 — follow-ups from the T-0041 reviews (tracked)
**Status:** TRACKED.
- **`displayName` undercuts field security on the name parts.** It is never withheld and is always searched, so withholding
  `givenNames` or `familyName` protects little. Needs a decision: withhold `displayName` whenever either name part is withheld,
  or compose it per caller.
- **Search cost.** `q` folds and scans every row in scope, with no index, and the tag filter unnests. Needs a trigram or
  functional index migration under D-L65, plus a search-latency budget, before PRD-scale tenants arrive.
- **Two lead suite edits are pending,** blocked in auto mode and waiting on @acexode:
  - The `adversarial` FINDING-4 tripwire forbids `INSERT INTO contact`. The tenancy review confirmed the id is always
    `newId()` and that a client-sent `id` is rejected, so the tripwire should instead assert exactly that.
  - The `observability-pii` probe NIN `00000000001` collides with tenant A's id. Change the probe.
- **2026-10-04, from the T-0045 security review (major):** granting a role to `kasuwa_app` opens a new path.
  SQL injected inside a tenant transaction can call `set_config('role','kasuwa_sweeper', …)`, which works inside a
  SELECT, unlike `SET ROLE`, and ADR-0010's verifier (`assertScopeIntact`) checks only the scope GUCs. **Ruling:**
  `withTenantTransaction` must assert `current_user = session_user` (equivalently `current_setting('role') = 'none'`)
  both at the start and at the commit-time check. The pool must also reset the role on checkout. T-0045 does not merge
  until both are in, with an acceptance-style test proving the forged role is refused.

### D-P16 — the auth tables are writable by any app-role SQL (within a tenant)
**Status:** OPEN, needs @acexode (architecture). Found by the T-0048 suite writer, who probed on main.
**What happens.** Given arbitrary SQL on `kasuwa_app` inside a tenant, any member could do all of these:
- insert an `auth_session` for the tenant admin, which is then a valid session with no password and no MFA;
- overwrite their `user_credential.password_hash`;
- delete their MFA factors;
- create a backdoor `"user"` with a credential.

**Why.** The policies on `auth_session`, `user_credential` and `user_mfa_factor` are tenant-only, and the database cannot tell the
auth code apart from any other code, because all of it runs as `kasuwa_app`.

**Severity.** This is not a cross-tenant leak. It needs the same attacker as T-0046 to T-0048 (SQL injection, or an app bug), and
that attacker can already forge `app.user_id` (the ADR-0010 residual). So it is defence in depth, not a live exploit.
Still, closing `"user".status` while leaving `auth_session` open is inconsistent.

**Lead recommendation.**
- Add a separate LOGIN role, `kasuwa_auth`, used only by the auth module's own pool.
- Make it the only role with INSERT, UPDATE and DELETE on `auth_session`, `auth_challenge`, `user_credential`,
  `user_mfa_factor` and `user_mfa_backup_code`.
- Leave `kasuwa_app` with SELECT where it needs it (session resolution already goes through `app.resolve_session`).
- Record the decision in an ADR. Cost: a second pool and a migration. Benefit: an injection anywhere outside auth can no longer mint
  sessions or rewrite credentials.

**Until decided:** tracked; no task assigned.

## Answers, 2026-10-04 (@acexode: "let's go with your recommendation")
- **D-P12, dedupe and merge: ANSWERED.**
  - Matching is on exact E.164 phone or lower-cased email, within one programme. Fuzzy matches are suggestions only.
  - The user picks the survivor. Each field defaults to the most recently updated non-empty value.
  - Activities move to the survivor. The record merged away is soft-deleted, and the merge can be undone for 30 days.
  - One audit event per merge. Never merge across programmes.
  - Scheduled for a later Phase 2 slice.
- **D-P13, total counts: ANSWERED.**
  - Keyset paging stays.
  - An approximate total is available only on request, capped (e.g. "1,000+"), and computed within scope.
  - The total is omitted when a filter touches a field-secured column. There are no per-chip live counts in the MVP.
- **D-P14, agent edits: ANSWERED.** The `agent` set may change `status` and assign `owner` to themselves, on contacts in their
  own programme, and nothing else. This needs a lead edit to the T-0041 suite ("the agent set may not write") plus a
  small API change. Queued after #83 merges.
- **D-P15, en-XA in production: ANSWERED.** The pseudo-locale preview is for development and test only, and production refuses it.
  Small web task.
- **D-P16, auth tables: ANSWERED.**
  - A separate LOGIN role, `kasuwa_auth`, used only by the auth module's own pool.
  - It is the only role with INSERT, UPDATE and DELETE on `auth_session`, `auth_challenge`, `user_credential`, `user_mfa_factor` and
    `user_mfa_backup_code`. `kasuwa_app` keeps SELECT only where it needs it.
  - An ADR is required (ADR-0013). Agent 1 does the work, as T-0049.

## B14. Phase 2 plan, the next slices (2026-10-06)

### D-L69 — Phase 2 slice plan and the lead's reversible rulings
**Status:** PROCEEDING (lead). The plan breaks the rest of Phase 2 into tasks T-0052 onward: Accounts and Leads (P04), the 360° view
(P05), Pipeline (P06) and Activities (P07). Each task still needs its own suite (D-L23).
- **Enablers come first.**
  - Field security is hard-wired to contacts (`contact-field-access.repository.ts` joins `api_name = 'contact'`).
  - No tenant has `object_def` rows for standard objects.
  - So **T-0053 (Agent 2)** backfills `object_def` and `field_def` rows for contact and account, creates them when a tenant
    is set up, and generalises the loader to `loadFieldAccess(tx, objectApiName)`. This answers M15 Q10 for standard objects:
    they are metadata rows, not a field list in code.
- **The accounts track does not wait on the leads decision (D-P17).** T-0052 is the accounts contract. T-0054 adds account
  fields and T-0055 is the Accounts API. Account writes are admin-only, as contact writes were in T-0041, until D-P18 answers.
- **Contact relationship status.** P04 shows Active/Prospect/Former. That will be a separate `relationship_status` column,
  never mixed into the lifecycle `status` (D-L61).
- **Pipelines are programme-scoped.** A pipeline name such as "Bank X – Loans" would otherwise leak across BPO clients (D-L40).
- **Money and probability.**
  - Probability is stored in basis points.
  - The weighted amount is rounded half-even, once per deal, before summing.
  - Amounts are `bigint` minor units plus a currency, and are never summed across currencies.
- **Left out of Phase 2 screens:**
  - "Show US$" (FX) returns 501 until M05 provides rates.
  - Lead score and account Health are hidden until M17 provides an engine.
  - The Map view returns 501 (T-0039).
- **Design conflicts, ruled.**
  - The P05/P06 "access denied" page shows the record id, the programme owner and "Request access". That breaks CLAUDE.md
    6.4, so screens draw a generic not-found page instead.
  - Hidden until their modules exist:
    - recording playback (ADR-0003);
    - "last WhatsApp contact" and bulk WhatsApp (M08, D-P10);
    - NIN last-4 (D-L13);
    - P04 "1–25 of 1,234" and live chip counts (D-P13).
- **Migration numbers are assigned when a task starts, not when it is planned.** 0024 is T-0049's. The next free number is 0025.

### D-P17 — is a lead its own object or a stage of a contact? (M03)
**Status:** OPEN, needs @acexode. It blocks the Leads API and screen (T-0056, T-0058), not the accounts track.
M03 lists leads as their own P0 object, and the sponsor's Zoho has a Leads module. P04's Leads statuses, though, are exactly the
contact lifecycle T-0040 already stores (new, contacted, qualified, unqualified).
**Lead recommendation: a stage of a contact.**
- The Leads screen lists contacts whose status is new, contacted, qualified or unqualified, plus a `company_name`.
- "Convert" means: qualify the contact, then link it to an account or create one, in one transaction with one audit event.
- **Why:** one E.164 identity for dedupe (D-P12) and screen-pop, consent and DND held once, and the status set already exists.
- **Cost:** Zoho Leads must be mapped on import.

### D-P18 — what may agents do on accounts, deals and activities? (extends D-P14)
**Status:** OPEN, needs @acexode.
**Lead recommendation:**
- Agents log and complete activities in their programme.
- Agents may create deals, and move deals they own.
- Admin, team lead and programme manager may move any deal.
- Account writes stay admin-only.
- **Also asked:** D-P14 gives `agent` status and self-ownership on contacts, but `team_lead` and `programme_manager` stay
  read-only, which leaves a supervisor with less than an agent. The recommendation is that both get at least the agent's
  rights. That is a small suite and permissions change after T-0051.

### D-P19 — pipeline column totals versus D-P13
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
**Lead recommendation:**
- Exact per-stage sums and counts, computed within the caller's scope.
- One total per currency, never converted.
- Left out when `amount` is a withheld field for the caller.
- D-P13 stays as it is for record lists.

### D-P20 — stage gating in the MVP (M04's headline feature)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
**Lead recommendation:**
- **Now:** transition rules, required fields and checklists, enforced in the write path and not only in the UI.
- **Later:** approvals, which need an approvals engine and a role hierarchy.
- **Later:** attachments, because no file API exists yet.

### D-P21 — offline edit queues on the device (P04, P05, P07)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
**Until it is answered:** editing offline is disabled. Lists survive in memory only, as D-L64 already rules.

### D-P22 — calendar sync, booking pages and public holidays (M06 Q1, Q2)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **Calendar sync** needs a new integration adapter (CLAUDE.md 2.8) and storage for OAuth tokens.
- **Booking pages** need a public write before sign-in, which means a third SECURITY DEFINER function. That needs an ADR
  (CLAUDE.md 2.7).
- **Public holidays:** someone has to own and maintain the holiday calendar.
### D-L70 — T-0049 review rulings (lead, 2026-10-06)
**Status:** PROCEEDING (lead). It came from the security, tenancy and migration reviews of T-0049.
- **`auth_rate_limit` joins the revoke.** `kasuwa_app` loses INSERT, UPDATE, DELETE and TRUNCATE on it in 0024.
  - The lockout key is an unkeyed hash of ids a tenant member already knows. So an injection could clear a victim's MFA lockout
    and brute-force TOTP. The migration review reproduced this on a real Postgres.
  - Every writer already runs on the auth pool, so the revoke costs nothing.
  - The FINDING-3 guard now accepts 42501 (bcc52cf).
- **Accepted deviation from D-P16: sign-in's read phase stays on the app pool.** This means `kasuwa_app` keeps SELECT on password
  hashes, and on the MFA columns, which hold envelope ciphertext. That is not a regression: it could read them before T-0049.
  - **Why accepted for now:** the T-0045 part-2 starvation test as written needs one 503 from one pool.
  - **Follow-up, T-0075:**
    1. Restate T-0045 part 2 as "either pool exhausted" (a lead suite edit).
    2. Move phase one to the auth pool.
    3. Revoke `kasuwa_app`'s SELECT, column by column, on `user_credential.password_hash`, the `user_mfa_factor.secret*` columns and
       `user_mfa_backup_code.code_hash` / `hash_key_wrapped`.
    4. Drop the legacy plaintext `user_mfa_factor.secret` column.
- **Expand and contract ship in one file (0024).** That is acceptable only under D-L65, because no populated cell exists. When
  a cell does exist, deploy the new API with `DATABASE_AUTH_URL` before running 0024, or roll forward.
- **Shared local database hazard.** Once any worktree migrates the shared `kasuwa-postgres` container past 0024, worktrees
  still on an older main cannot sign in until they rebase. Run `pnpm db:reset` after pulling 0024.
### D-P23 — a contact's owner who has left its programme (the open D-L61 item; raised by the T-0043 reviews)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **What happens.** D-L67 checks membership only when the owner is written. If the owner later leaves the contact's programme,
  everyone who can read the contact keeps seeing their current display name, including any rename.
- **What it is not.** It is not a directory or a cross-programme oracle: the caller cannot choose the id, and nothing about
  the user's other programmes is revealed.
- **What it is.** The name of a person who no longer shares a programme with the reader.

**Lead recommendation:**
- On removal from a programme, **unassign** that user's contacts in the programme. It is one audited statement, and it matches
  how BPO queues reassign work.
- Until that exists, show a neutral "former owner" label.
  - This is a contract change: `owner: { id, displayName: null }`.
  - Add a membership predicate to the owner subquery, and stop throwing `ContactOwnerUnresolvedError` in that case.
- Raise the priority before the Phase 2 screens ship if BPO clients treat agent names as confidential to the programme.

### D-L71 — review follow-ups tracked from T-0051 and T-0053 (lead, 2026-10-06)
**Status:** TRACKED.
- **Audit of a takeover (T-0051 security minor 3).** When an agent takes a contact from a colleague, the audit records only
  that `ownerUserId` changed. Recording the before and after owner ids would change S2's redaction rule. A staff id is not
  customer PII, so the lead recommends recording both. That is for @acexode, alongside D-P18.
- **`status = 'customer'` (T-0051 security minor 4).** D-P14 lets an agent set any status. Reopen this for that value when the
  first logic acts on it: billing, commission, conversion reporting, or the NCC/DND existing-customer test.
- **`isCustom` on metadata create (T-0053 security minor 2).** It must be server-set before any metadata-create endpoint exists,
  so that a tenant cannot plant an undeletable "standard" row.
- **Testcontainers superuser password literal** in the T-0053 suite (security minor 3). Export it from `@kasuwa/testing` with the
  next suite edit.
- **Approval provenance.** The acceptance edits made on 2026-10-06 after 18:00 were made while @acexode had the session in
  accept-edits mode, at their instruction to "do the lead-only edits… I'll approve each one". They were approved by that mode,
  not one by one in chat. Each commit names the review finding it answers.
### D-P24 — a reserved namespace for custom fields on standard objects (M15; raised by the T-0053 migration review)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **The problem.** A tenant may create a custom field on `contact` or `account` whose name a later release then wants for a
  standard field (for example `industry` or `relationship_status`). That later migration must then fail for the whole cell, on
  one tenant. Failing is correct, because the tenant's field has its own meaning and data, the same rule as 0007.
- **Lead recommendation:** reserve a namespace now, while no tenant has custom fields on standard objects.
  - Custom field api names on a standard object carry a fixed suffix, `__c` as Salesforce does, or a `cf_` prefix.
  - The standard catalogue never uses it.
  - Until then, each standard-field migration pre-checks for clashes and stops with a message naming the object, the field and
    the number of tenants (T-0053 review, major 4).

### D-P25 — may a tenant lower a standard field's data classification?
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **Today.** `kasuwa_app` can change `contact.phones` from `pii` to `none`. The 0025 header says classification is editable
  "per D-P4", but D-P4 covers labels only.
- **Why it matters.** Classification will drive redaction, export and DSAR handling (NDPA). Declassifying a phone number
  would remove those protections.
- **Lead recommendation:** a tenant may **raise** a standard field's classification, never lower it.
  - Enforce it in the same trigger that freezes type and required (T-0053 fix).
  - Custom fields stay freely classifiable.
### D-L72 — T-0059 timeline rulings (lead, reversible; from the T-0059 suite writer)
**Status:** PROCEEDING (lead).
- **Before and after values come from audit, for non-PII fields only.**
  - Contact audit today records which fields changed, never their values (D-L63).
  - From T-0061, the update audit records `before` and `after` for the non-PII enumerated fields: `status`, `source`,
    `preferredChannel`, `preferredLanguage`, `consentState`, `whatsappOptIn`, `state`, `lga`, `tags`.
  - Every other field is recorded by name only.
  - `before` and `after` stay optional in the contract, because past events carry none.
- **Field names whose values never appear:** phones, emails, given name, family name and display name. A person's name is PII
  (D-L63), which goes beyond the phones and emails the task named.
- **Owner changes carry no values.** An owner change appears by field name only. Raw user ids must never be printed (D-L64),
  and showing past owners' names would edge T-0043 towards a user directory.
- **The account summary sits on `Contact`, so list rows carry it too.** Any role that can read `accountId` sees the account's
  name: accounts are programme-scoped and readable by every set in the programme. The summary is withheld together with
  `accountId`.
- **Timeline item types are closed to `field_changed`, `consent_changed` and `activity`.** A later module adds its own type
  through a lead suite edit.
- **Item ids are per item, never the audit event id.** One audit event may yield several items. This is pinned in T-0061's
  API suite.
- **The suite pins three leaks the task did not name:**
  - withheld items are omitted *before* paging, so a short page with a cursor reveals nothing;
  - a tie-break for items sharing one `occurredAt`;
  - consent items follow `consentState`'s field security.
### D-L73 — merge-order and contract rulings (lead, 2026-10-06)
**Status:** PROCEEDING (lead, reversible).
- **0025 merged before 0024.**
  - T-0053 (#91) merged while T-0049 (#93), which carries `0024`, was still held for a timing investigation.
  - The migration re-review applied both orders cleanly on Postgres 16; the two touch different objects.
  - No populated cell exists (D-L65). Databases that already ran `0025` apply `0024` when #93 lands.
  - The runner applies any unapplied file in sort order, and does not check it sorts after the last one applied.
- **`Contact.account` sits in an `allOf` part (`ContactPendingProperties`, `x-kasuwa-implemented: false`) until T-0061 serves
  it.**
  - The live T-0041 suite requires every Contact property to be served or listed in `withheldFields`.
  - So **T-0061 must move `account` into `Contact.properties` in the same change that serves it.**
  - T-0061 must also add `account` to the `listContacts` example, which the e2e mock copies.
- **Derived properties.** `owner` (from `ownerUserId`) and `account` (from `accountId`) get no `field_def` of their own. The
  T-0053 suite now treats them that way (38deb20).
- **Open for T-0061, to be pinned in its suite:**
  - how contact creation appears on the timeline;
  - the timeline actor for a user who has left the programme, a tenant admin outside the programme, or a deleted user. The
    contract keeps `null` for system.
### D-L74 — T-0054 suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0054 suite writer.
- **Hierarchy depth cap: 5.** A top-level account is depth 1. Five covers group → subsidiary → region → branch → outlet, and keeps
  every walk of the chain at five rows or fewer. Raising it later needs a migration and a suite edit.
- **The suite pins three cycle cases beyond the task:**
  - two concurrent transactions each adding half a cycle;
  - a cycle or excess depth created within a single statement;
  - a re-parent that counts the moved subtree's own height.

  The builder's migration header must say how commits that land at the same instant are closed.
- **Indexes.** Plain `CREATE INDEX` inside `0026` is acceptable, because no populated cell exists (D-L65). A separate
  non-transactional `0027` is allowed but not required.
- **Phones.** The database checks the contract's `Phone` shape on `account.phones`, because T-0054 has no API layer.
  `account.phones` is classified `pii`: a sole trader's number is personal data.
- **ON DELETE / ON UPDATE for the two new FKs** (corrected 2026-10-06 after the migration review):
  - The parent FK is **RESTRICT**, on both delete and update. NO ACTION, the Postgres default, accepts a referenced key that is
    replaced in the same statement. The review used that to commit a real cycle past the hierarchy guard by rotating
    `account.id`.
  - RESTRICT still lets tenant and programme offboarding cascade.
  - `account.id` is immutable for `kasuwa_app`.
  - Deletion semantics otherwise remain the open D-L61 item.
- **For T-0055:**
  - Owner membership in the account's programme (D-L67) is checked in the repository.
  - Postgres error `detail` (for example "Failing row contains (…)", which can carry a name and phones) must never be logged
    or returned. The same applies to contact.
- **Hook.** `agent3/T-0054` may create `packages/db/migrations/0026_*.sql` only. This is the same narrow allowance T-0040 had.
- **PR size.** The suite is about 1,670 lines, so the PR is marked exempt from the ~600-line guide (structural, as T-0053's).
## Answers, 2026-10-06 (@acexode: "go with your recommendations for both")
- **D-P17, leads: ANSWERED. A lead is a stage of a contact, not its own object.**
  - The Leads screen lists contacts whose status is `new`, `contacted`, `qualified` or `unqualified`.
  - `contact` gains a `company_name`.
  - "Convert" qualifies the contact, then links it to an existing account or creates one. It runs in one transaction, writes
    one audit event and is idempotent.
  - Zoho Leads are mapped onto contacts at import (P28).
- **D-P18, agent rights: ANSWERED.**
  - **Activities:** the `agent` set may log and complete notes, tasks and calls in its programme.
  - **Deals:** the `agent` set may create deals and move deals it owns. `admin`, `team_lead` and `programme_manager` may
    move any deal.
  - **Accounts:** writes stay admin-only (`account.write`: the `admin` set or the tenant-admin flag).
  - **Contacts:** `team_lead` and `programme_manager` get at least D-P14's agent rights: change `status`, and assign the owner
    to themselves.
### D-L75 — T-0056 leads contract rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0056 suite writer.
- **A separate `listLeads` (`GET /api/v1/leads`), not a filter on `listContacts`.** It returns the same `ContactPage`.
  - The live contacts route ignores unknown query parameters. A new filter there would be silently dropped until T-0076, and
    the Leads screen would list customers as leads.
  - A separate operation answers 404 until it is served.
- **A repeated convert.** An exact repeat whose result is already in place returns the same 200, whatever `version` it
  carries. That keeps convert idempotent. A different request on a stale version is still 409.
- **Converting a `customer`** never demotes it. The status stays `customer`, and the account link follows the same rules. The
  response code for a contact already linked to a *different* account is the builder's, documented in the contract.
- **Converted (`qualified`) contacts stay on the Leads list,** as D-P17's lead set includes `qualified`.
- **D-L73 extends to request bodies.** `companyName` on the closed create and update bodies carries
  `x-kasuwa-implemented: false` until T-0076, because the live strict bodies would reject it.
- **Convert's screens** must also name a P05 frame (`P05/01`). It lives under `/contacts/{id}`, and T-0059's suite requires one.
- **An unreachable account in a convert body is 404,** indistinguishable from a missing one, as the suite pins. This differs
  from `createContact`/`updateContact`, which answer 400 `unknown_reference` for an unreachable `accountId`. Both forms hide
  existence; leave it.
- **The suite pins seven leaks beyond the brief:**
  - a withheld `status` filters as 400 `field_withheld`;
  - `q` matches only readable fields;
  - `companyName` is declared in each closed body's own properties;
  - convert names `field_not_editable`, `contact.write` and `account.write`;
  - convert is confined to the contact's programme;
  - no scope or status field is accepted in the convert body;
  - the response is exactly `{ contact, account }`, with one success code.
- **PR size.** The suite is about 1,475 lines, so the PR is marked exempt (structural).
### D-L76 — id rotation on composite FKs (tracked, from the T-0054 migration review)
**Status:** TRACKED.
- **The weakness.** With NO ACTION, one statement can swap which row holds a referenced key. 0019's
  `contact_account_same_programme_fk` has that exposure: an `UPDATE account SET id = …` rotation silently re-points contacts
  to another account.
- **T-0054 closes it for the account hierarchy:** RESTRICT, plus an immutable `account.id`.
- **Follow-up:** a migration that makes record ids immutable for `kasuwa_app` on `contact` and `account`. That means a trigger,
  or narrowing the UPDATE privilege to exclude `id`, `tenant_id` and `programme_id`. Moving a record between programmes
  should be a deliberate operation, never a field edit. Not yet assigned.
- **The guard must be an allow-list** (T-0054 migration re-review). 0026's `app.guard_account_id_fixed()` refuses only
  `kasuwa_app`, by name, and lets every other role through. `kasuwa_test_admin` (BYPASSRLS) can already change `account.id`.
  The follow-up migration replaces it with "refuse unless `kasuwa_migrator`". T-0060 uses the allow-list form from the start.
### D-L77 — T-0060 activity table rulings (lead, reversible; from the T-0060 suite writer)
**Status:** PROCEEDING (lead).
- **Migration number.** T-0060 takes **0027**; `agent3/T-0060` may create that file only. T-0054 holds 0026 (#98). The suite
  finds the migration by content, not by number.
- **Accepted pins beyond the task:**
  - `subject` is classified `pii` as well as `body`;
  - `created_by_user_id` has a composite FK to `"user"` on tenant;
  - a contact or account with activities cannot be moved to another programme, and neither can the activity;
  - offboarding still cascades;
  - `kasuwa_app` has SELECT, INSERT and UPDATE only, with no TRUNCATE; the migrator owns the table.
- **Also ruled (not pinned by the suite; the builder implements it):** `activity.programme_id` and `tenant_id` are immutable
  for `kasuwa_app`, as `id` is (D-L76). Re-homing an activity, body and all, is never a field edit.
- **Contact key.** Contact gains `UNIQUE (tenant_id, programme_id, id)` for the composite FK. That is acceptable on a hot table
  because no populated cell exists (D-L65).
- **Schema hygiene.** The builder seeds at least one activity, so the schema-hygiene suite finds a row for the new
  `updated_at` table.
- **Ordering.** "Newest first" sorts by `created_at`. A call logged after it happened sorts by when it was logged. P07's
  calendar fields (start and end) will add when it happened.
- **Left to the builder:** whether `due_at` and `completed_at` may be set on a note or a call.
### D-L78 — T-0055 accounts API suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0055 suite writer.
- **Excess depth is 400 `validation_failed`** with `details[].code: parent_depth` at `parentAccountId`. The T-0055 builder adds
  this code to the contract's `updateAccount` and `createAccount` descriptions, beside `parent_cycle`.
- **Account audit records field names only, never values,** as the accounts contract says. D-L72's before and after values are
  for the contact timeline only.
- **Accepted pins beyond the brief:**
  - account reads send `Cache-Control: no-store` (or `private`);
  - no response header carries a total or a count;
  - a NUL character in a name or tag is 400, never 500 and never silently stripped;
  - an owner filter naming a user in a sibling programme or another tenant answers byte-identically to an invented id.
- **Tracked follow-up (Agent 3):** the live **contacts** write path likely turns a NUL character in `displayName` into a
  Postgres 22021 and so a scrubbed 500. It leaks nothing, but client input must never cause a 500. Fix it with a
  NUL-refusing Zod refinement shared by every free-text field, and pin it in the next contacts suite edit.
- **PR size.** The suite is about 2,950 lines, so the PR is marked exempt (structural).
### D-L79 — T-0060 review rulings (lead, 2026-10-07)
**Status:** PROCEEDING (lead). These came from the T-0060 migration and tenancy review.
- **D-L77 amendment: DELETE on `activity`.** `kasuwa_app` keeps the DELETE privilege, but a restrictive
  `activity_no_delete USING (false)` policy means it deletes nothing. The suite expects a bare DELETE to return no rows
  rather than raise, so a REVOKE would fail it. The effect for RLS-bound roles is the same. The one behavioural difference:
  a MERGE … DELETE on a visible row raises 42501.
- **Column-level UPDATE.** `kasuwa_app` may not update `created_by_user_id` or `created_at`, which would forge the timeline
  actor and the order. T-0060 adds this.
- **For T-0061 (pin it in its suite):**
  - Activity ids are minted on the server and never accepted from a client. The global primary key is an existence oracle
    otherwise, as on contact and account.
  - `created_by_user_id` comes from the session, never from the request body.
  - The owner must be a member of the activity's programme (D-L67). The database accepts an owner from another programme of
    the same tenant, so the repository checks it before writing, answering the same 400 as an invented id.
- **Erasure path (tracked under D-L61).** Contact and account deletes now get 23503 once activities exist, and `kasuwa_app`
  cannot delete activities. No delete path exists in `apps/` today, but an NDPA erasure request will need a deliberate,
  audited path, decided with D-L61.
### D-L80 — T-0055 security review follow-ups (tracked)
**Status:** TRACKED.
- **Names inside paging cursors.** With the default `name` sort, `nextCursor` is base64url JSON holding the last row's name.
  Clients send it back in the query string. A sole trader's account name, or a contact's `displayName` (T-0041, the same
  pattern), is a person's name (D-L63).
  - The app is clean: request telemetry keeps only the route template.
  - The risk is ingress, load-balancer and CDN access logs, and browser history.
  - **Lead recommendation:** cursors carry the id only, and the server resolves the sort position
    (`(name, id) > (SELECT name, id … WHERE id = $cursorId AND <scope>)`) before the first deployed cell. Until then, the
    ingress must strip query strings from access logs. Assign it with the D-L68 search work.
- **Search scans.** `q` on accounts, as on contacts (D-L68), reads every row in scope; it has no functional or trigram index.
  This goes into the D-L68 search-index task.
- **Fixed in #100 before merge:**
  - a NUL character in a cursor;
  - an unbounded `version` (both returned 500);
  - inherited properties on the request body.
### D-L81 — T-0061 suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0061 suite writer.
- **Creation on the timeline.** A `created` event renders like an update: one item per field the create set, by the creator.
  Value fields show `before: null`, and consent shows `before: 'unknown'`.
- **Actors.**
  - Former members, tenant admins outside the programme and disabled users are shown by name, never as `null`; `null` means
    the system.
  - The name is read at request time.
  - A user in the audit log is never hard-deleted (0008).
  - Consistent with D-P23 being open; if D-P23 lands on a neutral label for former owners, actors stay named. An actor
    acted inside the programme.
- **Activity writes.**
  - `POST /api/v1/activities` and `PATCH /api/v1/activities/{id}`.
  - The update body is `version` plus `completed: true` and/or `ownerUserId`. Reopening a task is not in the MVP.
  - Reassigning follows D-P14:
    - the `agent` set may set the owner to itself only;
    - `team_lead`, `programme_manager` and `admin` (and the tenant-admin flag) may assign any member of the activity's
      programme.
- **Values.** D-L72's value fields stand: tags, state and lga keep before and after values. Tags are operator-assigned
  labels, and the timeline omits any field withheld from the reader. The builder encodes booleans and arrays in the
  `AuditChange` string type.
- **Follow-up T-0078: the admin audit API must apply field security to change values.** Once audit rows carry values, an
  admin whose matrix withholds a field must not read its before and after values through `/admin/audit`. Field security
  binds the tenant-admin flag too (D-L63). This lands before any deployed cell.
- **Tie-break.** Item ids are compared in code-unit order (`COLLATE "C"`).
- **PR size.** The suite is about 2,930 lines, so the PR is marked exempt (structural).
### D-L82 — T-0076 leads API suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0076 suite writer.
- **The convert audit event.**
  - One event per successful convert, as D-P17 (answered) says.
  - On the contact: `action 'updated'`, naming only the fields that changed (`status`, and `accountId` redacted with no
    values).
  - A repeat or a refusal writes none.
  - The created account is not named, and gets no event of its own, because an account name can be a person's name and the
    timeline's field list is closed.
- **Tracked for @acexode:** a convert-created account therefore has no audit event of its own. It is created only
  through convert or the Accounts API, and the latter audits it. If an account's own history must show its creation, D-P17's
  "one audit event" becomes two (a contact `updated` plus an account `created`). That is a small change to the suite and
  the builder.
- **`company_name`:**
  - classified `pii` (a sole trader's company is a person's name);
  - `""` is 400; `null` clears it;
  - at most 200 characters, and NUL is 400.
- **`version` above 2^31** is 400, never 500 (T-0055 bounded it).
- **A filter on a withheld owner** answers 400 `field_withheld` naming the query parameter, as accounts does.
- **Migration 0028** is reserved for T-0076; `agent3/T-0076` may create that file only.
- **PR size.** The suite is about 3,700 lines, so the PR is marked exempt (structural).
### D-L83 — T-0061 review follow-ups (lead, 2026-10-07)
**Status:** TRACKED, with one hard gate.
- **HARD GATE before the first deployed cell: T-0078.** From T-0061, contact audit rows hold before and after values for
  D-L72's fields, and `/admin/audit` and its export return them unfiltered to an admin whose matrix withholds those fields.
  That is a leak inside the programme, and it binds the tenant-admin flag too (D-L63). No cell may be populated until T-0078
  merges. This is recorded in STATUS and HANDOFF as a release gate.
- **Retention and erasure (into D-L61 and the NDPA assessment).**
  - `audit_event` is append-only, and audit change values (state, LGA, tags) for a person now live there with no retention
    job.
  - The DSAR and erasure path must cover them, for example by rewriting the change values redacted when a contact is
    erased.
- **Timeline cost.** Each page expands the contact's whole history before the LIMIT, and activity creates have no rate limit.
  Before long-history contacts exist: rate-limit activity creates per user, or cap the scan per branch. This goes into the
  D-L68 performance work.
- **Field-security admin.** Refuse `none` on fields the API always sends (`activity.type`), so the matrix cannot promise
  what the API does not do. A small follow-up, not yet assigned.
- **Fixed in T-0061 before merge:**
  - an impossible-date or year-0 cursor;
  - a year-0 `dueAt` (both returned 500);
  - an internal row-parse error that would surface as a 400.
### D-P26 — what may a client-portal user see on a contact's timeline? (raised by the T-0061 security review)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **Today.** The `client_portal` set is read-only, and nothing stops it reading the contact timeline. A portal user (the BPO's
  client) would see:
  - staff display names as actors;
  - activity subjects and bodies: an agent's internal call notes about the client's own customer;
  - before and after values for D-L72's fields.
- **Lead recommendation:**
  - `client_portal` gets the timeline's field changes and consent changes, but not activity bodies or subjects.
  - Actors are shown as a role label ("Agent"), not a name.
  - Enforce it in the default field-security matrix for `client_portal` on the `activity` object, plus an actor-label rule
    in the timeline. Decide before M18.
### D-L84 — T-0057 Accounts screen suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0057 suite writer.
- **Who sees write controls.** No operation tells the screen whether the caller holds `account.write`:
  `getCurrentUser` carries no permissions, and `/me/programmes` is `{ id, name }` only. So, for now:
  - write controls show to every caller;
  - the API's 403 is the gate, shown as a translated `role=alert` that keeps the sheet and what was typed;
  - the suite's `@p04-accounts-writers` journey stays a `fixme`.
- **Follow-up T-0079 (contract first):** a scoped capability read, for example `GET /me/capabilities` or per-programme
  `{ id, name, can: [...] }` on `/me/programmes`. It must reveal only the caller's own permissions. It lets screens hide
  controls the caller cannot use. Not yet assigned.
- **Tag clash.** Playwright's `--grep` is a regex, so T-0042's `--grep @p04` also ran T-0057's `@p04-accounts…` journeys.
  The T-0042 wrapper now adds `--grep-invert @p04-accounts` (lead edit 99b624c, on the T-0057 branch). Rule for later
  screens: a parent tag must not have another screen's parent tag as a prefix.
- **Accepted pins beyond the brief:**
  - account names with markup render as text;
  - no link on the page may 404, so no row links to `/accounts/[id]` until T-0063;
  - a colour detector wider than the lint rule.
- **Follow-up for Agent 11 (lint owner): the colour lint is narrower than CLAUDE.md claims.** `HEX_SELECTOR` matches only a
  whole-string hex value, so all of these pass the lint:
  - `text-[#c00]`;
  - `rgb()`;
  - inline `style={{ color }}`;
  - default Tailwind palette classes such as `bg-red-500`, which compile because the preset extends the default palette.

  Fix: widen the rule, and make the Tailwind preset replace the palette rather than extend it. The suite writer's detector
  found 0 hits in today's `apps/web`.
- **PR size.** The suite, spec and mock are about 2,990 lines, so the PR is marked exempt (structural).
### D-L85 — T-0062 contact record screen suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0062 suite writer.
- **Contract gap: activity versions.** `updateActivity` requires `version`, but timeline activity items carry none, and no
  activity read exists. So the screen can only complete a task it logged in the same session.
  - `@p05-contact-complete-served` stays a `fixme`.
  - **Follow-up T-0080 (contract first, then API):** add `version` to the timeline's activity item. That is the smaller
    change than an activity read. Not yet assigned.
- **Accepted pins beyond the brief:**
  - the document title never contains the contact's name, because titles land in browser history on shared desks (D-L63);
  - every write sends only the changed fields;
  - times are rendered in `<time datetime>` elements, shown in the browser's time zone;
  - past owner and account changes show neither name;
  - a refused or stale inline edit restores the served value, never an optimistic one.
- **Harness.** `webRecordViewUrl` serves with `crm_record_view` and `crm_records` on. The `@harness` tenancy spec's
  `record`, `record-not-found` and `record-unavailable` test ids must keep passing.
- **Budget.** The `/contacts/[id]` ceiling is provisionally 245,000 B; the lead re-pins it within 5% of the first measurement.
- **PR size.** The suite, spec and mock are structural, so the PR is marked exempt.
### D-L86 — T-0058 Leads screen suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0058 suite writer. Parent tag `@leads-p04`: neither `--grep @p04` nor
`--grep @p04-accounts` selects it.
- **Accepted pins beyond the brief:**
  - **Kanban columns:** each column reads `listLeads` for its own status only and pages inside the column. Column headers show
    no number (D-P13). Pipeline totals are D-P19, which is open; leads are not the pipeline.
  - **The account picker** offers only accounts in the lead's own programme.
  - **Moving a card:**
    - every card has a keyboard "move" control besides drag (WCAG 2.2 SC 2.5.7), offering lead stages only;
    - the screen's only contact write is exactly `{ version, status }`; there is no inline owner edit on this screen;
    - dropping a card on its own column sends nothing, and `customer` is never a target.
  - **Convert:**
    - it goes through `convertContact`, never create-then-link (D-P17: one transaction, one audit event), and never reads
      `listContacts`;
    - it is not offered on a row whose `status` or `accountId` is withheld;
    - a retry after a lost answer re-sends the same body (the idempotent repeat);
    - `already_linked` shows its own translated message, never the generic one.
  - **Budget:** `/leads` provisionally 255,000 B, re-pinned within 5% of the first measurement.
- **CRM nav.** Each web process links only the routes it serves (T-0057's `crmLiveNav()`), so the shell tests on every process
  find no dead link.
- **The isolation gate** is red on any branch carrying a screen suite until its screen lands (T-0057, T-0062, T-0058). Expected.
### D-L87 — the remaining Phase 2 plan, and its reversible rulings (lead, 2026-10-07)
**Status:** PROCEEDING (lead). The plan is in `team/ROADMAP.md` (T-0081 to T-0101). It came from a planning pass over the
P07, P18, P26, P27 and P28 exports, M06, M15, M21 and M22.
- **Activities (P07):**
  - P07/01's "Undo" after completing a task is **hidden**: D-L81 keeps reopening a task out of the MVP.
  - A `meeting` type and snoozing (moving `dueAt`) follow D-P18's activity rights: whoever may update the activity may do
    both. No new right.
  - P07/05 shows Kasuwa events only; external calendars wait on D-P22.
- **Search (P27):** the programme menu may **narrow** within the programmes the session already resolved. The server
  intersects; it never widens (contract rule 1 holds, as for the contacts list's programme filter). Results from programmes
  the caller cannot reach are never counted, shown or hinted (CLAUDE.md 6.4).
- **Search engine for Phase 2:** Postgres (`pg_trgm` and jsonb GIN indexes, T-0084), with OpenSearch's deferral recorded in an
  ADR, since the founding pack names OpenSearch. Indexing withheld fields and keeping an index in sync are avoided until
  conversations and KB need OpenSearch. This is reversible; see D-P30.
- **Notifications** poll the API in Phase 2. The authenticated socket belongs with the inbox (P08).
- **P08 and P09 constraints on Phase 2:** the search `types` enum and the notification `kind` stay additive; the `call`
  activity stays open to additive wrap-up columns from the telephony adapter.
- **Hidden frames** (their modules are later phases): listed in ROADMAP "Remaining slices".
- **The command palette** is built from `packages/ui`; no `cmdk` dependency.

### D-P27 — deletion, the recycle bin and merge (raised by the Phase 2 plan; the open D-L61 item)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **The problem.** D-P12 says the merged-away record is soft-deleted, but no deletion model exists yet: no `deleted_at`, no
  recycle bin, and erasure (D-L79, D-L83) is undefined for a soft-deleted row.
- **Lead recommendation:**
  - `deleted_at` on contact (and account), hidden from every read by the repository and by RLS-backed views;
  - a 30-day recycle bin, restorable by a tenant admin, audited;
  - after 30 days, the row is hard-deleted by the sweeper role, and its audit values follow erasure rules;
  - a merge keeps an undo snapshot for the same 30 days.

### D-P28 — compliance fields on merge and import
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **The problem.** How do `dnd`, `consent_state` and `whatsapp_opt_in` combine when two contacts merge, and may an import set
  them? P28/C1 shows "keeps the most recent choice" for SMS consent.
- **Lead recommendation:**
  - on merge, the **most restrictive** value wins for every compliance field, whatever the survivor or the date;
  - an import may **restrict** these fields (opt out, mark DND), never grant consent; a granted consent needs its own
    evidence trail (NDPA);
  - both are audited by field name.

### D-P29 — what a notification may contain (M22 Q1)
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
- **Lead recommendation:**
  - a notification stores only (kind, object type, object id, actor id), never a name, subject or value;
  - its title is built when it is read, under the reader's current scope and field security;
  - one the reader can no longer see is dropped from the list, not shown redacted;
  - in-app only in Phase 2; email, WhatsApp, SMS and push wait for their modules.

### D-P30 — three architecture approvals for the rest of Phase 2
**Status:** ANSWERED 2026-10-07: the lead recommendation, as written (see "Answers, 2026-10-07").
1. **Object storage for imports (T-0092).** A new `packages/storage-adapter` over S3-compatible storage (SeaweedFS in dev),
   with new dependencies `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and `csv-parse`.
   - Presigned multipart upload, tenant-prefixed keys with no filenames, raw files deleted after a retention window.
   - The storage host joins the web CSP's `connect-src`.
   - **Recommend:** approve.
2. **The outbox (T-0098; CLAUDE.md 2.6).** An `outbox_event` table plus a relay in `apps/worker`.
   - The relay must read across tenants, so it gets its own LOGIN NOBYPASSRLS role, `kasuwa_relay`, whose policies admit
     only undispatched outbox rows: the ADR-0012 sweeper pattern.
   - It is never granted to `kasuwa_app`. No SECURITY DEFINER function is needed.
   - **Recommend:** approve.
3. **Search in Postgres for Phase 2, OpenSearch deferred** (D-L87). The founding pack names OpenSearch, so this is a
   departure on record.
   - **Recommend:** approve; revisit when conversations and KB arrive.

## Answers, 2026-10-07 (@acexode: "go with your recommendations for all of them")
Every recommendation below was taken as written in its entry. What each one now commits the team to:
- **D-P19, pipeline totals: ANSWERED.** Exact per-stage sums and counts within the caller's scope, one total per currency, never
  converted, omitted when `amount` is withheld. D-P13 stands for record lists.
- **D-P20, stage gating: ANSWERED.** Transition rules, required fields and checklists now, enforced in the write path.
  Approvals and attachments later.
- **D-P21, offline edits: ANSWERED.** Offline editing stays disabled; lists stay in memory only. Revisit after counsel rules.
- **D-P22, calendar sync, booking pages, holidays: ANSWERED.** All three deferred out of Phase 2.
- **D-P23, a former owner: ANSWERED.** Removing a user from a programme unassigns their contacts there, in one audited
  statement. Until that ships, the owner reads as a neutral "former owner" (`owner: { id, displayName: null }`).
- **D-P24, custom-field namespace: ANSWERED.** Custom field api names on a standard object carry a fixed `__c` suffix; the
  standard catalogue never uses it. Enforced from the first create-field API (T-0089).
- **D-P25, classification: ANSWERED.** A tenant may raise a standard field's classification, never lower it; enforced in the
  T-0053 freeze trigger. Custom fields stay freely classifiable.
- **D-P26, portal timeline: ANSWERED.** `client_portal` sees field and consent changes, not activity subjects or bodies; actors
  show as a role label. Enforced before M18.
- **D-P27, deletion and merge: ANSWERED.** `deleted_at` with a 30-day recycle bin (restorable by a tenant admin, audited), then a
  sweeper hard delete; a merge keeps a 30-day undo snapshot.
- **D-P28, compliance fields: ANSWERED.** On merge the most restrictive value wins; an import may restrict, never grant consent.
- **D-P29, notification content: ANSWERED.** Ids only; titles built at read time under the reader's scope and field security;
  unreadable ones dropped; in-app only in Phase 2.
- **D-P30, architecture: ANSWERED, all three approved.** The storage adapter and its three dependencies; the outbox with a
  `kasuwa_relay` role; Postgres search in Phase 2 with OpenSearch deferred. Each still gets its ADR before its task starts.
- **D-L82, convert audit: ANSWERED.** A convert that creates an account writes two events: the contact `updated` and the
  account `created`.
- **D-L71, takeover audit: ANSWERED.** An owner change records the before and after owner ids (staff ids are not customer PII).
- **P10** (in-call agent script screen) exported to `docs/design/P10/` on 2026-10-07.

### D-L88 — the pipeline (P06) and in-call script (P10) plan, and its rulings (lead, 2026-10-07)
**Status:** PROCEEDING (lead). Tasks T-0105 to T-0116 in `team/ROADMAP.md`. These rulings follow D-P18, D-P19 and D-P20.
- **New tables approved (CLAUDE.md section 8):** `pipeline`, `pipeline_stage`, `pipeline_stage_transition`,
  `pipeline_stage_requirement`, `deal`, `deal_requirement_check` (T-0106); `script`, `script_version` (T-0113); `script_run`
  (T-0114); `activity.deal_id` (T-0111). Each in the 0027 pattern: RLS ENABLED+FORCED with WITH CHECK, TENANT_SCOPED_TABLES,
  composite FKs RESTRICT, the D-L76 allow-list key guard. No ADR: no new role, function or dependency.
- **Pipeline:**
  - **Money** on the wire as `amountMinor` (string) plus `currency`; one currency per deal, never converted. Probability in
    basis points; weighted amounts rounded half-even per deal, then summed.
  - **Stages** are `open`, `won` or `lost`, exactly one won and one lost per pipeline. Lost is reachable from any open stage
    through the move sheet, not a column. Leaving won or lost needs move-any rights.
  - **Transitions** are an allow-list seeded from the template: forward one stage, back to any open stage, won only from the
    last open stage. `409 transition_not_allowed`; `422 requirements_unmet` naming requirement ids only.
  - **Requirements** are `field` (a deal field_def) or `check` (who and when); filled in the move's own transaction. A required
    field the mover may not edit is `403 field_not_editable`.
  - **Rights:** create for agent, team lead, programme manager, admin (an agent's deal is theirs); agents move and edit their
    own, the others any; reassign by team lead, programme manager, admin; pipeline configuration admin-only
    (`pipeline.write`), API only in Phase 2 (no stage-editor design).
  - **Board:** exact per-stage `count` and per-currency totals over the scoped, filtered set; left out when `amount` is
    withheld; a filter on a withheld field is `400 field_withheld`; cards page per stage on id-only cursors; won covers
    `closedSince`, default 90 days; `no-store`.
  - **Scope:** pipelines are programme-scoped; a deal lives in its pipeline's programme; `stage_id` changes only through
    `moveDeal`. One primary contact and one account, both in that programme.
  - **Audit:** names only, except a move records the from and to stage ids (configuration ids).
  - **Rotting:** `rotting_after_days` per stage (default 14), "stale" at half; alerts wait for notifications.
  - **Hidden:** US$/FX, territories, AI risk, products and quotes, approvals, attachments, last WhatsApp contact, contact roles,
    competitors, locked KYC checks, and the Loans template (NIN/BVN gates, D-L13).
- **In-call script (P10), manual mode only in Phase 2:**
  - Authoring, draft and published versions, translations; runs started by hand from the contact record; compliance
    acknowledgements; a mandatory disposition; a callback booked as a task.
  - **Wait for M09 and the inbox socket:** screen-pop, call-bound runs, the call bar, wrap-up and agent state. Also waiting:
    SMS reminders, AI, QA toggles, calling-hours limits, `loan.*` variables.
  - A run pins its script version; republishing never changes a run in progress (M10 Q2).
  - Scripts are programme-scoped. `script.write` for the admin set; `script.run` for agent, team lead, programme manager and
    admin, in the contact's programme.
  - Branches are evaluated on the server; a branch on a withheld field stops the run with `field_withheld`.
  - Completion is refused until every compliance node on the path is acknowledged (server timestamp) and a live disposition is
    chosen. `follow_up_required` creates the callback task in the same transaction.
  - Completion logs a `call` activity (subject = the disposition label) linked by `script_run.activity_id`.
  - Answers are classified `pii`, never logged, audited by name only.
  - Contract in its own file, `docs/api/scripting.openapi.yaml`, so it runs alongside the records contract queue.
- **Contract queue for `records.openapi.yaml`:** T-0080, T-0103, T-0081, T-0105, then the rest.

### D-P31 — may a script's form write CRM fields? (P10; raised by the Phase 2 plan)
**Status:** OPEN, needs @acexode.
- **The conflict.** Form nodes that write contact fields would let an agent edit more than D-P14 allows (status and owner).
- **Lead recommendation:** in Phase 2, answers stay on the script run only. Later, a grant scoped to the script's bound
  fields, audited.

### D-P32 — who edits and approves compliance wording in scripts (M10 Q1)
**Status:** OPEN, needs @acexode.
- **Lead recommendation:** the admin set, until the BPO floor rules otherwise. A "compliance approver" role waits for the
  role hierarchy.

### D-L89 — T-0102 classification suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0102 suite writer.
- **The scale** is `field_def.classification`: `none < pii < sensitive` (0009's CHECK; 0025-0028 already rank it). A fourth
  value fails the suite until someone ranks it. The trigger ranks explicitly: the values happen to sort alphabetically, so no
  test can tell the difference, and the header says so.
- **The refusal** is `23514` with `CONSTRAINT = 'field_def_classification_raise_only'`, as 0026's `account_hierarchy` does.
  23001 and 42501 already mean other refusals on `field_def`, and the CHECK's own 23514 is told apart by the constraint name.
  Its message, detail and hint name no id or label.
- **No role is exempt:** kasuwa_app, kasuwa_migrator and kasuwa_test_admin may raise or set equal, never lower. A future
  migration that must lower one says so explicitly.
- **Equal is success**, for every role, including a whole-table `SET classification = classification`.
- **Atomic:** one lowering inside a bulk statement refuses the whole statement.
- **RLS:** a lowering aimed at another tenant's row behaves exactly like an id that does not exist.
- **Custom fields on standard objects** use the `__c` suffix in fixtures (D-P24).
- **The HTTP 400 moves to T-0089**, the first create-field API; T-0102 has no HTTP part.
- **Migration 0029** is T-0102's. The next migration task takes 0030.

### D-L90 — T-0080 timeline suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). These came from the T-0080 suite writer.
- **`AccountTimelinePage`, not the shared `TimelinePage`.** The shared field enums name Contact wire names (the T-0059 suite
  pins that) and would let account `tags`, `state` and `lga` carry values. The page shape and the activity item schema are
  one node on both pages; the suite checks it.
- **Account field changes are `{ field, redacted: true }` always**, even when an audit row stores values (D-L78, T-0078). A
  name that is not an Account field gives no item. Accounts never get a `consent_changed` item.
- **A withheld activity `account_id` hides every activity item** on the account timeline, mirroring `contact_id` on the
  contact timeline. A withheld `contact_id` there is the builder's to decide and report.
- **Audit events count only when recorded in the account's programme**, for an admin of both programmes too.
- **A non-uuid id is 404** on this operation (its own path parameter), unlike the contact timeline's 400. Safer: nothing
  distinguishes a malformed id. The contact timeline is not changed here.
- **A scope header is 400 even on an unreachable account**, one body in reach or out.
- **"Position only"** means no name (account, actor, subject, contact) and no id the pages so far did not show; the record's own
  id is allowed. A cursor is refused on another account, on a contact timeline and on listAccounts.
- **`Cache-Control: no-store` exactly, on 200, 400 and 404.** Nest's `@Header` reaches only successful responses, so the builder
  needs a middleware (T-0078's `NoStoreMiddleware` pattern).
- **Client-portal parity** with the agent set on both timelines (D-P26's rules land before M18, not here).
- **The T-0061 suite edit** (a93073a) adds `version` to the pinned activity item keys. Nothing was loosened.
- **Tracked follow-ups:**
  - every records error response lacks `no-store` today; one shared middleware for `/api/v1` should replace per-handler
    headers (T-0079 or a small task);
  - a contact timeline item id is md5(event id, field), so one audit row naming a field twice would collide. No writer
    produces that today; a writer-side assertion would make it impossible.
