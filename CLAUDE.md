# CLAUDE.md — Kasuwa

Read this before touching anything. It is the contract every agent works under.

---

## 1. What Kasuwa is

Kasuwa is an Africa-first, multi-tenant CRM **and** customer-engagement cloud for
Nigerian and African BPOs, financial services, telcos, B2B mid-market and
WhatsApp-run SMEs. The wedge no incumbent offers natively: WhatsApp/USSD-first
channels, local-currency money and tax (NGN/GHS/KES/ZAR, VAT, NRS MBS
e-invoicing, Paystack/Flutterwave/M-Pesa/MoMo), NDPA/NCC/DND compliance, and BPO
multi-client isolation — priced in local currency.

Architecture: a TypeScript **modular monolith** (ADR-0001) with separately
deployed API, worker and realtime processes, on PostgreSQL 16 with row-level
security, Redis/BullMQ, OpenSearch and S3-compatible storage.

**Telephony and WFM already exist and are not ours to build** (ADR-0003). We
integrate through `packages/telephony-adapter` and `packages/wfm-adapter`. If
you find yourself writing dialer pacing, SIP, media handling or shift
optimisation, stop — you are outside scope.

### Glossary

| Term | Meaning |
|---|---|
| **Tenant** | A customer organisation. The top of the hierarchy. |
| **Business unit** | A division within a tenant. |
| **Programme** | A BPO client engagement (e.g. "Bank X Collections"). The isolation boundary *inside* a tenant. Non-BPO tenants have one default programme. |
| **Team / user** | The rest of the hierarchy. A user may belong to many programmes. |
| **Disposition** | The outcome code an agent records after an interaction. |
| **DND** | Nigeria's Do-Not-Disturb register (NCC). Promotional traffic to a DND number is illegal. |
| **MBS** | The NRS/FIRS e-invoicing clearance system (Nigeria). |
| **WABA** | WhatsApp Business Account. |
| **24-hour window** | The period after a customer message during which WhatsApp allows free-form replies. Outside it, only approved templates. |
| **Cell** | A full deployment (API, workers, DB, Redis, search, storage). Pooled tenants share `za-1`; Silo tenants get their own. |
| **Pooled / Bridge / Silo** | The three isolation tiers (ADR-0002). |

---

## 2. Architecture rules

These are not style preferences. Breaking one is a defect, not a debate.

1. **Never bypass the tenant repository.** Every query touching tenant data runs
   inside `withTenantTransaction` (`packages/db/src/session.ts`). There is no
   unscoped pool, no "admin" connection, no escape hatch. A query outside a
   tenant transaction throws `NoTenantContextError`.

2. **The session decides scope; the caller never does.** A request says *who* it
   is. The database says *what they can reach*, by reading `user_programme`. Any
   code path where a client supplies its own `programmeIds` is a security bug.
   The stub auth guard actively rejects requests carrying scope headers.

3. **RLS is the last line, not the only line.** Repositories also filter on
   `tenant_id` and `programme_id` explicitly. Two independent layers; a typo in
   one does not leak.

4. **Every table has `tenant_id`, RLS `ENABLED` *and* `FORCED`, and at least one
   policy with a `WITH CHECK` identical to its `USING`.** `FORCE` matters: without
   it the table owner silently bypasses its own policies. This is asserted in
   `tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts`.

5. **Module boundaries are enforced by lint.** `packages/domain/*` may depend on
   `scope:shared` (db, permissions, metadata-engine, config, i18n) and
   `scope:adapter`, and never on another domain's internals. Cross-domain
   collaboration goes through published interfaces or events. `pnpm
   lint:boundaries:verify` proves the rule is live.

6. **Events go through the outbox**, never a direct call from one domain into
   another. (Outbox is not built yet; do not invent a substitute.)

7. **A `SECURITY DEFINER` function is an ADR, not a convenience.** They are the
   only RLS-free reads in the system. Two exist — `app.resolve_tenant_by_slug`
   and `app.resolve_session` — because sign-in has to find a tenant before it
   has one, and both are narrowly built: `STABLE`, pinned `search_path`,
   `REVOKE ALL FROM PUBLIC` then granted to the serving roles only
   (`kasuwa_app` both; `kasuwa_auth` the slug resolver alone, T-0049), returning
   identifiers and never a business row. **A third needs an ADR before it is
   written.** Each one is a hole in the model that has to be argued for, and
   the argument gets easier to skip every time one already exists.

8. **Adapters are the only place external systems are named.** No module outside
   `packages/telephony-adapter` may reference the telephony platform. Same for
   WFM, payment providers and channel providers when they arrive.

---

## 3. Commands

```bash
pnpm install              # once
pnpm dev                  # containers + migrate + seed + all four apps
pnpm dev:down             # stop containers

pnpm lint                 # eslint across the workspace
pnpm lint:fix
pnpm lint:boundaries:verify   # proves the boundary rule actually fires
pnpm typecheck            # tsc --noEmit per project
pnpm build

pnpm test                 # unit -> integration -> isolation
pnpm test:unit            # fast, no I/O
pnpm test:integration     # real Postgres via Testcontainers
pnpm test:isolation       # the blocking tenancy suite (every PR)
pnpm test:ui-acceptance   # harness-driven UI acceptance suites (full gate only, D-L207)

pnpm test:e2e             # Playwright against a real API, web app and database
                          # (deliberately NOT part of `pnpm test`; it starts a
                          # browser and a container. See tests/e2e/README.md for
                          # how to add a journey and how to set a byte budget.)

pnpm db:migrate           # as kasuwa_migrator
pnpm db:seed              # two tenants, four programmes, five users, twelve contacts
pnpm db:reset             # drop, migrate, seed (localhost only)

pnpm ui:tokens            # regenerate packages/ui/src/tokens.css from tokens.ts
pnpm i18n:pseudo          # generate the en-XA pseudo-locale
```

Docker Desktop with the WSL2 backend is required on Windows; Testcontainers and
`pnpm dev` both need a running Docker daemon.

### Machine resource limits

The current development machine has **16 GB of RAM**, shared with a second
project (the "dialler") and with Docker Desktop's VM (~8 GB). Unbounded test
workers froze it on 2026-10-14. So:

- **Never run with unbounded parallelism.** No full suite, `nx run-many` or
  build without a cap: use `--maxWorkers=2` for vitest (the root
  `vitest.config.ts` defaults to 2) and `--parallel=2` (or 1) for nx.
- **One Docker stack at a time.** Check `docker ps` first. Don't start this
  project's compose stack, or a Testcontainers suite, while the dialler stack is
  running. Run `docker compose down` when you're done.
- **Clean up.** Before a heavy task, check for leftovers
  (`pgrep -fl vitest`, `pgrep -fl next-server`, `pgrep -fl "tsx src/main"`).
  Afterwards, stop everything you started.
- **The post-edit hook is bounded** (`.claude/hooks/post-edit-tests.mjs`): one
  run at a time on the machine, two threads, a 1.5 GB heap cap, and a timeout
  that kills the whole process tree. Don't loosen these to make it faster.

---

## 4. Conventions

- **TypeScript strict everywhere.** `no-explicit-any` is an error, so are
  `no-non-null-assertion` and `no-console`.
- **Zod at every boundary** — HTTP, queue payloads, webhooks, environment. Parse,
  do not cast.
- **Money** only as minor units (`bigint`) plus an ISO currency code. Never a
  float. Never a bare number called `amount`.
- **Dates** in UTC in the database, with explicit IANA timezone conversion at the
  edges. BPO rosters span WAT/EAT/SAST; "the date" is never unambiguous.
- **All user-facing strings via `@kasuwa/i18n`.** A lint rule fails the build on
  literal JSX text in `apps/web`. No hard-coded currency symbols.
- **No colour literals outside `packages/ui`.** Lint-enforced. Use a semantic
  token; never invent a colour or a spacing value.
- **No `process.env` outside `@kasuwa/config`.** Lint-enforced.
- **Migrations are append-only.** Expand → migrate → contract. Editing an applied
  migration is rejected by the runner's checksum.
- **Feature flags** for every user-visible change (`@kasuwa/feature-flags`).
- **Conventional commits.** PRs ≤ ~600 lines or split (Addendum A1 section 3.3;
  this supersedes the founding pack's 400). Structural PRs are exempt — say so in
  the description.
- **No new dependencies** without a one-line justification in the PR description.
- **`pnpm.overrides` pins rollup to its WASM build. This is temporary** (D-L20):
  Windows Smart App Control blocks rollup's native binary, so without it the
  test suite will not run on the current development machine. Remove the pin
  once agents run in the devcontainer or cloud environment. JSON takes no
  comments, which is why this note is here.

---

## 5. Definition of done

A task is done when **all** of these hold:

- [ ] The acceptance tests named in the task file pass, unmodified.
- [ ] Unit tests written for the logic you added; they fail without your change.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`
      and `pnpm test:isolation` all pass locally.
- [ ] **Full gate, not per task (D-L207):** `pnpm test:ui-acceptance` and the
      full `pnpm test:e2e` run nightly on main, on demand, and before a slice or
      the phase closes. A task runs only the UI acceptance file and e2e tags it
      names (`-t`, `--grep`). Byte-budget tags are run before merging any PR
      that changes `apps/web` dependencies or a shared chunk.
- [ ] OpenAPI annotations updated on any new or changed controller.
- [ ] i18n keys added for every new user-facing string.
- [ ] Any migration reviewed by `migration-reviewer` and paired with an RLS
      policy; any new table added to `TENANT_SCOPED_TABLES`.
- [ ] An ADR written if you changed architecture.
- [ ] A completion report in `team/reports/<task-id>.md`: what changed, what was
      hard, what you left out, open questions.
- [ ] Nothing in your change contradicts an open decision in
      `team/DECISIONS.md`. If it would, stop and escalate instead.

**You do not merge your own work.** Open a PR and wait.

---

## 6. Security guardrails

Non-negotiable. A breach of any of these is a stop-the-line defect.

1. **Never log PII, PAN, NIN or BVN.** Not in logs, traces, error messages,
   exception bodies, analytics events or test fixtures. Use `redact()` when it
   exists; until then, do not log the object.
2. **PAN never enters Kasuwa.** Secure payment returns a token and last four
   digits only (ADR-0003, `packages/telephony-adapter`). If you find yourself
   typing a card-number field, stop.
3. **Secrets come from the environment only**, via `@kasuwa/config`. Nothing in
   the repo, ever — secret scanning is in the pipeline.
4. **Errors must not leak existence.** A record outside your scope is `404`, not
   `403`. "Not authenticated" must not distinguish "no such user" from "wrong
   tenant".
5. **Never widen scope to make a test pass.** If a test fails because the caller
   cannot see something, the caller is probably not supposed to see it.
6. **`@kasuwa/testing` must never be imported by application code.** It can forge
   RLS session variables. Lint-enforced.
7. **Audit anything sensitive**: exports, recording playback, permission changes,
   supervisor actions on live calls.

---

## 7. Where to look

| You need | Look at |
|---|---|
| What a module must do | `docs/prd/M<nn>-*.md` — one file per PRD module |
| Why the architecture is as it is | `docs/adr/` |
| Open questions blocking you | `team/DECISIONS.md` — **do not guess; escalate** |
| Answered questions | `team/DECISION-LOG.md` — read before re-asking |
| Who owns what | `team/ROSTER.md` |
| Your task | `team/tasks/T-XXXX-*.md` |
| Design tokens and components | `packages/ui` — never invent colours or spacing |
| The tenancy model in code | `packages/db/src/session.ts`, `packages/db/migrations/` |
| Original source documents | `docs/founding/` (the pack and Addendum A1) |

The addendum wins wherever it conflicts with the founding pack.

---

## 8. When you are stuck

Escalate rather than guess. Specifically:

- If a decision in `team/DECISIONS.md` is marked `BLOCKED` and your task needs
  it, stop and say so in your report. Do not pick an option.
- If an acceptance test looks wrong, say so in your report. **Do not edit it** —
  CI blocks that, and so does a hook.
- If you have burned your task budget, escalate rather than retry. A stuck agent
  that keeps trying is more expensive than one that asks.
- If you need a new dependency, a new table, or a change to an adapter contract,
  that is a decision, not an implementation detail. Raise it.
