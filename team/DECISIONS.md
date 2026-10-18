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
**Status:** ANSWERED 2026-10-12 by @acexode: the lead recommendation (answers stay on the run in Phase 2).
- **The conflict.** Form nodes that write contact fields would let an agent edit more than D-P14 allows (status and owner).
- **Lead recommendation:** in Phase 2, answers stay on the script run only. Later, a grant scoped to the script's bound
  fields, audited.

### D-P32 — who edits and approves compliance wording in scripts (M10 Q1)
**Status:** ANSWERED 2026-10-12 by @acexode: the lead recommendation (the admin set).
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

### D-L91 — T-0112 in-call script contract rulings (lead, reversible)
**Status:** PROCEEDING (lead). From the T-0112 contract writer, with three lead additions.
- **Frames:** P10/01 agent mid-call (with the version banner), P10/02 required field missing, P10/03 disposition blocked, P10/04
  from the start, P10/05 the admin script builder.
- **Node kinds** are the design's six: say, question, form, branch, compliance, end. There is no disposition node; completion
  sets the disposition, and an `end` node may carry `suggestedDispositionId`.
- **The concurrency token is `revision`**, since "version" means a published script version. Stale writes are `409 stale_write`.
- **Errors:** nine new codes in admin's shared `Error.code` enum. The decision order is published as `x-kasuwa-error-order`;
  `x-kasuwa-permission` and `x-kasuwa-classification: pii` (on answers) are new extensions.
- **Who sees authoring:** reading a script needs `script.write`. Anyone else gets 404, so the authoring writes have no 403. Run
  reads are open to `script.run` holders in the programme; run writes are for the run's own agent (others 403).
- **A withheld field stops the run** (`200`, `status: stopped`, `stopReason: field_withheld`). A stopped run can only be
  completed.
- **Added operations:** `listContactScripts`, `getScriptRunScript` (the pinned wording without `script.write`), and dispositions
  read through the run, so no programme id appears in a path.
- **Completion:** an unknown, cross-programme, inactive or deleted disposition is one `409 disposition_not_live`. A missing note
  or follow-up is `disposition_requirements_unmet`. Task and call activity are owned by the caller. An exact repeat returns 200
  and writes nothing.
- **Graphs:** shape is checked on save (400) and completeness on publish (`409 script_invalid`). Graphs are acyclic.
- **Content:** the seven design-menu locales; variables `contact.*`, `agent.displayName` and `answer.*`; callbacks in UTC;
  script names not unique; multi-programme publishing left out.
- **Lead additions:**
  - **A dropped call** completes with `outcome: interrupted`. That excuses the current node and any node not yet passed, never
    one already passed, and never produces an acknowledgement. The server records the unacknowledged compliance nodes on the
    run. This keeps a cut-off call from forcing a false "read in full".
  - **Idempotent start:** the same agent, contact and script with a run in progress returns that run with 200.
  - **No expiry in Phase 2.** A run stays in progress until its agent completes it; supervisor close waits for the role
    hierarchy (tracked).
- **Tracked:** `tests/e2e/support/admin-mock.generated.ts` is stale on main (reported by T-0078 and T-0112); regenerate it in
  the next admin-touching PR.

### D-L92 — `kasuwa_test_admin` is created by the shared bootstrap (lead, 2026-10-08; raised by the T-0102 migration review)
**Status:** PROCEEDING (lead). T-0117, P0 before any populated cell.
- **The problem.** `bootstrap.sql` creates `kasuwa_test_admin`, a BYPASSRLS login with the password `kasuwa_test_admin_dev`, and
  gives it DML on every future table. Real environments apply the same file through their own provisioning
  (`packages/db/CLAUDE.md`, ADR-0013), so a real cell would get a cross-tenant login whose password is in the repository,
  unless provisioning remembered to drop it. The header's "Testcontainers only" describes intent, not what the file does.
- **Ruling.** The test role moves to a test-only bootstrap file; real provisioning never applies it; the migration runner
  refuses a non-dev, non-test database that has the role (T-0117).
- **Not affected:** `kasuwa_migrator` stays BYPASSRLS by design (it owns the schema and never serves traffic), with its real
  password from the secrets manager.
- **T-0102 review follow-ups folded into 0029:** the rollback note (DROP TRIGGER is ACCESS EXCLUSIVE; use `lock_timeout`, and
  disable by name first); the header says "no role may lower it by UPDATE"; the self-check pins the trigger's WHEN clause.
  Also noted: the trigger does not fire under `session_replication_role = replica`, so a future logical-replication cell move
  (ADR-0002 tooling) must re-check on the subscriber.

### D-L93 — T-0112 security review rulings (lead, 2026-10-08; three review rounds)
**Status:** PROCEEDING (lead). Amends D-L88 and D-L91 for the in-call script contract.
- **Completion:** `completed` only at an `end` node or on a `stopped` run; otherwise `interrupted` or `409
  compliance_unacknowledged`. The run records `endedAtNodeId` and, when interrupted, every unread compliance node on the path,
  current node included.
- **Run visibility:** every run operation is the run's own agent's only; everyone else, and the own agent without
  `script.run`, gets 404. The one run 403 is completion without `activity.write`. A field-secured supervisor and QA read waits
  for M11 (tracked).
- **Audit (supersedes D-L88's "answers audited by name only"):** only start, supersede and completion are audited, naming
  `outcome`, `stopReason`, `dispositionId`, `activityId`, `followUpTaskId` and `versionId`. No node ids and no field keys.
  Acknowledgements and answer saves write no event of their own, since the count of events would reveal the branch side.
- **Publish refuses** a branch or variable on a field that any `script.run` set in the programme cannot read
  (`branch_on_withheld_field`), and one on a `sensitive` field (until D-L13).
- **At run time:** a branch on a field classified `sensitive` since publish stops the run (`sensitive_field`); a variable
  renders as a placeholder.
- **Start:** idempotent for the caller's own in-progress run, or a run stopped by `field_withheld` or `sensitive_field` on the
  same version. A `field_withheld` stop whose field is now readable is closed as `superseded` (no disposition, no activity,
  audited).
- **Bounds:** `revision` 1..2^31-1; bounded integers; NUL refused; 256 KiB per version and per run's answers; `followUp.dueAt`
  at most 366 days ahead.
- **Privacy:** answers are classified `sensitive`. Runs follow programme retention and are erased with their contact (the
  D-P27 sweeper). Run error `details` are never logged or traced. Wording is plain text.
- **Acknowledgements** record the locale the client reports it showed, and a server-set `profileLocale`.
- **Tracked:** the outcome shown on the call activity; allowed dispositions per end node (a product question); the
  `script.write` gate on `listProgrammeScripts` when T-0113 backs it; a stopped run on an older version stays until retention.

### D-L94 — T-0117: `kasuwa_test_admin` becomes an inert placeholder, not absent (lead, 2026-10-08; amends D-L92)
**Status:** PROCEEDING (lead). Raised by the T-0117 suite writer under the task's "Escalate if".
- **Why not "absent".** Fourteen applied migrations (0000 to 0027) grant to or revoke from `kasuwa_test_admin` without a
  role-exists guard, so a database without the role fails at 0000. Re-baselining them would break append-only (CLAUDE.md 4),
  and a security fix should not start by waiving a hard rule.
- **The model.**
  - `bootstrap.sql` creates the role as an inert placeholder: NOLOGIN, NOBYPASSRLS, NOINHERIT, no password, no memberships
    either way. It holds the migrations' grants, but nobody can use them. No login role is its member, so `SET ROLE` cannot
    reach it, and making it a login needs CREATEROLE, which no cell role holds.
  - `bootstrap-test.sql` (dev compose and Testcontainers only) turns it into the test login.
  - The migration runner refuses, outside development and test, when the role can log in, bypasses RLS, has a password, or
    has any membership.
- **Two related guards, in the same task:**
  - an unset `NODE_ENV` is refused against a non-local database host;
  - outside development and test, the runner and the API (through `@kasuwa/config`) refuse a connection URL carrying one of
    the repository's dev passwords. This closes the same hole for `kasuwa_migrator`, `kasuwa_app` and `kasuwa_auth` if
    provisioning forgets to pre-create them.
- **Suite rulings accepted:** there is no `staging` environment in `@kasuwa/config` (staging runs as production); the
  production config is `NODE_ENV=production` plus `KASUWA_AUTH_MODE=jwt`; exactly three password literals remain in
  `bootstrap.sql` (migrator, app, auth); `kasuwa_sweeper` stays NOLOGIN with no password.
- **Tracked:** isolation's `auth-availability` timing suite fails whenever two heavy jobs share the host. Give it its own
  serial stage in `test:isolation` (a lead edit to the test setup).
- **D-L94 addendum, from the rewritten T-0117 suite (2026-10-08):**
  - **Judge what `pg` will use.** `pg-connection-string` lets `?host=` and `?password=` override the URL and percent-decodes
    the password. Every guard parses the URL the way `pg` does, never with `new URL()` alone.
  - **`PGHOST`, `PGPASSWORD` and `PGUSER`** in the environment are refused outside development and test (read through
    `@kasuwa/config`), since `pg` falls back to them.
  - **The worker** refuses dev passwords the same way as the API.
  - **API and worker boot:** in production, refuse to start when `kasuwa_test_admin` can log in or bypass RLS (readable from
    `pg_roles` as `kasuwa_app`). The runner's check runs only at migration time; this one runs at every deploy.
  - **Accepted limits:** the migrator cannot read whether a NOLOGIN role has a password (superuser-only), so a "password alone"
    refusal is not possible, and a role made a login is caught at the next boot or migration. An explicit
    `NODE_ENV=development` against a remote host is not refused. `NODE_ENV=''` is invalid, not unset. "Unset" is read raw,
    not through `nodeEnv()`.

### D-L95 — T-0117 security review rulings (lead, 2026-10-08; corrects the D-L94 addendum)
**Status:** PROCEEDING (lead).
- **Correction: the ADMIN-only exception was wrong.** A login role holding ADMIN on `kasuwa_test_admin` can grant the role to
  itself with SET and become it (proven live by the review). An ADMIN-only membership is ignored only when the member is a
  superuser or CREATEROLE role, which could do the same anyway; anyone else holding ADMIN is refused.
- **An unset `NODE_ENV` is refused outright** by the migration runner, the API and the worker, whatever the host. Loopback is
  not "development": database tunnels (cloud-sql-proxy, `kubectl port-forward`, SSH and SSM) listen on 127.0.0.1. Every dev
  entry point sets `NODE_ENV` explicitly. This also closes the pre-existing case where an unset `NODE_ENV` let stub auth boot.
- **`db:seed`** judges its host the way `pg` does (it trusted `new URL()`, which `?host=` defeats).
- **Dev passwords** are matched after SASLprep. The list gains the superuser's `postgres`.
- **Every `PG*` environment variable,** and `NODE_PG_FORCE_NATIVE`, is refused outside development and test.
- **`db:reset`** refuses whenever enforcement is on, before any DROP.
- **A test pins** that `@kasuwa/config`'s `pg-connection-string` is the version `pg` uses.
- **D-L95 narrowed (2026-10-08):** the "unset `NODE_ENV` refused" rule applies to the API and the worker, the guard that runs
  at every deploy. The migration runner keeps D-L94's rule: unset is refused only against a non-local host. A loopback tunnel
  is a documented limit there, and the boot check catches it at the next deploy. `.env.example` keeps not setting `NODE_ENV`
  (Nx injects it into every task and `next build` breaks); dev and test entry points set it per process. Lead suite edits:
  `baf38d8` (two `workerEnv` calls pass `NODE_ENV: 'test'`; the T-0117 suite pins the API and worker refusal).

### D-L96 — T-0113 script authoring suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). From the T-0113 suite writer; its rulings 1 to 16 are accepted. The main ones:
- **`createScript` answers 403** to a non-writer in a programme they reach, as the contract says. Every write or read of an
  existing script is 404, and `listScripts` is an empty page.
- **`branch_on_withheld_field`** is judged against every set holding `script.run` (agent, team lead, programme manager),
  whether or not anyone holds it today. Translations and choice labels are checked like the source wording.
- **The size cap counts UTF-8 bytes**, so the API's JSON body limit must be raised to admit a draft up to the cap (400
  `too_big` above it, never 413).
- **Two concurrent publishes** of one revision mint one version; the other is 409.
- **`unchanged` compares content.** Duplicate node ids are refused.
- **Audit:** `object_type 'script'`; publish is a new action, `published`. Migration 0030 extends audit_event's action CHECK
  and `AuditAction` with it, and nothing else. The publish event names compliance node ids only.
- **A non-uuid `versionId`** is 404.
- **Tables:** `programme_id` on `script_version`; ON UPDATE RESTRICT on every FK; both tables in 0030; the migrator may move a
  script that has no versions. A published version refuses even a no-op UPDATE, for every role including the migrator.
- **The seed** carries one published script version in tenant A (as D-L77 for activity). The `script` plant fixes `name` and
  `source_locale`; every other column has a default.
- **Lead-authorised edits to existing suites, in the same PR:** T-0112's contract suite (authoring flags true, run flags
  false); T-0027's dispositions-scripts (an agent gets 404 on `listProgrammeScripts`, a `script.write` holder 200); T-0011's
  schema-hygiene (`script` plant, an immutable `script_version`). None loosens anything.
- **Builder follow-ups not pinned:** the web `AuditAction` enum and an `admin.audit.action.published` key;
  `AUDIT_OBJECT_TYPES` gains `script`.

### D-L97 — verification rules from the 2026-10-08 cross-PR breaks (lead)
**Status:** PROCEEDING (lead).
- **A contract change updates every e2e mock that validates against that spec, in the same PR.** #109 (T-0080) made `version`
  required and broke T-0062's mock, merged an hour earlier. Before opening a contract PR, grep `tests/e2e/support` for the
  changed schema.
- **Every merge gets a full isolation run, docs-only PRs included.** #107 (T-0112, contract YAML plus its suite) was verified
  on the platform folder only; its vendor-name list failed `channels/provider.acceptance` on main. The fix (store the list
  reversed) is waiting on @acexode's approval of the acceptance edit.
- **The RAM lock:**
  - lead verifications take a `lead-verify` lock and hold both slots for the isolation stage;
  - while `lead-exclusive-wait` exists, no agent takes a new slot;
  - no agent ever holds one slot while waiting for another;
  - a slot is never stale by age.
- **Disk:** an idle worktree's `.next`, `.nx` and `dist` are cleared (regenerable). C: filled to 0 bytes on 2026-10-08.

### D-L98 — T-0063 account record suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). From the T-0063 suite writer; its rulings are accepted. The main ones:
- **Children are a contract gap.** Nothing serves an account's children (Account carries only `parentAccountId`; listAccounts
  has no parent filter). The journey `@p05-account-children` stays a fixme. **Follow-up T-0118 (contract first):** a children
  read or a `parentAccountId` filter, with the `field_withheld` rule when `parentAccountId` is withheld.
- **The breadcrumb** walks `parentAccountId` up with getAccount: root first, at most four ancestors, each read once. A served
  cycle stops it, and a withheld `parentAccountId` is a lock with no ancestor read.
- **The account edit sheet** is on the record page (T-0057's sheet; `version` plus changed fields only; 403 is the gate, D-L84).
- **The account timeline** completes a task with the version its item carries (now possible since #109). A 409 shows an
  alert and re-reads.
- **Logging from the account** sends `accountId`, with no `contactId`.
- **The contacts grid** pages by keyset, shows no count, and keeps withheld, empty and failed as three states.
- **A non-uuid id** is a real 404 that reaches no API (`map` is among the test ids).
- **Hidden:** rollups and money, health, the map, deals, tickets, quotes, invoices, campaigns, billing, RC number and TIN,
  inferred DND, related counts and access requests.
- **The budget:** `/accounts/[id]` is provisionally 245,000 B; the lead re-pins it within 5% of the first measurement.
- **Follow-up T-0119:** the contact record completes a task seen only on the timeline, using the item's `version`. T-0062's
  mock must record versions served on timeline items. `@p05-contact-complete-served` becomes a real journey; the mock and spec
  pins are re-pinned by the lead.

### D-L99 — T-0103 former-owner suite rulings (lead, reversible)
**Status:** PROCEEDING (lead). From the T-0103 suite writer.
- **No application code removes a programme member**, and no admin operation does. Removal happens only in the database: a
  tenant-admin `kasuwa_app` DELETE or rewrite of `user_programme` (0021), or the migrator. So the unassignment lives in the
  database, as a trigger on `user_programme` in **migration 0031** (T-0103). T-0084's reserved 0031 is released; T-0084 is
  renumbered when it starts (it waits on D-P33). A membership-removal admin API is a later contract decision, and the
  database rule stays as its backstop.
- **Contract:** `ContactOwner.displayName` is nullable and still required; `null` means a former owner. `TimelineActor` is
  unchanged: former actors stay named (D-L81). The change only widens the schema, so no e2e mock pin moved (D-L97 checked).
- **Audit:** one event per removal that unassigns anything, in the removed membership's programme, with the remover as actor
  and the count as a change's `after`. It names no contact id or name. Whether the trigger is immediate or deferred is the
  builder's choice, as long as the unassignment commits and rolls back with the removal.
- **Races:** removal against a concurrent assignment or self-claim never leaves a contact owned by a non-member. A losing
  assignment is 400 `unknown_reference` or 404. Trap: `FOR KEY SHARE` on `user_programme` is filtered by 0021's restrictive
  UPDATE policy for non-admin sessions, so the lock must work for an agent too.
- **Follow-up T-0120:** `Account.owner` and activity owners have the same former-owner leak, and removal does not unassign
  them. Apply D-P23 to both.
- **D-L99 addendum (2026-10-08, T-0103 build):**
  - **Every ended membership is audited, even when it unassigns nothing** (`unassignedContacts: "0"`), because membership is
    a permission change (CLAUDE.md 6.7). Removals cascading from a deleted programme, tenant or user write nothing: a user can
    be hard-deleted only by the migrator, and only once nothing references them. `removedMember` (a staff id, D-L71) stays.
  - **No backfill:** owners already outside their programme before 0031 read as former owners (D-L65).
  - **The web shows a former owner as a translated "Former owner"** label, never the id, in the same PR (D-L97).

### D-L100 — T-0113 merged; the `auth-availability` timing suite is unreliable on this host (lead, 2026-10-08)
**Status:** PROCEEDING (lead).
- **T-0113 (#111) follow-ups:** T-0121 (error envelope and `no-store` on body-parser and path-decode failures; the urlencoded
  no-op's name; optionally a route-scoped body limit). The empty draft is a single `end` node, and publish refuses it as
  `empty_script`.
- **`auth-availability` ("a database-backed request while 16 sign-ins are in flight on a two-connection pool")** now fails on
  main itself, with both RAM slots held: 178.7 ms against a 131.7 ms bound, and 152.4 ms against 100.0 ms. The host also runs
  another project's stack (Kafka, Postgres, Redis) and idle Nx daemons. Until the host is quiet or the suite gets an
  environment-relative bound, a failure of that one test is judged against main, run alone, at the same time. A PR that fails
  it while main also fails it is not blocked. The other `auth-availability` tests still gate.

### D-L101 — T-0103 migration review rulings (lead, 2026-10-08; amends D-L99)
**Status:** PROCEEDING (lead).
- **Deadlock-free removal.** A statement ending two memberships can deadlock with an owner change between those members
  (reproduced). The unassignment moves to a statement-level trigger: it takes every ended membership's lock in sorted order,
  then unassigns.
- **Index** `(tenant_id, owner_user_id, programme_id)` on contact in 0031, so a removal reads only its programme. The cost
  (about 2.45 s per 100k owned contacts) is in the header; a future removal API needs a cap or an async job.
- **Recoverable removals (amends D-L99's "names no contact id"):** besides the programme event, each unassigned contact gets
  its own audit event, `updated`, change `ownerUserId` with before = the removed user's id and after = null. Staff ids are not
  customer PII (D-L71). T-0078 redacts the values on read until T-0104 adds `ownerUserId` to the contact allow-list. A
  mistaken removal can then be undone from the audit log, and each contact's timeline shows the owner change by name.
- **Every writer of `contact.owner_user_id`** must take the membership lock through `programmeMemberExists`, which asserts
  READ COMMITTED. Any future import or bulk reassign included.
- **D-L101 amended (2026-10-08):** the per-contact unassignment audit events move to **T-0104** (audit: convert and
  takeover). That task already records before/after owner ids (D-L71) and owns the suite edits. T-0103's suite pins exactly
  one programme event with no contact id, and T-0103 ships as pinned. Until T-0104, a mistaken removal is recoverable only by
  point-in-time restore; no populated cell exists (D-L65).

### D-L102 — the lost-update rule for every edit sheet (lead, 2026-10-08; from the T-0063 security review)
**Status:** PROCEEDING (lead).
- **Rule.** An edit sheet sends `version` plus ONLY the fields the person changed, judged against the row the form was opened
  on. After a 409 and a re-read, the form is the fresh row with the person's edits re-applied. A field both people changed
  keeps the typed value and shows a translated "changed by someone else" note. A field the person never touched is never
  sent, after any number of 409s.
- **Why.** T-0062's contact sheet (on main) and T-0063's first account sheet resent untouched fields' old values with the
  fresh version after a 409, silently overwriting the other person's save. In the reproduction, a deleted phone came back.
  Both are fixed in #112, with unit tests of the reviewer's scenarios.
- **Applies to** every future edit sheet: deals, scripts, custom fields. Suites for them include a second-save-after-409
  journey.

### D-L103 — T-0117 round-2 security rulings; `db:reset` and `db:seed` need an explicit environment (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **Folded into T-0117** (the round-2 security review passed, with minors only):
  - the ADMIN-only exemption also requires that the serving role cannot reach the holder (`pg_has_role ... 'MEMBER'`);
  - `db:seed` refuses an explicit `NODE_ENV=production`;
  - `.env.example`'s NODE_ENV note is corrected.
- **Not in T-0117: `db:reset` through a loopback tunnel.** With `NODE_ENV` unset and a loopback URL (`kubectl
  port-forward`, cloud-sql-proxy), `db:reset` still drops every table. D-L95's loopback allowance was accepted for the
  runner because the boot check catches a real cell at its next deploy. A DROP cannot be caught later, so the allowance does
  not extend to destructive tools.
- **Rule.** `db:reset` (and any future destructive dev tool) requires `NODE_ENV` set explicitly to `development` or
  `test`. An unset value is refused. The root script sets it through a small node wrapper, with no new dependency. This
  becomes a P1 follow-up (T-0122) after T-0117, and is unchanged from main until then.

### D-L104 — T-0114 suite rulings; T-0114 assigned (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **Suite:** `tests/acceptance/scripting/script-runs.acceptance.test.ts` (95 tests) on `lead/T-0114-acceptance`. On main, 91
  fail for the real reason (no `/script-runs` routes, no `script_run` table, the flags are false) and 4 self-checks pass.
- **R1–R12, written in the suite header, are accepted:**
  - run audit events use `object_type 'script_run'`;
  - acknowledging again returns the run unchanged;
  - composite FKs keep a run's script, version, agent and contact consistent, and `kasuwa_app` cannot re-point them;
  - an exact completion repeat is 200 after its disposition is deactivated, but a cursor naming one is invalid;
  - a withheld-field stop is the same whatever the value;
  - `profileLocale` is null for an unsupported locale;
  - a script can start already stopped (201);
  - a stopped run on an older version stays as it was;
  - completion is atomic (shown with a planted fault).
- **The builder owes unit tests for:** the completion 403 without `activity.write` (every set holding `script.run`
  holds it today) and the `SCRIPT_RUN_SET_KEYS` pin.
- **Lead edit on the suite branch:** the T-0112 suite's "the nine run operations stay false until T-0114" now expects
  true. If `script_run` gets `updated_at`, the builder seeds a run so `schema-hygiene` exercises it, or escalates.
- **Migration 0032** is reserved for `agent6/T-0114` (hook allowance on the suite branch).

### D-L105 — T-0081 contract rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead). Contract and suite are in PR #115 (lead PR; the task is contract-only, so it has no builder).
- **Accepted as written:**
  - **Buckets:** overdue is due before now; today runs from now to the next midnight in the caller's `timeZone`; upcoming
    is at or after that midnight, with undated tasks last. Completed tasks are not listed; the calendar shows them with
    `completedAt`.
  - **"Own"** means `ownerUserId` is the session's user. An unowned activity is on nobody's list. P07's composer sets the
    owner to the caller.
  - **A withheld time** (`dueAt`, or a meeting's `startsAt`/`endsAt`) drops the row before the page is cut, because its
    position would disclose the value.
  - **Cursors:** one `400 invalid_cursor` body whatever the reason; a row moved since may skip or repeat on a later page.
  - **`MyActivity`** carries contact and account summaries, with no body and no owner.
  - **Update:** `startsAt`/`endsAt` are not nullable; `dueAt` null clears it; `completed` admits only `true`.
  - **Out:** priority, attendees, location, reminders, bulk operations, booking, check-in and the AI brief.
- **The `record.activity.type.meeting` key** ships with the contract (D-L97 spirit): without it the record screen suites
  go red on main.
- **Owed by T-0082/T-0083:** `apps/web/lib/contact-record-api.ts` parses ActivityType as note, task or call. It must
  accept `meeting` before or with the change that puts meetings on a timeline.
- **Process lapse, recorded:** the suite writer removed a RAM slot another agent held and ran without one. The rule stands:
  never remove a slot whose `owner.pid` is alive; wait instead.

### D-L106 — T-0104 suite rulings; T-0104 assigned (lead, 2026-10-12)
**Status:** PROCEEDING (lead). Suite edits are on `lead/T-0104-acceptance`: on main, 12 fail for the real reason and 373 pass.
- **Accepted:**
  - **contact-timeline T10 is edited too.** It pinned the owner change as redacted with no ids, which T-0104 (D-L71)
    contradicts. The timeline-side pins are unchanged.
  - **Unassignment events:** each per-contact event has the remover as actor (as the programme event does), and
    `object_label` is the contact id, never a name.
  - **Owner values are canonical lower-case uuids**, whatever case the client sent.
  - **A create that sets an owner records `before: null`** as a value (D-L81's create rule).
  - **A convert-created account's event** names `name` and records names only; the rest of the field list is the
    builder's.
  - **The programme event** is identified as "the new row that is not a contact event"; it is otherwise unchanged.
- **The migrator path (P3) follows the programme event:** per-contact events are written exactly where the programme
  event is, and nowhere else. P3 keeps its assertion.
- **Owed by the builder:** `ownerUserId` added to the value-field lists in `admin.openapi.yaml` (`AuditChange`) and
  `records.openapi.yaml`.
- **Migration 0033** is reserved for `agent3/T-0104`; 0032 is T-0114's.

### D-L107 — T-0114 review rulings; T-0082 meeting-time rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **T-0114: the migration, security and tenancy reviews all passed with findings. Fixed before merge:**
  - **Migration 0032:**
    - an index on `(tenant_id, started_by_user_id)`, so that offboarding does not scan users × runs;
    - a tighter disposition check;
    - a format check on `completion_digest`;
    - an `octet_length(answers)` database backstop at twice the API's 256 KiB cap.
  - **Code:**
    - `FOR SHARE` on the disposition read at completion;
    - `SendAfterCommitInterceptor` refuses to send while a tenant transaction is active, never sends twice, and has unit
      tests for its order;
    - error paths never echo a non-conforming key;
    - `RUN_LIST_MAX` is enforced or removed;
    - a `tenancy-reviewed` comment, and the docs drift.
- **Accepted, recorded:**
  - **No FKs on `disposition_id`, `activity_id` or `follow_up_task_id`.** Neither target has a `(tenant, programme, id)`
    key. The code writes those ids only from scoped reads in the same transaction. The raw-SQL residuals (updating
    `disposition`'s id or programme, or `activity.contact_id`) join the D-L76 key-guard follow-up.
  - **Completion's call activity and follow-up task get no audit events of their own.** R1 pins two events per run; the
    ids are on the run's `updated` event.
  - **Retention of run answers is deferred to the D-P27 sweeper.** Answers are sensitive and nothing erases them yet. The
    sweeper task (with T-0095's deletion work) must delete a contact's runs before the contact (the FK is RESTRICT) and
    honour programme retention. The completion digest is unsalted. Erasure must clear it, or it becomes an HMAC under a
    per-tenant key.
  - **Dates in form fields count days in Africa/Lagos** until tenants have a time zone, and `en-NG` is recorded as a null
    `profileLocale`. Both are revisited when tenant settings land.
  - **Own-agent-only is enforced in the API**, while RLS stops at the programme. Any future reader of runs (the M11
    supervisor view) must re-implement it, and its suite must pin that.
- **T-0082 meeting times (lead suite edits on `lead/T-0082-acceptance`):**
  - The database refuses a meeting without both times, an end at or before its start, and times on a non-meeting.
    The 24 h limit is the API's (`too_long`).
  - `startsAt` and `endsAt` are withholdable on timeline items (omitted and named, the row stays). The timeline-v2
    all-withheld test locks them too.
  - The builder adds `startsAt: null, endsAt: null` to the `listContactTimeline` and `listAccountTimeline` examples in
    `records.openapi.yaml`, in the same PR as the flag flip; two self-checks depend on it.
  - Migration 0034 is reserved for `agent3/T-0082`.

### D-L108 — T-0104 review rulings; T-0114 merged (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **T-0114 merged (#116)**, verified on a clean host: isolation 2,313 / 2,314. The one failure is `channels/provider`, red
  on main since #107. An earlier run on the same head was void because the host collapsed (disk full, the Docker engine
  failing).
- **T-0104 (#117): the migration and security reviews passed. Fixed before merge:**
  - 0033's self-check also asserts the triggers' shape;
  - the convertContact wording names both audit events.
- **Accepted:** an admin-audit reader at `owner_user_id: none` can infer a former owner by lining up a contact `updated`
  event with the programme event's `removedMember` id. Staff ids are not customer PII (D-L71), the reader already reaches
  the programme, and `removedMember` was already visible under 0031.
- **Host rule (from the collapse):**
  - keep at least 10 GB free on C: before a full verification;
  - remove a merged task's worktree once its report is filed;
  - stop stale `node` processes from a dead session before re-running.

### D-P33 — the search-index route under RLS (raised by T-0084)
**Status:** ANSWERED 2026-10-12 by @acexode: the lead recommendation.
- **The problem.** Under FORCE RLS, Postgres uses an index for a predicate only when its functions are LEAKPROOF. The
  trigram and jsonb operators T-0084 planned are not, so kasuwa_app could not use those indexes.
- **Answer:**
  - T-0084 ships id-only cursors and the plain-column indexes the lists need now, and defers the trigram and jsonb GIN
    indexes.
  - Marking specific builtins LEAKPROOF comes later. It needs a review of each function (a superuser act, so an ADR) before
    it is done.
  - Search (T-0085–T-0087) builds on that.

### D-L109 — how the team speeds up (from @acexode, 2026-10-12)
**Status:** PROCEEDING. @acexode chose these after a day lost to a single overloaded verification host.
- **Batch merges.**
  - Up to three PRs that are reviewed and ready are verified together: one full run (gates, isolation, the e2e tags they
    touch) on a branch that merges them in order.
  - Green means each merges in that order, with `--match-head-commit`, and the PR comments name the batch run.
  - A red result is bisected by re-running only the suspect PR's suites.
  - This supersedes "a full isolation run per merge" (D-L97) for batched PRs. A lone PR still gets its own run.
- **Risk-based reviews.**
  - **All three reviewers** (migration, security, tenancy): a PR with a migration, auth, permissions or data-access
    (repository/SQL) code.
  - **One combined review** (security and tenancy together): a PR that is only UI, contract text, mocks or docs.
  - Findings are still fixed before merge.
- **Cloud builders.** Builders run as remote sessions where possible, so they do not hold the laptop's RAM slots. Lead
  verification stays local (CI minutes are exhausted).
- **D-P31, D-P32, D-P33 and the `channels/provider` fix** (store the T-0112 suite's vendor names reversed, so that the
  adapter-boundary scan does not see them) are approved by @acexode.

### D-L111 — the full isolation suite runs once, at the end of Phase 2 (from @acexode, 2026-10-12)
**Status:** PROCEEDING. @acexode chose this for speed. It supersedes the per-merge full isolation run (D-L97, D-L109's batch
runs).
- **Every PR still gets** (`verify.ps1 -Targeted`):
  - lint, typecheck, unit and integration;
  - the PR's own named acceptance suites (the task file's list, and every suite whose pins or mocks the PR changes);
  - the whole `tests/acceptance/tenancy` folder: RLS enforcement, schema hygiene, the adversarial suite, API, repository and
    cursor isolation, and the test-admin lockdown;
  - the e2e tags the PR touches.
- **At the end of Phase 2:** one full `pnpm test:isolation` on main. Every failure is fixed before Phase 2 is called done.
  Each finding names the PR that introduced it, from bisecting the merge history.
- **The risk @acexode accepted:** a regression in an older suite (cross-task: screens, field security, audit) can sit on
  main until the final run, and costs more to trace then. The tenancy folder on every PR keeps cross-tenant and
  cross-programme leaks caught at merge.
- **Unchanged:** reviews (D-L109's risk-based rule), the never-edit-a-test rule, and fixing every finding before merge.

### D-L112 — T-0084 suite rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead). Suite `list-indexes.acceptance.test.ts` (43 tests) on `lead/T-0084-indexes-acceptance`. On
main, 25 fail for the real reason:
- every sort has a Sort node and reads the whole scope;
- the cursors carry a timestamp or a name;
- there is no 0035.
- **Accepted as written (rulings 1–11 in the suite header):**
  - index use is checked for both a one-programme agent and an all-programme supervisor;
  - the seed is 120k contacts and 60k accounts;
  - seeking is judged by rows examined, not time;
  - `q` is outside the index checks (D-P33);
  - Incremental Sort is allowed and Sort is not;
  - a cursor stays valid without its filter;
  - a cursor may carry the id, the sort's name and a small version, never a value;
  - a cursor naming another programme's or tenant's row answers exactly as an invented id does;
  - the latency budget is a regression alarm, not the gate.
- **Ruling 8:** the sort key drops `left(display_name, 200)`. `left` is not LEAKPROOF, so under FORCE RLS no keyset
  predicate on it is an index condition. The cut only bounded a cursor that carried the name.
- **Existing tenancy suites:** `cursor-tampering` and `adversarial` build or decode today's `{c, i}` cursors. The builder
  keeps them green unmodified if it can, for example by decoding the old shape by its id alone. If it cannot, it stops and
  names the exact assertions, for a lead edit made in ask mode.
- **Migration 0035** is reserved for `agent3/T-0084`.

### D-L113 — T-0105 contract rulings; where "cloud" agents actually run (lead, 2026-10-12)
**Status:** PROCEEDING (lead). The contract and suite are in PR #119 (a lead PR; the task is contract-only).
- **R1–R13 in the suite header are accepted.** The notable ones:
  - **R1:** board, list and create sit under the pipeline path; the move is a POST action on the deal.
  - **R2 rights:**
    - `deal.write`: agents, on their own deals only;
    - `deal.write_any` and `deal.reassign`: team lead, programme manager and admin;
    - `pipeline.write`: admin only.
  - **R3:** a deal starts in the first open stage, which has no requirements.
  - **R4:** a closed deal is edited only with `deal.write_any`.
  - **R7:** a required field the mover cannot read refuses the move with 403 whatever its value, the one exception to
    403-before-400.
  - **R12:** rotting is computed by the server.
  - **R13:** configuration writes and deal deletion are not in this contract.
- **Where a pipeline comes from:** T-0106 seeds a default pipeline per programme at provisioning (and backfills existing
  programmes), from the template. A pipeline-create operation waits for the `pipeline.write` contract.
- **`client_portal` reads deals** as it reads contacts and accounts. Revisit under D-P26 before M18.
- **"Cloud" agents:** remote isolation is not available in this environment, and the agent tool falls back to a local
  worktree. So D-L109's cloud builders are local worktrees for now. The RAM rule still applies to every agent.

### D-L114 — T-0115 and T-0116 suite rulings; one builder for both screens (lead, 2026-10-12)
**Status:** PROCEEDING (lead). The suites are on `lead/T-0115-T-0116-acceptance`: builder 41 tests, agent 45, with the
shared `scripting-mock.ts`. On main, 74 fail for the real reason (no flag, route or web process) and 12 self-checks pass.
- **Accepted:** builder rulings 1–11 and agent rulings 1–11 in the suite headers. Notable:
  - the builder's non-admin "real 404" waits for the capability read (T-0079; `@p10-builder-access-404` is a fixme), and
    until then a non-writer meets one generic not-found;
  - the builder has no nav entry until a capability read exists;
  - saves are explicit;
  - "changed fields only" is top-level for the whole-graph replace, with the 409 rebase done per node;
  - the agent screen never evaluates a branch; "completed" is offered only at an end node or a stopped run; the run has
    its own route `/script-runs/[runId]`;
  - the contact record calls scripting only once the start control opens.
- **One builder, one PR for both** (they share the mock and the `crm_scripts` flag), with one combined review (UI only,
  D-L109). The suites land with that PR, never before (the T-0114 precedent).
- **Budgets:**
  - `/contacts/[id]` may grow with the start control. The lead re-pins it within 5% of measurement, at most 245,000 B.
  - The builder's and the agent screen's budgets are provisional (260,000 / 245,000 B) and are re-pinned at merge.
- **If a builder disputes an assertion** (untouched nodes sent exactly as served, branch labels word for word, the hidden
  words "ready" and "hold", the checkbox for acknowledgement), it stops and reports. It never works around one.

### D-L115 — T-0105 contract review rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead). The combined review of #119 passed with two majors and eight minors, all folded in before
merge:
- **client_portal has no pipeline or deal reads** until D-P26 is enforced for deals. The shapes carry staff names
  (`checkedBy`, `owner`) and free text (`nextStep`), which D-P26 keeps from portal users. Restoring the reads later is
  additive.
- **`closedSince`:** at most 366 days back (`window_too_long`, never clamped); a future value is `invalid_window`.
- **Withheld `ownerUserId`:** `own` rights act as `none`, so there is no ownership oracle.
- **Currencies:** NGN, GHS, KES and ZAR only; an unknown code is `400 unknown_currency` in a body and in a filter alike.
- **Totals** are summed in `numeric`.
- **Bounds:** `maxItems` on every list.
- **Personal data:** deal `name` and `nextStep` are `pii`.
- **Reassignment audit:** records the before and after owner ids (D-L71).
- **Search:** `q` wildcards match literally.
- **Path ids:** a non-uuid id is the same 404 (no schema `format: uuid` may turn it into a 400). T-0107 and T-0108 must not
  validate ids before the scoped lookup.

### D-L116 — T-0084 review rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead). The migration and security/tenancy reviews of T-0084 passed with findings.
- **Fixed in this PR:**
  - **Single-programme sessions** query with scalar `programme_id = $p`, and 0035 adds the three missing programme-led
    orders. Otherwise a one-programme agent in a skewed tenant (a new or small programme) pages through other programmes'
    rows, bounded only by tenant size.
  - **The old programme-led indexes stay:** they are the single-programme path ("keep and use", not "measure and drop").
  - **The 0035 header** states the skew case, names the CONCURRENTLY recipe file (`0034a_…`, no-transaction), and notes
    the LEAKPROOF check covers same-type operators.
  - **The self-check** also compares collation and `indoption`.
  - **Legacy `{c, i}` cursors** with a `v` or `s` key are refused, and cursors are checked against the base64url alphabet
    before decoding.
- **Accepted:**
  - **Id-only cursor semantics:** a deleted or out-of-scope cursor row ends the walk with an empty page, and an edited
    sort key re-seeks from the row's current key (D-L80, I5, cursor-tampering). A single "cursor no longer resolvable"
    answer would be a contract change; revisit before cells hold real data.
  - **Timing:** a sub-millisecond difference between an other-programme id and an invented id in the seek. Judged not
    exploitable over HTTP.
- **Later, only if measured:** a per-programme MergeAppend for supervisors who reach a few of many programmes, with a
  skewed-seed case added to the list-indexes suite.

### D-L117 — T-0106 suite rulings (lead, 2026-10-12)
**Status:** PROCEEDING (lead). The suite `pipeline-tables.acceptance.test.ts` (109 tests) is on `lead/T-0106-acceptance`. On
main, 103 fail because the tables do not exist, and 6 self-checks pass.
- **R1–R15 in the suite header are accepted.** Notable:
  - every row keeps its pipeline through composite FKs;
  - a `field` requirement stores the api_name;
  - the template is the contract's getPipeline example (7 stages, "B2B sales"), with the contract's seed transition rule;
  - a deal's `stage_id` moves only along a transition of its pipeline (R5);
  - `amount_minor` and `currency` are both set or neither;
  - requirement checks are insert-only for kasuwa_app;
  - deal contact and account FKs never cascade;
  - archived, paused and draft programmes are backfilled;
  - the board's orders use an index with no Sort as kasuwa_app under FORCE RLS.
- **R9, provisioning:** `createProgramme` creates the default pipeline in its own `withTenantTransaction`. It must NOT use
  a new SECURITY DEFINER function or a wider policy; 0015's created-in-this-transaction marker is the precedent. If that
  cannot work, the builder stops and escalates.
- **R10:** `ensureStandardObjectDefs` repairs a programme with no pipeline, idempotently (ids unchanged).
- **Migration 0036** is reserved for `agent3/T-0106`. The seed needs at least one deal, or schema-hygiene fails on
  `deal.updated_at`.

### D-L118 — T-0083's budget journeys; at most two heavy agents at once (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **T-0083's budget journeys** no longer call `page.clock.setFixedTime`. Playwright's fake clock replaces
  `window.performance`, so the first-contentful-paint they measure never arrived and both journeys timed out on every run.
  This was a defect in the lead's spec, not the screen. `ACTIVITIES_BUDGET_BYTES` is pinned at 236,000 (measured
  225,171–225,683 B; first paint 1.9 s at 256 kbps/300 ms). The spec pin moves with it (`lead/T-0083-budget`).
- **Concurrency cap:** at most TWO heavy agents (builders, suite writers running containers, or a lead verification) run at
  once on this host.
  - Twice on 2026-10-12, four at once took RAM below 2 GB and hung Docker Desktop, voiding verification runs and
    failing argon2 for want of memory.
  - Reviews that only read run alongside.
  - Before a verification: at least 10 GB of disk free, and no leftover processes from finished agents.

### D-L119 — lead suite fixes for T-0115 and T-0106; T-0106's creation marker (lead, 2026-10-12)
**Status:** PROCEEDING (lead).
- **T-0115** (`lead/T-0115-T-0116-pins`):
  - `@p10-builder-list` checked a draft that sorts onto page 2 before "more" was clicked. It now checks a page-1 draft
    (Customer survey) before "more" and Hardship after it, so nothing is weakened.
  - Budgets are pinned from measurement: `/scripts/[scriptId]` at 250,000 B (measured 238,632) and `/script-runs/[runId]`
    at 240,000 B (measured 229,366).
- **T-0106** (`lead/T-0106-fixes`):
  - the rotation test restores `SET CONSTRAINTS ALL DEFERRED` after its control probe. `probe()`'s RELEASE kept IMMEDIATE,
    which contradicted the empty-pipeline rule;
  - `field-security-objects` lists the standard `deal` object, as T-0060 did for `activity`.
- **T-0106 R9 is accepted as built.** The four configuration tables' FOR ALL policies admit
  `tenant AND (programme in scope OR 0015's created-in-this-transaction marker)`, copied word for word from 0015, with
  WITH CHECK identical to USING. It admits nothing new, adds no SECURITY DEFINER and no permissive FOR INSERT policy.
  `deal` and `deal_requirement_check` do not carry the marker. The migration and security reviews confirm it.
### D-L120 — review rulings for T-0083, T-0115/T-0116 and T-0106; the Mac host (lead, 2026-10-12)
**Status:** PROCEEDING (lead). First session on the MacBook.
- **Host.** Worktrees live in `/Users/Shared/kasuwa-wt/` because the repo path and `$HOME` contain a space. On this Mac's
  pnpm, `pnpm -s test:unit` fails ("unexpected argument '-s'"); `tools/lead-verify.sh` now uses `pnpm run -s`.
- **T-0106 first Postgres run:** pipeline-tables 109/109, the tenancy folder 151/151. **R9 is confirmed** by the
  migration, security and tenancy reviews.
- **T-0106, fixed before merge (builder, inside 0036, which is not yet applied anywhere):**
  - `pipeline_stage_position_key`, `pipeline_stage_one_won_key` and `pipeline_stage_one_lost_key` lead with
    `pipeline_id`. A kasuwa_app INSERT naming another tenant's pipeline gets 23505 (unique) when it exists and 23503 (FK)
    when it does not: a cross-tenant existence oracle. They lead with `(tenant_id, programme_id, pipeline_id, ...)` like
    every other key in the file, with a builder-written integration test.
  - `ensureDefaultPipelines` without a `programmeId` filters on tenant only and leans on RLS for programme scope (CLAUDE.md
    2.3). It is documented as migrator/provisioning-only and asserts it.
- **T-0106, money (needs @acexode, lead suite edit with auto mode OFF):** the task file and suite pin `amount_minor
  numeric(18,0)`. That contradicts CLAUDE.md section 4, the founding pack (`amount_minor bigint`) and D-P line 1381 ("bigint
  minor units"), and numeric(18,0) silently ROUNDS '1.5' to 2 where bigint refuses it. The lead's recommendation: change
  the suite and the task file to `bigint` before merge, while the table is new and empty. The same edit replaces the
  realistic name `adminDisplayName: 'Kemi Adebayo'` (suite l.3038) with synthetic text (CLAUDE.md 6.1).
- **T-0106, carried to T-0107/T-0108 (not blocking):** a RESTRICTIVE FOR INSERT policy needing the marker on the
  configuration tables when pipeline.write is designed; `checked_by_user_id` and `owner_user_id` bound by the API (owner
  membership, D-L67); the API never takes `version`, `updated_at`, `stage_entered_at` or `closed_at` from a body; fractional
  amount strings refused before insert; T-0107 copes with a programme that has no pipeline yet (deploy-window repair); no
  unique key on `pipeline (tenant_id, programme_id)`, so several pipelines per programme stay possible by design.
- **Lead suite edits (D-L119) are disclosed to @acexode** for confirmation, as the tenancy review asks.
- **T-0083 review: pass.** Server enforcement of `activity.reassign` confirmed in `packages/permissions/src/policy.ts`.
  Follow-ups, not blocking: drop the `as unknown as ActivityChange` cast in the reschedule form; show a lock, not an empty
  input, for a withheld time.
- **T-0115/T-0116 review: pass.** Fixed before merge (builder): the run screen's `Money.amountMinor` gets
  `.regex(/^-?\d+$/)` so a malformed amount is "unavailable", not a render crash; the long-text answer gets
  `autoComplete="off"` like the input. Lead follow-up: the e2e mock's `example.ng` emails become `example.com` (RFC 2606).
### D-L121 — T-0106 money is bigint; lead suite edits confirmed (lead, 2026-10-13)
**Status:** PROCEEDING. Answers from @acexode on D-L120.
- **Money:** `deal.amount_minor` is `bigint` (CLAUDE.md section 4), not `numeric(18,0)`. The range stays 0 to 18 nines
  under an explicit CHECK; a fraction such as '1.5' is refused, never rounded. The suite (lead commit f2a88f5) pins the type,
  inserts with `$7::bigint` and adds the fraction case; the task file says the same. Migration 0036 is edited in place
  because it is not applied anywhere yet.
- **The fixture name** `'Kemi Adebayo'` became `'T-0106 Provisioned Admin'` (CLAUDE.md 6.1).
- **D-L119's two T-0106 suite edits** (the rotation test's restored deferral; `deal` in field-security-objects) are
  **confirmed by @acexode**, which closes the tenancy review's CRITICAL item.
- **Host note:** protect-paths reads the branch of the SESSION's checkout (main), not the edited file's worktree, so lead
  test edits in a `/Users/Shared/kasuwa-wt/lead-*` worktree are made with shell edits under auto mode OFF, which @acexode
  approves one by one.
### D-L123 — T-0107 suite rulings and contract follow-ups (lead, 2026-10-13)
**Status:** PROCEEDING (lead). The suite `pipeline-board-api.acceptance.test.ts` (38 tests) is on `lead/T-0107-acceptance`
(9c50b45). On main, 34 fail because the routes do not exist and the flags are false; the 4 self-checks pass. The contract
suite now expects the three pipeline reads to be `x-kasuwa-implemented: true` (a lead edit, same commit).
- **R1–R24 in the suite header are accepted.** Notable:
  - lost is not a board column; the contract outranks the task line (R2);
  - the reads have no 403, so the order is 404 before 400 (R3);
  - one 404 body for every cause (R4);
  - the won window is judged on `closed_at`, a lead ruling where the contract names `stage_entered_at` (R5);
  - one `400 invalid_cursor` body for board cursors (R8);
  - a non-uuid `stageId` is `400 unknown_reference` (R18);
  - plan checks on the board indexes with no Sort, as kasuwa_app, at 30,000 deals per programme (R20).
- **Contract follow-ups (a lead contract PR, not blocking T-0107):**
  - the board text says won is "entered the won stage" but orders by `closedAt`; align it with R5;
  - getPipeline documents a 400 that nothing can trigger;
  - `stageId` is `format: uuid` while the text promises `unknown_reference`;
  - the examples use realistic personal names ("Kemi Balogun", "Adaeze Okonkwo"), against CLAUDE.md 6.1;
  - the contract suite's test titles still say "not yet implemented" for the flipped operations.
- **Builder:** Agent 3 on `agent3/T-0107-board-api`.
### D-L124 — T-0108 suite rulings (lead, 2026-10-13)
**Status:** PROCEEDING (lead). The suite `deals-api.acceptance.test.ts` (49 tests) is on `lead/T-0108-acceptance`
(352e65d). On main, 45 fail because the routes do not exist and the flags are false; the 4 self-checks pass. The contract
suite expects the five deal operations to be `x-kasuwa-implemented: true` (a lead edit, same commit).
- **R1–R22 in the suite header are accepted.** Notable:
  - client_portal gets the one 404 on all five operations; D-L115 outranks the older "403" sentence in createDeal (R1);
  - `name` is never withheld, even under a `none` grant (R13);
  - closed bodies, with `__proto__` and `constructor` refused as 400 (R15);
  - leaving won or lost without write-any rights is a 403 decided before the body is read (R17);
  - on a move, the required-field 403 comes before both 409s (R20);
  - lead rulings:
    - an agent with `ownerUserId` withheld becomes the owner by omitting it, and sending it is `403 field_not_editable` (R21);
    - an out-of-scope deal cursor is one `400 invalid_cursor` body (R22).
- **Contract follow-ups (added to D-L123's lead contract PR):** createDeal's portal 403 sentence; the block header's
  "`none` is 403".
- **Merge note:** T-0107 and T-0108 each edit the contract suite's flag assertion (l.1110). Whichever lands second resolves
  it to all eight operations `true`.
- **Builder:** Agent 3 on `agent3/T-0108-deals-api`, in its own `deals` module, alongside T-0107.
### D-L122 — verification per slice, not per PR (@acexode, approved 2026-10-13)
**Status:** PROCEEDING. Supersedes D-L111's per-PR lead run; the end-of-Phase-2 full isolation run stands.
- **Per PR:** the reviews (D-L109) stay. The builder's own evidence is accepted: its suite, the tenancy folder, unit, lint
  and typecheck. After rebasing, the lead runs lint, typecheck and the PR's own suites.
- **At the end of each slice** (for example after T-0107–T-0111): one `tools/lead-verify.sh` on main, covering unit,
  integration, the tenancy folder and every suite of the slice. A failure is fixed before the next slice merges.
- **Merges:** @acexode allowed `gh pr merge`, `gh pr view` and `gh pr list` for the lead session, so the lead merges once
  reviews pass and the checks above are green.

### D-L125 — T-0107 lead suite fix (lead, 2026-10-13)
**Status:** PROCEEDING. Two board tests read cards that the suite's own model puts on page 2 at the default limit of 20
(`d(24)`, `d(25)`, `d(20)`). They now pass `limit 50`; the default limit keeps its own test. Found by the builder, confirmed
by the lead (98393b7).

### D-L126 — T-0108 lead suite fixes (lead, 2026-10-13)
**Status:** PROCEEDING. Found by the builder, confirmed by the lead against the contract (e3baa50):
- the R1 "nothing audited" check counts deal events only, because `unassign` writes its own membership event (0031/0033);
- the 18-nines test plants Proposal's entry check before moving into Proposal;
- a backward move is gated by the target stage's requirements too (D-P20), so the R6 test plants Proposal's check before
  moving back.

### D-L127 — two pipeline product rulings (@acexode, 2026-10-13)
**Status:** PROCEEDING.
- **Custom permission sets do not read pipelines or deals yet.** Readers stay the five standard sets plus the tenant-admin
  flag (`PIPELINE_READER_SET_KEYS`). When a customer needs it, an explicit per-set "read deals" grant arrives, turned on by
  an admin.
- **A check-ticker who has left the programme is unnamed,** like a former owner (D-P23). This goes into T-0110 (deal detail)
  for the screen and into the API's `checkedBy` when T-0110's suite pins it.

### D-L128 — answers to ADR-0015 to ADR-0018 (@acexode, 2026-10-13: "the lead's recommendations")
**Status:** ANSWERED. All four ADRs are Accepted.
- **ADR-0015 (search):**
  - production Postgres is planned as self-hosted, because no AWS region serves the Lagos Silo cells and the role bootstrap
    needs a superuser too. T-0005 confirms it;
  - search ships first on plain prefix indexes, which work on any Postgres, and the LEAKPROOF marks follow once a true
    superuser is confirmed;
  - stored folded search columns are approved (Q1);
  - `textlike` is NOT marked; search moves to trigram similarity, with a lead edit to T-0084's search pins (Q2);
  - a nesting limit on `phones`/`emails` before `jsonb_contains` is relied on (Q3).
- **ADR-0016 (custom fields):**
  - 100 fields per object and 32 KiB per record (Q1);
  - pii and sensitive fields start at `none` for unlocked sets until an admin grants access (Q2);
  - retire instead of delete, with the purge job a later task (Q3);
  - equality on picklist and boolean only, with no sorting, in Phase 2 (Q4);
  - one currency per currency field (Q6).
- **ADR-0017 (object storage):**
  - AWS S3 af-south-1 for za-1 and MinIO for Lagos Silo cells (Q1);
  - Bridge shares the cell bucket under its own prefix (Q2);
  - SSE-S3 now, per-cell KMS later (Q3);
  - 25 MB and 100,000 rows (Q4);
  - raw files deleted after 7 days, subject to counsel (Q5);
  - no failed-rows CSV with values (Q6);
  - the import job runs as the initiating user (Q7).
- **ADR-0018 (outbox):**
  - `programme_id` NOT NULL until a tenant-level case appears (Q1);
  - system jobs act as the user who started them (Q2);
  - published rows kept 7 days and dead rows 30; dead after 10 publish or 5 consumer attempts (Q3);
  - a dashboard, not paging (Q4);
  - BullMQ's failed set trimmed by hand for now (Q5).
### D-L129 — T-0111 suite rulings and lead edits (lead, 2026-10-13)
**Status:** PROCEEDING (lead). The suite `deal-timeline.acceptance.test.ts` (49 tests) and the contract edit
(`listDealTimeline`, `GET /api/v1/deals/{dealId}/timeline`; `dealId` on Activity, CreateActivityRequest and
UpdateActivityRequest) are on `lead/T-0111-acceptance` (8077fef). On main, 42 fail because there is no column, route or
flag; 7 self-checks and contract pins pass. Migration 0037 is reserved for `agent3/T-0111` in protect-paths (202c2ea).
- **R1–R19 in the suite header are accepted.** Notable:
  - `dealId` is a link, never a target: a contact or account still decides the programme (R1);
  - one `unknown_reference` body for another programme's deal, another tenant's deal and an invented id (R2);
  - linking needs `activity.write` only and never writes the deal row (R4);
  - `dealId` follows the `activity.deal_id` field security (R5);
  - deal-timeline field items come from a closed list, by name only. Stage-name display ("Proposal → Negotiation") is a
    later additive contract edit (R8);
  - readers follow D-L127 (R12);
  - the timeline index has no Sort as kasuwa_app at 20,000 activities (R15);
  - no rollup of the contact's or account's other activities (R19).
- **Lead edits, same branch (ac18252), so the task file's "unmodified" line does not hold for these three:**
  - `records-contract-activities` lists `dealId` in the update body;
  - `records-contract-pipeline` R13 admits `listDealTimeline` as the one later GET under `/deals`;
  - `activity-table` gains the `deal_id` column, its required field_def and its `deal` lookup target.
- **Open for T-0110 (screen and product):** a deal with neither a primary contact nor an account has nothing to log an
  activity against (R1). The screen must say so rather than offer a broken composer.
- **Builder:** Agent 3 on `agent3/T-0111-deal-timeline`.
### D-L130 — T-0109 suite rulings (lead, 2026-10-13)
**Status:** PROCEEDING (lead). The suite is on `lead/T-0109-acceptance` (4a32038):
`pipeline-board.acceptance.test.ts` (51 tests), `p06-pipeline.spec.ts` (42 journeys) and the contract-validated
`pipeline-mock.ts`, which T-0110 reuses. On main, 45 wrapper tests fail because there is no flag, route or
`webPipelineUrl`, and every self-check passes.
- **R1–R20 in the suite header are accepted.** Notable:
  - `/pipelines` lists pipelines and `/pipelines/[pipelineId]` holds board and list behind a view switch (R1);
  - money is exact Intl currency format, never compact and never through a JS number. The design's compact totals are
    overruled by D-P19 (R5);
  - rotting comes from served values, not the design's fixed thresholds (R8);
  - the list view has no count and no footer totals (D-P13) (R13);
  - the card links to the deal in T-0110, which re-pins the spec (R15);
  - write controls are shown to every caller, with the 403 as the gate (D-L84) (R20).
- **Wiring:** the builder adds `crm_pipeline` to the e2e runner and publishes `webPipelineUrl`, as T-0083 and T-0115
  did. Naming an unregistered flag stops the records process booting, so the lead's suite only asserts it (R3).
- **Byte budget:** `PIPELINE_BUDGET_BYTES` is a placeholder, pinned by the lead from the builder's measurement within 5%,
  under 260,000 (R19).
- **Follow-ups:**
  - listContacts and listAccounts have no programme filter, so the requirement picker filters on the client. A
    contract decision is worth taking later;
  - there is no user directory read, so the owner filter offers me, unassigned and the owners seen on cards;
  - `run-e2e.mjs` leaves `tsx src/main.ts` API processes behind after it exits (a harness task);
  - `apps/web/lib/admin-format.ts` `formatMoney` loses precision past 2^53 and must not be reused for deals.
- **Builders:** Agent 11 on `agent11/T-0109-pipeline-kanban` and Agent 3 on `agent3/T-0111-deal-timeline`, in parallel.
### D-L131 — T-0111 lead fix, review rulings and follow-ups (lead, 2026-10-13)
**Status:** PROCEEDING (lead).
- **Lead suite fix (413a648):** activity-table's catalogue self-check built `deal_id` as text after ac18252 added it as
  a required lookup. It now builds the `deal` lookup. No implementation could have passed the old fixture.
- **The deal unique key `deal_tenant_programme_id_key (tenant_id, programme_id, id)` is an accepted exception to
  D-L120.** The FK needs it, and since `id` is already unique through the primary key and RLS WITH CHECK runs before the
  unique checks, it answers nothing new. Confirmed by the migration, security and tenancy reviews. 0037's section 8
  checks only that it leads with tenant and programme.
- **Fixed before merge:**
  - 0037's scale split plan, in the right order;
  - two self-check comments that claimed more than they checked;
  - a unit test pinning that every `activity.write` set is also a pipeline reader, without which `dealId`'s
    `unknown_reference` would become a deal-existence check.
- **Follow-ups:**
  - **Timeline performance (all three timelines):** the served query is a UNION of audit changes and activities ordered by
    a computed key, so its index narrows to the record but every page sorts all of the record's items. The T-0111 plan
    check (R15) covers a simplified activity-only query. A timeline-performance task should give each branch an ordered,
    index-served seek before merging, and pin the served query's plan.
  - **Deal deletion and erasure:** `activity.deal_id` is ON DELETE RESTRICT. When deal deletion or NDPA erasure arrives,
    it must clear or reassign links first, never surface a 23503.
  - **Contract tidy-up (the D-L123 lead contract PR):** "contract only until T-0111" wording, and a realistic name in the
    `listDealTimeline` example.
### D-L132 — T-0110 suite rulings; the former-checker follow-up (lead, 2026-10-14)
**Status:** PROCEEDING (lead). The suite is on `lead/T-0110-acceptance` (094fb27), built on `lead/T-0109-acceptance`:
`deal-detail.acceptance.test.ts` (53 tests), `p06-deal.spec.ts` (38 journeys) and `deal-mock.ts`, which imports
T-0109's mock unchanged. On main, 45 wrapper tests fail because there is no route, flag or harness wiring, and the
8 self-checks pass.
- **R1–R22 in the suite header are accepted.** Notable:
  - `/deals/[dealId]` is a real 404 when the flag is off or the id is malformed; an out-of-scope deal is the generic
    not-found page (R1);
  - the close date is a calendar date that must not shift with the browser's zone, checked from UTC-1 (R6);
  - a former checker gets its own translated label (R8);
  - reassign is "assign to me" only, until T-0079 and a member directory (R11);
  - the timeline is re-read after each write, never spliced (R15);
  - **D-L129's open item:** an activity targets the deal's own contact and/or account. With neither visible, there is
    no composer, and the screen says why (R17).
- **Lead edits on the branch:**
  - the contract's `DealActor.displayName` becomes `[string, null]` for D-L127;
  - T-0109's spec is re-pinned to `f227bfa7…`, because board cards now link their deal (T-0109 R15 reworded).
- **Follow-ups:**
  - **T-0123** (filed): the deal APIs serve `null` for a former checker. Its lead edit replaces
    `pipeline-board-api` R17, which named checkers by their current name;
  - createActivity and the pickers' `x-kasuwa-screens` do not list P06/05 (the D-L123 contract PR);
  - there is no field-editability read before a write, so `403 field_not_editable` is the only signal;
  - an orphaned check, whose requirement was later removed, has no label in the contract.
- **Order:** the T-0110 builder starts after T-0109 merges, because it needs T-0109's flag, harness wiring and move sheet.
### D-L133 — T-0085 search contract rulings (lead, 2026-10-14)
**Status:** PROCEEDING (lead). Merged as #128. `searchRecords` (`GET /api/v1/search`) and `lookupRecords`
(`POST /api/v1/search/lookup`) are contract only. T-0086's suite flips the two flag tests to `true`, as T-0105's did.
- **R1–R22 in the suite header are accepted.** Notable:
  - folded **prefix** matching on whole field values. Trigram comes later, as an additive change (R3, D-L128);
  - `q` is 2 to 100 characters (R4);
  - field security per row, in each hit's own programme. A withheld field never affects which hits are chosen (R7);
  - **D-L68 for search:** `displayName` is readable only when both name parts are; it is never composed (R8).
    **T-0124** carries the rule to the contact, lead and record-view reads;
  - each type's own readers, and an empty group for a type the caller cannot read (R9);
  - no counts or facets (R12); 400 and 401 only (R15).
- **Lead rulings:**
  - **the URL never carries a phone number or an email address (R21).** Exact lookups are a non-mutating POST with a
    closed body. After NFKC normalisation, a `q` containing `@`, or 6 or more digits once separators are removed, is
    `400 identifier_in_url`, and clients send such input to the lookup;
  - `unknown_property` uses the fixed path `body` and never echoes a client's key.
- **Design items overruled** (T-0087 expects them absent): partial-number search, the hidden-results count, facet and
  chip counts, persisted recent searches, and the scope menu (deferred under D-L87).
- **Open:** `listContacts` and `listLeads` `q` still accept a number in the URL, as their contracts say ("name or
  number"). Bringing them under R21 is a contract change, folded into T-0124's scope.
### D-L134 — T-0086 suite rulings; the search throttle joins the contract (lead, 2026-10-14)
**Status:** PROCEEDING (lead). The suite `search-api.acceptance.test.ts` (67 tests) is on `lead/T-0086-acceptance`
(f97a89c, 18d0e81), with migration 0038 reserved for `agent3/T-0086` (b83be3c). On main, 61 tests fail because there
is no 0038, no route and the flags are false; 4 self-checks and 2 guards pass.
- **R1–R24 in the suite header are accepted.** Notable:
  - the folded copies are generated stored columns, `<source>_search`, because `normalize()` is IMMUTABLE. 0038 creates
    no function (R1, R3);
  - btree indexes `COLLATE "C"`, led by `(tenant_id, programme_id, <column>)` (pinned interfaces);
  - plans are judged by replaying the statements the API sends, with no Seq Scan, the range in the Index Cond and at
    most 500 rows examined per table (R5, R6). This applies T-0111's lesson;
  - search answers within 250 ms and the lookup within 500 ms on the 120k/60k/60k seed (R8). The lookup plan is not
    pinned until `jsonb_contains` is leakproof;
  - a national number of 6 digits or fewer is `invalid_phone`, so the contacts list's looser phone parser must not be
    reused (R10);
  - the folded copies follow their source on every write path; no erasure route exists yet (R19);
  - no log line or span carries `q`, the lookup body or a hit's name (R22).
- **Lead contract edit (18d0e81): the throttle is in the contract.** Both search operations gain `429
  too_many_requests`, with the shared Error shape, an optional `retryAt` and `no-store`, decided first after
  authentication. The limit is per user, with separate budgets and a tighter one for the lookup. T-0085's contract suite
  now pins `['200','400','401','429']`.
- **Open:** what counts as a valid number of 7–9 digits per country, beyond R10's clear case. The 0038 header must say
  that a STORED column rewrites `contact` under ACCESS EXCLUSIVE, acceptable only while no cell is populated (D-L65).
- **Builder:** Agent 3 on `agent3/T-0086-search-api`.
### D-L135 — T-0086 review rulings, the Unicode identifier rule, and follow-ups (lead, 2026-10-14)
**Status:** PROCEEDING (lead). T-0086 merged as #130 (migration 0038).
- **Identifier rule, strengthened (contract 0.12.2):** after NFKC, a `q` is `400 identifier_in_url` if it contains `@`,
  or if, once every character that is neither `\p{L}` nor `\p{Nd}` is removed, it holds a run of 6 or more `\p{Nd}`
  digits of any script. The contract's `not` pattern is the same rule as a `u` regex. T-0087's client rule (R27) follows
  it: text with a digit and no letter is phone-like.
- **Lead suite edits (3fb072b):**
  - `deal.name_search` is pinned in pipeline-tables;
  - the 120k-row seeds in search-api and list-indexes insert 10,000 rows per statement, so they no longer hit the 30 s
    statement timeout on a loaded host. The data is identical.
- **Leads index shape:** the leads view's status filter is not an index key. On a 1%-leads tenant the leads group
  examined up to 24,240 rows, so 0038 adds four partial lead indexes and the leads query sends the predicate as
  literals. Rows examined drop to 0.
- **Accepted risk:** the search throttle's counters are per process. They must move to Redis (or another shared store)
  before a second API instance serves traffic.
- **Follow-ups:**
  - a lead edit adding a low-lead-tenant plan test to search-api, because its seed is too lead-heavy to catch a
    regression of the partial indexes;
  - statement size grows with programmes × fields for users in hundreds of programmes. It goes into the
    timeline-performance task (D-L131) as a search item;
  - pin the Postgres image by digest or ICU version before the first cell, so the folded columns cannot drift silently
    on a re-pull;
  - D-L80's query-string stripping must cover the web ingress as well as the API.

### D-L136 — T-0123 suite rulings; timeline actors stay named (lead, 2026-10-14)
**Status:** PROCEEDING (lead). Suite on `lead/T-0123-acceptance` (6e38540).
- **Rule pinned:** `checkedBy.displayName` is `null` when the checker has no `user_programme` row in the deal's
  programme at read time (the D-P23 owner test). The tenant-admin flag and membership of another programme do not
  count. Re-adding someone names them again. `checkedBy.id` is always served. Each check is judged on its own.
  Covered reads: getDeal, listDeals, getPipelineBoard cards, and the updateDeal and moveDeal answers
  (pipeline-board-api R17 replaced; deals-api R23 added).
- **Deal timeline out of scope:** the task file's "the deal timeline's actors where they are checkers" is dropped.
  Timeline actors are the people behind events and activities, and D-L81 names them even after they leave the
  programme. The timeline has no `checkedBy`, and the suite stays as it is.
- **Load note:** under a load average near 150, two untouched tests timed out (a field-security test in deals-api,
  and the board plans seed). Both pass on a quiet host. This is the 2026-10-14 machine crash (PR #132), not a defect.

### D-L137 — T-0087 review rulings: palette fixes, re-pin, budget and PR split (lead, 2026-10-14)
**Status:** PROCEEDING (lead). The combined review (D-L109) of `agent11/T-0087-command-palette` (c1c18d6..36e1048)
found no privacy or contract defect.
- **Fix before merge:**
  - **M1:** Escape in the palette must not also close an overlay behind it. Use a capture-phase handler with
    `stopPropagation`, and don't open the palette over an `aria-modal` dialog;
  - **M2:** the focus trap ignores `tabindex="-1"` links;
  - **M3:** a same-route "see all" applies the new `q` and drops it from the address bar;
  - **M4:** a failed palette chunk shows a retry-or-close state instead of crashing the screen, and the loading state
    closes on Escape or a backdrop click;
  - **M5:** a 429 draws `records.error.too_many_requests`, not "check your connection";
  - **L1:** the minimum query length counts code points, as the server does;
  - **L2:** the shortcut also accepts `event.code === 'KeyK'` and ignores Shift;
  - **L3:** search strings ship only when `crm_search` is live;
  - **L4:** the header link has `prefetch={false}`;
  - **L5:** the dialog is labelled with `aria-labelledby`, and the result count is announced.
- **Lead re-pin of the T-0087 suite:**
  - deal hits link to `/deals/<id>` only while `crm_pipeline` is live, and are otherwise unlinked. T-0110 merged first,
    so T-0087 does the re-pin;
  - `SEARCH_BUDGET_BYTES = 223_000`: it passes both measured runs (213,798 and 214,306 bytes) with about 1.4 KB of
    slack below and 4% of headroom. Re-measure after the fixes;
  - new journeys for M1, M2 and M3.
- **PR split (A1 section 3.3):** three stacked PRs.
  - **A:** the flag, i18n, the harness and the lib client;
  - **B1:** the search panel, the `/search` route and the message ids;
  - **B2:** the palette, the shell wiring and the Gap 3 list changes.
- **Merge gate:** the browser halves of all eleven records-ui and scripting-ui suites, each against its pinned budget
  (the tightest is `/pipelines/[pipelineId]`, with about 5.5 KB of headroom). They run when no other project's Docker
  stack is up.

### D-L138 — T-0088 suite rulings: custom-field contract names and codes (lead, 2026-10-17)
**Status:** PROCEEDING (lead). Suite on `lead/T-0088-acceptance` (d812a46 and a follow-up commit).
- **Records contract:**
  - **Schemas:** `CustomFields`, `CustomFieldsPatch` (1–100 keys, a value or `null`), `CustomFieldValue` (anyOf the six
    encodings) and `CustomFieldWithheldPath`.
  - **Where `custom` goes:** on Contact in `ContactPendingProperties`; on Account in a new `AccountPendingProperties`
    allOf part; on Activity and Deal in their own `properties`.
  - **Filters:** `custom[key]=value` (deepObject) and a repeatable `customEmpty`, on listContacts, listLeads, listAccounts
    and listDeals.
  - **400 errors** are `validation_failed` with one of these detail codes: `unknown_field` (unknown and retired keys get
    the same code, so no key's past existence leaks), `invalid_value`, `unknown_value`, `currency_mismatch`,
    `custom_too_large`, `field_withheld`, `filter_not_supported`.
  - **403** is `not_permitted` with the detail `field_not_editable`.
- **Admin contract:**
  - **Operations:** `GET|POST /api/v1/admin/custom-fields`, `PATCH /api/v1/admin/custom-fields/{fieldId}`, and
    `POST …/{fieldId}/retire`. There is no delete and no type change.
  - **Update body:** exactly `label`, `description`, `classification`, `addValues` and `relabelValues`.
  - **Classification can change after create (D-P25),** raised or lowered, and is audited. Reclassifying never rewrites
    the field-security matrix; the pii/sensitive default of `none` applies at create only (D-L128 Q2).
  - **Limits:** 409 `limit_reached` (`field_limit_reached`, `picklist_limit_reached`). Retired fields do not count
    toward the 100, because no purge exists.
  - **Permissions:** the writes need `custom_field.write`, a tenant-admin action (D-L53), and are audited. The list needs
    no permission.
- **Encodings:**
  - currency `amountMinor` is signed, with at most 18 digits;
  - `is empty` applies to picklist and boolean only;
  - currency codes are NGN, GHS, KES and ZAR;
  - there is no `isRequired` on custom fields in Phase 2.
- **Lead edits to merged suites,** the minimum needed to admit `custom`:
  - records-contract-pipeline and records-contract-activities: the exact key sets;
  - the deal-timeline static `withheldFields` check;
  - leads-mock filters, with the leads-screen pin re-pinned.
- **Later:** custom deal fields as stage requirements.

### D-L139 — T-0088 build rulings, and main verified after #137 (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **Lead edit (9228674):** p02-live-api's "exactly KPIs and skill cover unbuilt" check leaves out the `custom-fields` tag.
  Those operations belong to the P18 studio (T-0090), not the P02 console.
- **Contract rulings:**
  - updating or retiring a retired custom field is `400 validation_failed` with the detail `field_retired` at `fieldId`,
    not a 404, because the list shows retired fields;
  - a duplicate picklist value is `400 duplicate_value` at `addValues`;
  - custom `text` is single-line: it refuses `\n`, `\r`, U+2028, U+2029 and NUL (`textarea` stays a refused type);
  - Contact and Account `withheldFields` items stay plain strings;
  - Activity and Deal `withheldFields` items use `anyOf` (the enum, or `custom.<key>`).
- **`custom_field.write`** joins `TENANT_ACTIONS` in T-0089, together with the guard that uses it.
- **Main verified after #137** (2f8b622 plus #137, 2026-10-17):
  - all gates, the tenancy suite (151, on re-run; the first try hit a Docker port-binding start-up error), and all 11
    records-ui and scripting-ui suites with their budgets;
  - features-register, deals-api, search-api, and pipeline-board-api (39/39 twice on re-run).
- **The one-off pipeline-board failure** had no `Cache-Control` header at all, like the T-0123 "foreign 401": a response
  from a process that is not the test API. Twice now; watch for a port collision in the test harness.
- **#133 proven at scale:** after 11 records-ui wrappers, no `next-server` or `tsx` process was left in the worktree.
- **Pre-existing on main:** `metadata/standard-object-metadata` fails 2 of 41, because 0038's `name_search` column has
  no `field_def`. It is filed as a separate task.

### D-L140 — T-0088 security review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The combined review of the T-0088 contract passed with one major and six minor findings.
- **The size limit must not reveal withheld bytes (major).** Before this ruling, `custom_too_large` was judged on the
  whole stored object, so an editor could binary-search the size of keys withheld from them.
  - The API limit is now **16 KiB**, measured on the merged `custom` restricted to keys the caller can read in the row's
    programme, plus the keys being written.
  - Withheld and retired values never count. The 32 KiB DB CHECK (ADR-0016 item 2) is a backstop only.
- **Bad keys:** a key that fails the `__c` pattern is reported at path `custom`, or at the query parameter, with
  `unknown_field`. The key is never echoed.
- **`CustomFieldNumber`:** `maxLength` 40.
- **Bounded definitions:**
  - `listCustomFields?includeRetired`, default false;
  - at most 500 definitions per object counting retired ones (`409 limit_reached` / `field_limit_reached`);
  - the 100 active-field limit stands.
- **Admin write order:** 401, then 403 (`custom_field.write`), then 404, then 400 (`field_retired` and body codes). A
  repeat retire answers 200 unchanged (suite R12, which overrides the D-L139 note) only after the 403 and 404 checks.
- **Logging:** custom values are never logged or traced, whatever the classification (D-P25), by the same reasoning as
  audit by key only.
- **Lead edit (a00d22f):** the leads mock withholds `custom.<key>` inside `row.custom`, and its leak check looks there.
- **For T-0090:** the studio warns when a field's classification is raised, because reclassifying never rewrites the
  matrix (D-L138), so cells already at `edit` stay `edit`.
- **Noted:** `unknown_field` for retired keys does not hide past existence from tenant users, because the admin list shows
  retired fields. It is kept for one code path; nothing leaks.

### D-L141 — T-0089 suite rulings, and the T-0088 limits pins (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The T-0089 suite is on `lead/T-0089-acceptance` (bc205a5): storage, admin API, values API
and budget, about 160 tests. Every failure is for the real reason. The suite header's S, A, V and F rulings stand,
including:
- a withheld key is listed in `withheldFields` even when the row has no value for it;
- retired keys appear in neither `custom` nor `withheldFields`;
- writes read back only the keys they patch;
- withheld and retired values survive other callers' writes;
- definitions are read live (no per-process cache);
- `q` and global search never match custom values.

**Rulings:**
- **Retire is audited as `updated`** with a `retiredAt` change. There is no new audit action and no audit CHECK change.
- **The 500-value picklist limit** is reported at `config.values` on create and at `addValues` on update.
- **Audit reads may show custom key names,** because definitions are tenant-public. They never show values.
- **A write that only removes keys, or does not grow the caller-visible size, is never refused for size** (D-L140).
- **The board's top-level `withheldFields` is unchanged;** cards carry `custom.<key>`.
- **custom-fields-contract R19** (flags false) flips in a lead edit when T-0089 lands.
- **Lead edit to the T-0088 suite (D-L140):**
  - CustomFieldLimits is exactly `apiBytes` 16384, `bytesPerRecord` 32768 (the DB backstop), `definitionsPerObject` 500
    (retired included), `fieldsPerObject` 100 and `picklistValues` 500;
  - listCustomFields takes `object` and `includeRetired` (default false).
- **Process:** an agent started and then quit Docker Desktop. Docker is shared with the dialler project, so agents never
  start or stop it. Only the user does.

### D-L142 — T-0089 review rulings: the size backstop, retired values, and hardening (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The migration, tenancy and security reviews of `agent2/T-0089-custom-fields-api` all
passed with findings, with no critical finding. All three found the same major issue.
- **The 32 KiB DB backstop was reachable, which made it a size oracle.** Retired values accumulate, and three or more
  permission sets with disjoint readable keys can each legally store 16 KiB. A growing write then hit CHECK 23514 (a 500),
  and a binary search recovered the size of withheld bytes. Remapping the error alone would still leak. Ruling:
  - **The DB backstop becomes 512 KiB.** No set of live keys can reach it: 100 fields times the largest encoded value is
    about 410 KiB. @acexode's 32 KiB per record (D-L128 Q1) now lives as the stricter **16 KiB caller-visible API limit**
    (D-L140), which is the limit people actually meet. The backstop only stops a non-API writer.
  - **Every custom write drops retired keys** from the row (`(custom || $set) - $remove - <retired keys>`). Retired values
    are unreadable and unwritable already, so this is the purge happening as rows are touched. A purge of untouched rows
    stays a later task.
  - **A backstop 23514 is still mapped to `400 custom_too_large`,** never a 500, in case the backstop is ever reached.
- **Migration 0039 fixes:**
  - a custom field's `object_id` is frozen for every role, which closes moving a field to a custom object and then
    deleting it, or moving it and re-creating its `api_name`;
  - the restrictive DELETE policy is written positively (`EXISTS … o.is_custom`), so it fails closed;
  - `CHECK (retired_at IS NULL OR is_custom)`, and un-retiring is frozen for kasuwa_app;
  - `lock_timeout` is 2s;
  - the self-check also asserts the CHECK definitions and `prosecdef = false`.
- **Code fixes:**
  - filters are built on the projected `custom` (a second SQL layer);
  - the size measure takes `FOR UPDATE OF t`, so concurrent writes cannot race past 16 KiB;
  - text values and picklist labels with a lone UTF-16 surrogate are `400` (`isWellFormed`), never a 500;
  - a unit test proves no standard audit field name ends in `__c`.
- **Accepted as built:**
  - admin create parses the body before checking `objectApiName` (the object is a body field, not a path);
  - audit stores custom keys as bare api names;
  - creates are serialised through `field_security_version`, so a matrix editor holding a stale version gets 409;
  - a custom field's `config.currencyCode` is frozen by the API only. A DB freeze is noted for the next lifecycle
    decision.
- **Follow-up task:** purge retired custom values on rows nobody writes, with a retention period agreed with counsel
  (NDPA).

### D-L143 — T-0089 final rulings: filter shape and older-suite edits (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **Filter shape (a deviation from D-L142, accepted).** Evaluating the whole projected `custom` inside a filter broke the
  120k budget: Postgres fell back to a bitmap scan and a sort. So a filter on key `k` reads
  `CASE WHEN programme_id = ANY(<programmes where k is readable>) THEN custom -> k END`. It is the projection for that one
  key, from the same session-built readable map. SQL still fails closed on its own, and the budget keeps its bounded
  seek (first page about 24 ms, deep page about 25 ms).
- **Lead edits (93b22dd):**
  - contacts-api, accounts-api, leads-api and contact-timeline admit the properties of the Contact and Account allOf
    parts (where `custom` lives, per the T-0088 placement pin);
  - pipeline-board-api admits `custom: {}` on cards;
  - pipeline-tables and activity-table list `custom` as an optional column (the storage suite requires it);
  - the values race test detects waiters through `pg_locks`, because kasuwa_migrator cannot read other roles'
    `pg_stat_activity` wait columns.
- **Builder fixes forced by existing guards:**
  - `CreateContactBody` names `custom` instead of spreading it, because of the tenancy adversarial tripwire;
  - `standard-object-guards.integration.test.ts` now expects a custom field's type change to be refused (ADR-0016
    item 9).

### D-L144 — T-0090 and T-0091 suite rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **T-0090** (`lead/T-0090-acceptance`, 515daaa; 42 static tests and 27 `@p18-studio` journeys):
  - **Placement:** the studio is under **admin-ui**, at `/admin/custom-fields` in the admin shell. The operations are in
    the admin contract, writes need the tenant-admin flag, and definitions are not programme-scoped.
  - **The flag** is `crm_custom_fields`, off and not production-ready. The P02 `cu-fields` menu entry is a link only
    while the flag is on.
  - **Who may write:** controls show to everyone and the API's 403 is the gate (D-L84). A read-only list for
    non-writers waits on T-0079 (a fixme).
  - **The byte budget** of 262,000 is provisional and is re-pinned from the builder's measurements.
  - **The P18 design is overruled by the contract wherever they conflict:**
    - retire, never delete;
    - type and api name are immutable, and api names carry `__c`;
    - six types, and NGN/GHS/KES/ZAR only;
    - a classification control (the design has none);
    - no picklist value removal;
    - no usage counts and no plan meters.
- **T-0091** (`lead/T-0091-acceptance`, 297e844):
  - **The flag:** the same `crm_custom_fields`, read on the server by all eight record routes and never named by a
    client module.
  - **Leads:** the lead record is the contact record (D-P17).
  - **Activities:** custom values appear only on the create forms (values only), never on reads, because `MyActivity`
    and timeline items carry no `custom`.
  - **Read-only keys:** a key becomes read-only only after a 403 `field_not_editable`, since there is no capability read.
  - **Deals:** custom filters are on the pipeline list view only.
  - **Currency** is entered in major units and sent as integer minor units.
  - **Formats** match `Intl` for the page's locale. Dates are calendar dates, proven from a UTC-1 browser.
  - **Withholding** is decided per record from `withheldFields`.
  - **Mocks:** every existing record mock answers `listCustomFields` and serves `custom` (unchanged with no setup), with
    pins re-pinned.
  - Its shared mock is renamed `custom-values-mock.ts`, because T-0090 already owns `custom-fields-mock.ts`.
- **Order:** T-0090 builds first. T-0091's build waits for T-0090 to merge, because both register the flag and change
  the records process.

### D-L145 — T-0090 build and review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **Lead edits (41d24c8):**
  - the studio mock serves the P02 home's `/home/usage`, `/home/alerts` and `/audit/events` from their contract
    examples;
  - `@p18-studio-absent` reads only the studio's own regions, not the whole body;
  - `STUDIO_BUDGET_BYTES` is 266,000 (measured 259,164 to 260,023);
  - the P02 scripts-tab budget is 270,000 (measured 265,405 to 265,986; that spec's rule is about 2% headroom).
- **Accessibility:** unbuilt admin menu entries stay `aria-disabled`, not `aria-hidden`, so assistive technology still
  announces them. The test changed, not the screen.
- **The admin shell's live menu links** travel by prop from each page's server read (`adminLiveNav()`), not by a layout
  or context. A layout added a chunk to every admin route and broke two P02 budgets.
- **The seven non-English studio catalogues** are drafts pending native review (D-P1).
- **Combined review:** pass with one major finding and seven minor ones, all to be fixed before merge:
  - the retire dialog and Save keep focus after a refusal (no `disabled` on the focused button; focus the alert);
  - a missing picklist value is announced;
  - the full-object state also uses `definitionsPerObject`, with no "retire to make room" advice when retired fields
    fill the 500;
  - a slow reload keeps the panel mounted;
  - edits compare trimmed values on both sides;
  - the form closes or reloads when its field is retired, and tab switches are guarded while a form is open or saving;
  - stricter client schemas (closed configs, positive limits, `Object.hasOwn` for detail labels);
  - parse instead of casting the type select.
- **Noted:** `listCustomFields` is unpaginated (500 definitions at most). If the admin transport ever uses cookies,
  bodyless POSTs need a CSRF control; today it uses a bearer token.

### D-L146 — import, dedupe and notification task files; gap rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). Task files T-0092 to T-0101 are written from ADR-0017, ADR-0018, D-L128, D-P12, D-P27,
D-P28 and D-P29.
- **Raw import files (ADR-0017 "sweeper", D-L128 Q5).** A delayed BullMQ job per import deletes the raw file 7 days after
  the job ends (24 hours after an abandoned upload), running as the initiating user (ADR-0018 Q2's identity rule). A bucket
  lifecycle rule backs it up: object tag `kasuwa-purpose=import`, expire at 8 days, and abort incomplete multipart uploads
  at 1 day. This way erasure never depends on the user still existing. A `head` 404 reconciles `stored_object` to
  `deleted`. No new role.
- **The D-P27 30-day hard delete and snapshot purge is deferred** to one follow-up task with its own identity ruling.
  `kasuwa_sweeper` is confined to the auth tables (db invariant 8). The purge must ship before the first cell holds
  customer data (D-L65); no populated cell exists today.
- **Duplicate matching** is exact E.164 phone or lower-cased email within one programme, found by a scoped scan (no GIN,
  D-P33). It is held to the T-0084 latency budget at the 120k seed. If that fails, escalate rather than add a table.
- **Two tables are approved under CLAUDE.md section 8:**
  - `contact_merge` (T-0095), on D-P12 and D-P27;
  - `notification` (T-0100), on ADR-0018 point 8 and D-P29.
- **Undo never loosens a compliance field** on the survivor (D-P28).
- **Notification retention:** read notifications are kept 90 days. Their purge joins the deferred purge follow-up.
- **`csv-parse` is justified in T-0094's PR,** where it is used, not T-0092's.
- **Scope cuts accepted:**
  - in-app notifications only (D-P29);
  - no dry run, preview or bad-rows download (D-L128 Q6);
  - mapping reuse through `fromImportId`, with no template table;
  - contacts-only import;
  - pairwise, contacts-only merge, with the merges history as the Phase 2 recycle bin;
  - exact matching only;
  - no `presignDownload` until the export centre.
  - The per-contact import links (`contact.import_job_id`, `importId` filter) stay.
- **The P28 design is overruled where it conflicts:**
  - 4 upload parts within 25 MiB;
  - most restrictive compliance wins (D-P28), not most recent;
  - no name-plus-date-of-birth matching (D-P12);
  - no bad-rows download;
  - 25 MiB, not 100 MB.
- **Order:**
  - Step 0: one lead registry PR (flags `crm_import`, `crm_duplicates`, `crm_notifications`, the `run-e2e.mjs` flags
    line, the `contact.import` right, the nav entries);
  - wave 1: T-0092, T-0093, T-0098;
  - wave 2: T-0094, T-0099, T-0096, T-0095;
  - wave 3: T-0100, T-0097, T-0101.
  - Migration numbers are assigned in merge order, from 0040.

### D-L147 — Demo tooling merged; the web app has no browser session (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **The gap.** The demo walkthrough found that, after a real sign-in and MFA, the web app keeps the session token nowhere
  (no cookie, no BFF). Every API call from a real browser is unauthenticated. The e2e suites inject stub identity
  headers, so no suite caught it.
  - It is a P0 product gap, filed as **T-0125**, with an ADR first: BFF or API cookie, CSRF, refresh, sign-out, CSP.
- **Demo tooling (#142) is dev-only:**
  - `pnpm demo`;
  - a loopback-only demo proxy that keeps the post-MFA token in an HttpOnly cookie and forwards it as Bearer;
  - an idempotent, loopback-only demo seed through the real API, with synthetic data;
  - smoke and TOTP helpers;
  - the runbook `docs/demo/DEMO.md`.
- **A markup-only RTL fix:** phone numbers render left-to-right inside Arabic layouts.
- **Known demo limitations:**
  - agents can read the admin console (writes are gated; known since T-0032, D-L48);
  - Home, Inbox, Tickets and Reports are nav placeholders;
  - Arabic is reached through `?locale=ar`;
  - low-bandwidth mode has no visible effect yet;
  - the contacts list shows "Assigned" and "Linked" rather than names for owner and account.

### D-L148 — T-0093 suite rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suite is on `lead/T-0093-acceptance` (8c9e728): 124 tests, R1–R21 in its header.
- **Import compliance (D-P28).** An import creates new contacts only, because duplicates are skipped. So a cell may hold
  a restrictive value or the new-contact default:
  - `dnd`: true or false;
  - `consentState`: withdrawn or unknown;
  - `whatsappOptIn`: false.

  A granting value (`whatsappOptIn` true, `consentState` pending or opted_in) is `consent_grant_refused`.
- **Duplicates** are read at `GET /api/v1/programmes/{programmeId}/duplicates`, not through a `programmeId` query
  parameter, which the T-0039 rule refuses (CLAUDE.md 2.2).
- **A merged-away contact** is 404 on every `/contacts` path. `createContactMerge` answers `409 already_merged` only
  when the caller could read the record before the merge.
- **Header erasure.** When the raw file is deleted (7 days after the job ends, or 24 hours for an abandoned upload),
  the import record's `headers` and `filename` are cleared too. A file without a header row would otherwise keep a
  person's data in `headers`. `fromImportId` then fails with `unknown_reference`.
- **New `Error.code` values** in admin.openapi.yaml: `import_status_conflict`, `upload_mismatch`, `already_merged` and
  `undo_expired`.
- **Errors** are capped at 1,000 per import. The limits are published as `x-kasuwa-import-limits`.
- **Minimal lead edits** to the T-0039, T-0081, T-0056 and T-0059 suites admit the new operations.

### D-L149 — ADR-0019 browser session: lead answers to its open questions (lead, 2026-10-18)
**Status:** PROCEEDING (lead). ADR-0019 is **Proposed** and is on @acexode's personal-review list (D-A3: auth). The build
of T-0125 proceeds on these answers unless @acexode objects.
- **The design:** a Next.js catch-all BFF at `apps/web/app/api/v1/[...path]` replaces the `/api/v1` rewrite.
  - It keeps the opaque token in `__Host-kasuwa_session` (HttpOnly, Secure, SameSite=Lax, Path=/).
  - It forwards to the API with Bearer, server-side. The API is unchanged.
  - Every unsafe method needs an exact `Origin` match, `x-requested-with: kasuwa-web` and a JSON-only body.
  - Stub headers are forwarded only by a web process that is itself in stub mode.
- **Answers:**
  1. **Lifetime:** keep the existing 12-hour absolute session, with no idle timeout and no refresh in Phase 2. An idle
     timeout is a later product decision.
  2. **SameSite=Lax,** so links from email and WhatsApp land signed in. The custom header plus the Origin check cover
     CSRF.
  3. **The demo quick-switch** is dropped with the proxy. A client that omits `Origin` on POST is refused, which fails
     closed. Opera Mini and old WebViews are noted as a test item.
  4. **The web-to-API leg** must use TLS outside dev and test. Plain http is refused at boot (D-L94).
  5. **"Sign out everywhere,"** and revoking other sessions on a factor or password change, are out of scope (a
     follow-up).
  6. **Realtime authentication** gets its own task, before realtime ships to browsers.
  7. **The e2e split:** specs that inject headers run on test and stub web processes. One real-browser journey runs on
     the production process with no headers. Byte budgets keep measuring the processes they measure today.
  8. **The shared stub and scope header constants** live in `@kasuwa/config`.

### D-L150 — T-0092 suite rulings; T-0093 build note (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **T-0092 suite** (`lead/T-0092-acceptance`, a62e3f5; 112 tests against real SeaweedFS 3.80 and Postgres). Its rulings
  R1–R12 are accepted:
  - `fileId` is `stored_object.id`, and the database enforces the key shape;
  - store methods refuse keys they did not mint;
  - `stored_object` has no filename column (the filename lives on the import job and is erased per D-L148);
  - the repository never carries key text;
  - `deleted` is terminal;
  - a URL is issued only for a `pending` row;
  - `webEnv` refuses `S3_ENDPOINT`;
  - `deletePrefix` also aborts in-flight multipart uploads;
  - dev CORS is set by the gateway flag.
- **SeaweedFS facts, pinned:**
  - a signed `content-length` makes the bucket refuse a wrong-size part (403);
  - URLs expire and edited URLs are refused;
  - complete verifies the object with `head` and rejects a short object;
  - SeaweedFS has no per-bucket CORS;
  - it revives aborted uploads from still-live URLs, so only completion verification stops orphan objects in dev;
  - its error XML names the key path, so SDK errors must be wrapped.
- **There is no web CSP today.** ADR-0019's build adds a nonce CSP with `connect-src 'self'`. The storage origin joins it
  when uploads ship (T-0096).
- **T-0093 build:** an erased import's saved `mapping` is cleared together with `headers` and `filename` (D-L148). The
  four new `Error.code` values get `records.error.*` i18n keys in T-0096 and T-0097.

### D-L151 — T-0093 security review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The combined review passed with five major and several minor findings.
- **Import writes are creator-only.** Upload-urls, complete, abort, mapping and run are open only to `createdByUserId`
  (others get `403 not_permitted`). Cancel is open to the creator or a tenant admin. The job runs as `createdByUserId`.
- **`contact.import` is held only by sets that also hold `contact.write`** (admin in Phase 2). Setting another member as
  owner needs the same right as createContact (D-P14, D-L81).
- **Undo never loosens compliance on either contact.** The restored contact takes the more restrictive of its snapshot
  and the survivor's current value (D-P28).
- **The duplicates cursor** carries only a contact id (the lowest id in the last set). Sets are ordered by their lowest
  contact id. The cursor never carries the matched value.
- **Undo** needs the merging user plus `contact.write` now, or a tenant admin. It is all-or-nothing under the undoer's
  current field security.
- **Minors:**
  - `contact.import` and scope are re-checked every batch;
  - `contact.claim_and_set_status` never permits a merge;
  - `listContactMerges` is gated on `contact.write` or tenant admin, and shows ids only after the purge;
  - `listDuplicates` is throttled with 429;
  - completing an upload checks metadata only, and bytes stay untrusted until parsed;
  - signed part URLs are never logged;
  - the import result says duplicates were skipped and no restriction was applied to existing contacts.
- **Later decision:** a restrict-only update path, so that importing a suppression list can apply DND to existing
  contacts.

### D-L152 — T-0121/T-0122 suite rulings; two failures found on main (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suites are on `lead/T-0121-T-0122-acceptance` (69f4229, 6c284d5).
- **T-0121 R1–R3 accepted:**
  - a 413 answers with `code: validation_failed`;
  - the 415s and the corrupt-gzip 400 are in scope and must not echo the client's header;
  - an unmatched path is a 404 with `not_found` and no echo.
- **T-0122:**
  - `pnpm db:reset` is broken on main: a stale hard-coded drop list leaves a database at head half-dropped. Fixing it with
    a catalogue query is in T-0122's scope (the old follow-up near D-L line 1094).
  - The root `db:reset` script still defaults an unset NODE_ENV to development, for local use (D-L103 unchanged).
  - The suite pins that a wrapper never overwrites an explicit NODE_ENV (I8).
- **Found on main by a full isolation run:**
  - `audit-coverage` lacks probes for T-0089's audited custom-field operations;
  - `p01-auth-screens` fails because `apps/web/lib/deal-money.ts` hard-codes a currency symbol.

  Both are being fixed on `lead/main-fixes-audit-currency`.
- **Port collision seen again:** one `script-runs` request got an "Ollama" page. The fix is `lead/e2e-free-ports`, pending
  merge.

### D-L153 — T-0095 suite rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suite is on `lead/T-0095-acceptance` (253c028): 69 contact-merge tests, plus 5 new
database attacks in tenancy/adversarial. Its rulings M1–M16 are accepted, including:
- the column is `merged_by_user_id`;
- kasuwa_app may update only the undo columns, and the snapshot and `undo_until` are immutable;
- a restrictive INSERT policy pins the merger to the session user;
- one audit row per merge or undo, with field names only;
- the default never picks an owner who has left the programme;
- a merged-away contact answers an invented id's 404, byte for byte, on every route;
- undo moves back only the children that still point at the survivor;
- 150 ms latency at 60k contacts per programme.
- **The duplicates cursor (widens D-L151).** The decoded cursor carries the lowest contact id plus the literal
  `phone`/`email` and a version, and never a matched value. Otherwise a pair that matches on both would lose a set at a
  page boundary.
- **Contract additions** in T-0095:
  - `merged` and `restored` in `AuditAction`;
  - `unknown_reference` at `choices.ownerUserId`.
- **Known noise:** the adversarial "no such contact" timing check fails under load on this host (D-L100).

### D-L154 — T-0099 suite rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suite is on `lead/T-0099-acceptance` (276e60a; 78 tests). Its rulings R1–R16 are
accepted, including:
- a contact's notification name follows its name parts (D-L68);
- the actor's name is null once they leave the programme (D-P23);
- items whose object is no longer visible are dropped;
- read-all returns the visible unread count;
- a 30-second polling hint.

Read-all gains an optional `throughId`, so that notifications arriving after the user's view are not marked read unseen.
Per-kind counts and a list-valued `kind` are not in Phase 2. The mock-load guards in records-contract-import and
custom-fields-contract get explicit 60 s timeouts.

### D-L155 — T-0092 review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The migration, tenancy and security reviews passed with findings, none critical.
- **Live-transaction check:** `@kasuwa/db` tracks the transactions it really issued (`assertLiveTenantTx`). Key minting
  and the stored-object repository refuse anything else. Object storage has no RLS, so the mint is the only guard on the
  bytes.
- **`tenantStoragePrefix`** is lint-banned outside a future operator-only, audited offboarding module (the D-L54
  precedent).
- **The storage-adapter package** declares `exports`. Deep imports are banned, and the key builders are not exported.
- **`storageEnv`** requires https endpoints outside dev and test, accepts only the http and https schemes, and brands its
  result; `S3ObjectStore` refuses an unbranded config.
- **0040 hardening:**
  - status is forward-only;
  - `uploaded` requires a verified size equal to the declared size;
  - a deleted row is frozen;
  - `expires_at` cannot be cleared.
- **Other fixes:**
  - adapter caps per purpose (import: 25 MiB, 4 parts);
  - a no-progress guard in `deletePrefix`;
  - lint coverage for `.js`/`.mjs`, `@smithy/*` and the fake store in every runtime package;
  - dev ports bound to 127.0.0.1;
  - `tenancy-reviewed` markers on the repository's SQL.
- **Deferred:**
  - binding the upload id to the row moves to T-0094;
  - bucket versioning and `s3:PutObjectTagging` to T-0005.
- **NDPA:** Pooled data in af-south-1 means Nigerian PII is held in South Africa. That is an existing ADR-0002 and D-L128
  decision, but it needs a transfer assessment with counsel.

### D-L156 — T-0098 suite rulings; an ADR-0018 policy fix (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suites are on `lead/T-0098-acceptance` (ea25c62; 102 tests in the outbox and
outbox-forgery suites).
- **ADR-0018 amendment.** As written, the relay policies refuse the relay's own "mark published" and "mark dead"
  UPDATE: the new row must pass the SELECT policy, with or without RETURNING. Fix: the relay's SELECT policy gains
  `OR published_at = now() OR dead_at = now()`. `now()` is fixed per transaction, so the relay sees only the rows it
  marked in the current transaction. This was proven on a scratch database.
- **Tightened:**
  - the relay's UPDATE WITH CHECK requires `published_at = now()` and `dead_at = now()`, so nothing can be back-dated
    into retention;
  - kasuwa_app's INSERT is column-limited, so it cannot choose `seq`.
- **Accepted:**
  - R1: 5 consumer attempts in all;
  - R2: `relayOutboxBatch`, `sweepOutbox` and `consumeOutboxJob` in `@kasuwa/db`, with BullMQ bound in apps/worker;
  - R3: the relay re-parses each payload and skips bad rows without blocking the batch;
  - R4: `appendOutboxEvent` refuses before any SQL;
  - R5: drop reasons are returned;
  - F-R1: the consumer's re-read also matches the actor and tenant;
  - **F-R3:** a restrictive INSERT policy pins `actor_user_id = app.current_user_id()`, so no event can name another
    actor.
- **Lead edits to merged suites** for the sixth role and the required `DATABASE_RELAY_URL`: test-admin-absent,
  auth-role, auth-retention and config-schemas.
- **`DATABASE_RELAY_URL` never goes into the shared `.env`,** because the API and migrator refuse it by presence. The dev
  tooling passes it to the worker only.
- **For T-0100:** the consumer re-reads the aggregate within the event's programme.

### D-L157 — T-0099 review rulings; T-0121 review (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **T-0099** (merged as #144). The combined review passed with two major findings, both fixed in the contract:
  - the unread count examines at most the 500 newest unread notifications and may undercount past that, so its work is
    bounded;
  - a nonexistent, another user's or another tenant's cursor all give the same empty page with `nextCursor: null`.
- **T-0099 minor fixes:**
  - a PATCH 404 changes nothing;
  - `Retry-After` is required on the notifications and duplicates 429s;
  - display names are user text, rendered as text only.
- **For T-0100:**
  - the notification RLS restricts reads to `recipient_user_id = app.current_user_id()`;
  - the outbox consumer checks, as the recipient, that they can read the object, and skips the notification if not;
  - the drop rule reuses each object's own read path, so merged-away contacts are dropped;
  - the throttle allows for several visible windows.
- **T-0121.** The combined review passed with three minor findings:
  - the body-parser error handler now also requires `expose`;
  - the middleware names are pinned;
  - route-existence probing (a 401 versus a 404) predates this change, and the routes are public in the specs, so it is
    accepted.

### D-L158 — T-0092 merged with two accepted exceptions (lead, 2026-10-18)
**Status:** PROCEEDING (lead). T-0092 is merged as #145 (migration 0040).
- **`StoredObjectRepository.get` does not call `assertLiveTenantTx`.** The suite's R7 hand-builds a narrowed tx around a
  real one. `get` is a read on the caller's own connection under RLS and explicit session filters, so a forged session
  can only narrow visibility, never widen it. Key minting and every write do check.
- **The DB CHECK `status <> 'uploaded' OR verified_size_bytes = declared_size_bytes`** waits for a follow-up migration
  with a suite edit (the suite's control moves an unverified row to `uploaded`). The repository always writes the
  verified size with `uploaded`.
- **The 0040 status rules bind every role, the migrator included.** Only key corrections keep the D-L76 migrator
  exemption.
- **A presign on a row with an open upload** aborts the old upload first.

### D-L159 — T-0091 review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The combined review of `agent11/T-0091-custom-values` passed with 2 major, 3 medium and 8
minor findings. All are to be fixed before merge.
- **Majors:**
  - a number entry treats a comma as a decimal only when the page locale's decimal is a comma; grouping is
    `invalid_value`, because "1,000" was silently saved as 1;
  - the builder had reworded the studio client so a guard missed it. That is reverted, and the guard is narrowed to the
    record side by a lead edit. Never work around a guard (CLAUDE.md 8).
- **Mediums:**
  - a key missing from the draft is untouched, never "clear", and drafts are filled in the first render;
  - lazy regions get error boundaries, so a failed chunk never takes a record screen down (the C9 spirit);
  - only changed keys are validated, text length counts code points, and numbers count only significant digits.
- **Minors:**
  - read-only keys persist for the screen;
  - a locked key's draft resets to the saved value;
  - `unknown_field` re-reads the definitions;
  - `currencyCode` is limited to NGN, GHS, KES and ZAR, with minor digits taken from Intl;
  - impossible dates show as empty;
  - writes get their own `field_withheld` copy;
  - no `as unknown as` cast;
  - `data-record-text` on tenant labels.
- **Lead edit:** search-mock answers `listCustomFields` with an empty list, and is re-pinned.

### D-L160 — T-0094 suite rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The suites are on `lead/T-0094-acceptance` (490bb87): import-api has 62 tests and
import-isolation has 20. Interfaces A–F and rulings R1–R16 and I1–I6 are accepted. These include:
- a part plan of min(4, ceil(size / 5 MiB));
- resume keeps the same multipart upload;
- the upload id is stored and never returned;
- reads need `contact.import` (404 without it);
- batches of at most 1,000 rows, sequential;
- no spelling of a grant ever grants;
- every created contact is audited with the creator as actor;
- field security is re-checked at run time;
- duplicates are checked within the programme and against earlier rows of the same file;
- trunk-0 phone normalisation for NG, GH, KE and ZA.
- **Losing scope.** A trigger on `user_programme` deletion (the 0031 pattern) marks that creator's queued, running and
  awaiting imports in that programme `failed`, and clears `headers`, `filename` and `mapping`. Erasure therefore never
  depends on the creator's scope.
- **Retention also starts at upload completion** (7 days). It reschedules if the job is still running. An import left
  in `awaiting_mapping` becomes `expired`, with its data cleared.
- **Contract defect.** `ImportRowError.row` max becomes 100002, so it can hold the `too_many_rows` row. Fixed in T-0094.
- **Duplicate matching** uses only phone and email fields the importer can read in that programme. Import is admin-only
  (D-L151), so the residual risk is accepted.
- **T-0093 R1** flips to implemented in a lead edit.
- **Builder notes:**
  - share the contact audit writer through a domain package, so the worker uses the same code path;
  - a follow-up migration adds `UNIQUE (tenant_id, programme_id, id)` on `stored_object` for the composite FK.
- **The two long-running tests** (100,000 rows) are routed to the Windows verification runner.

### D-L161 — T-0098 review rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The migration, security and tenancy reviews passed with findings, none critical.
- **0041, edited before merge:**
  - the aggregate ordering key includes `tenant_id`, so one tenant cannot stall another tenant's events with a poison row;
  - autovacuum is tuned for the queue's churn;
  - the rollback comment is corrected;
  - `kasuwa_relay` gets CONNECTION LIMIT 4;
  - the self-check also asserts the identity-sequence revoke and exactly two SECURITY DEFINER functions.
- **Code:**
  - uuids are lowercased in append input and payload schemas (an uppercase id made events go dead silently);
  - one queue per aggregate type, asserted in the registry;
  - the drop reasons `not_visible` and `forged` are distinguished;
  - the consumer helper is bound to its queue;
  - `addBulk` has a 10 s timeout, so a Redis outage uses the backoff;
  - the backlog query uses the seq index.
- **Producer contract** (T-0100 onward):
  - append after taking the aggregate's row lock, because `seq` is assigned at insert;
  - generate event ids with `randomUUID()`;
  - handlers are idempotent on (source_event_id, recipient).
- **Accepted as built:**
  - no FK on `actor_user_id` (F-R3 plus consumer re-resolution);
  - the `last_attempt_at` tightening;
  - the claim query's deviation from the ADR's literal NOT EXISTS;
  - the publish backoff;
  - bad rows counted as attempts;
  - the relay's control of `attempts` (inside ADR-0018's blast radius).
- **Before T-0100 ships a consumer:** an NDPA note is needed on BullMQ's failed set keeping identifiers indefinitely
  (D-L128 Q5).
- **T-0098 is on @acexode's personal-review list (D-A3):** a new LOGIN role, RLS and a migration.

### D-L162 — T-0095 build rulings (lead, 2026-10-18)
**Status:** PROCEEDING (lead). The build on `agent3/T-0095-merge-api` passes 60 of 62 contact-merge tests, plus the
tenancy folder, the record API suites, integration and unit.
- **M8 latency** measured 485–525 ms against 150 ms, on a host with load average 11–16. It is re-measured on the quiet
  Windows runner. If it is still over, `SET LOCAL work_mem` (bounded at 64 MB) is allowed for that one statement. No new
  table without escalation (D-L146).
- **The "does not stop offboarding" test is wrong:** audit_event's programme FK predates this. A lead edit deletes
  through the tenant, or plants the merge row directly.
- **records-contract-import:** the five duplicates and merge operations flip to implemented, by lead edit.
- **Hiding merged contacts on reads is application-layer only.** Every read path has the repository predicate, and the
  database guards writes with triggers. A database read layer needs a new `app.*` setting or a third SECURITY DEFINER
  function, both of which need an ADR (CLAUDE.md 2.7). Accepted for Phase 2; a follow-up ADR covers it.
- **Accepted:**
  - the duplicates cursor carries an integer ordinal, never a matched value;
  - choosing `survivor` for a non-editable field is 403;
  - the audit change list caps at 64 field names.
- **Before `crm_duplicates` is shown:** the web audit screen and its labels learn `merged` and `restored` (Agent 11,
  with T-0097).
- **Process:** the session usage limit hit twice today with about 10 agents running. Fewer parallel agents from here.

### D-L163 — T-0095 review rulings; T-0091 merged (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **T-0091 is merged (#148). The custom-fields slice (T-0088 to T-0091) is complete.**
- **Migration numbers in merge order:** T-0094 is 0042 and T-0095 is 0043.
- **T-0095 reviews** (migration, security, tenancy) passed with findings, none critical. All are to be fixed:
  - **The child guard locks the contact `FOR SHARE` before judging it.** This closes the race where an activity or deal
    created during a merge pointed at the merged-away contact.
  - **Restrictive policies:** INSERT pins `created_at = now()` and `undone_at IS NULL`, so the undo window and the PII
    snapshot cannot be stretched; UPDATE requires an open window and `undone_at = now()`.
  - The freeze trigger's exempt columns come from the catalogue.
  - The REVOKE lists follow main's convention.
  - The self-check is complete.
  - The merges index includes `programme_id`.
  - `deleted_at IS NULL` is added to the deal, board-card and my-activities name reads.
  - Merge and undo audit custom fields by their bare key (the 64-character limit).
  - **The duplicates throttle drops to 20 per minute per user, with at most 2 concurrent scans per tenant,** because
    each page is a full programme scan.
  - A merged-away id, or an undo, is 404 for callers without `contact.write`.
  - The ordinal cap is tied to the phone and email caps.
  - Service decisions are unit-tested as pure functions.
- **Gates:**
  - the snapshot purge and erasure path must cover `contact_merge.snapshot` before the first populated cell;
  - after merges exist there is no safe schema rollback: recovery is forward-only (flag off, undo through the API);
  - T-0100 publishes the owner-changed event when a merge or undo changes the owner.

### D-L164 — T-0100 suite rulings; T-0121 and T-0122 merged (lead, 2026-10-18)
**Status:** PROCEEDING (lead).
- **T-0121 merged (#149)** on the Windows verification runner's evidence: ten suites, including tenancy 151, with 0
  failures. **T-0122 merged (#150).**
- **The T-0100 suite** is on `lead/T-0100-acceptance` (18a330f): notifications-api has 69 tests, and outbox-forgery
  section 5 adds 14. Rulings N-R1 to N-R9 are accepted:
  - write a notification only if the aggregate's current owner, re-read inside the event's programme, equals the
    payload's `newOwnerId`;
  - never notify the actor, anyone on an owner clear (D-P23), a non-member, or a recipient who cannot read the object;
  - **no notification when `owner_user_id` is withheld from the recipient**, because it would reveal the owner;
  - creating a record owned by someone else counts as an assignment;
  - a restrictive INSERT binds the actor;
  - the unread count examines the 500 newest;
  - the PATCH 404 is byte-identical to getContact's;
  - a per-user, per-operation throttle;
  - the worker consumes end to end.
- **Task-file correction:** `INSERT … ON CONFLICT DO NOTHING` is refused (42501) under the recipient-only restrictive
  SELECT policy, because ON CONFLICT needs SELECT rights. Idempotency is a plain INSERT in a SAVEPOINT, treating 23505 on
  (source_event_id, recipient_user_id) as already delivered. Actors must not be able to read notification rows.
- **Not pinned yet:** `import.finished` waits for T-0094, and merged-away contact drops wait for T-0095.
- **Order:** the T-0100 build waits for T-0095 to merge, because both change the contact, account and deal services.
