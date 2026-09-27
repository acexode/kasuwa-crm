# STATUS.md — lead's report

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

### What I could NOT verify

**CI has never run.** The repository was empty, so nothing has been pushed
through GitHub Actions. The workflow is written and the commands in it are the
same ones that pass locally, but "CI passes on the first PR" is a prediction
from me, not an observation. The `guard-protected-paths` job in particular has
never executed — it will fire on this PR, which needs the `lead-approved` label.

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

## What I need from you

**Blocking the pilot week:**

- **D-A4** — a monthly token/API budget ceiling. Every task file currently says
  "3 sessions, escalate on 4th" as a placeholder, which is a number I invented.
- **D-A5** — are your supervisors and QA leads available for milestone UAT? If
  not, the honest response is a longer timeline, not the same plan with hope
  attached.
- **D-A1 / D-L18** — 12 or 13 specialists. Cheap to answer; `ROSTER.md` assumes 13.
- **D-A2** — 1-week or 2-week iterations. Related to how often you can answer
  this file.

**Blocking week 2 (agents 3 and 6):**

- **D-T1 through D-T5** and the material in Addendum A1 section 1.4 — API spec,
  event catalogue, auth model, staging environment. The telephony adapter is v0
  and written from your capability table rather than a real spec. Agent 6 cannot
  do meaningful work without this, and **D-T5** (is the platform multi-tenant
  with programme scoping?) is the highest-leverage single answer, because it may
  change the Pooled/Bridge/Silo model in ADR-0002.
- **D-W1** — anything at all about the existing WFM. Nothing has been shared, so
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
