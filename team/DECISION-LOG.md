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
**Answered:** 2026-09-26
**Answer:** None. An AI agent reviews the code and opens the PR against `main`;
@acexode merges once the CI gate passes.

**Consequence:** the review model in `ROSTER.md` and `CODEOWNERS` is written
accordingly. CI is the merge gate, and the isolation suite is its sharpest part.

**Residual risk, recorded because it was raised and overruled — which is the
correct outcome of a recommendation, not a reason to keep arguing:** Addendum A1
section 3.5 names human review of auth/RLS/permissions/payments/recordings PRs
as the specific mitigation for the model's biggest weakness, correlated blind
spots across instances of the same model class. An AI reviewer shares those
blind spots by construction, and CI only catches what someone already thought to
test. Compensating measures taken in the scaffold, none of which fully replace
an independent reviewer:

- the isolation suite attacks the database directly with forged session
  variables, so it does not depend on the application being correct
  (`tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts`);
- a catalogue invariant fails if any table exists without RLS enabled, forced and
  policied, so a forgotten policy cannot pass review by being invisible;
- conventions that used to rely on a reviewer noticing are lint rules instead
  (colour literals, `process.env`, module boundaries, test-harness imports);
- `pnpm lint:boundaries:verify` proves the boundary rule fires, so it cannot rot
  into a decorative config entry.

Two things an AI reviewer will not catch and that remain genuinely open: a
requirement misunderstood consistently by every agent (mitigated only by your
UAT, D-A5), and an external pen test before commercial GA (Addendum 3.5), which
is still recommended and not yet scheduled.

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
