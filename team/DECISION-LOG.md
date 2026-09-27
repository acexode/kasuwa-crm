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
