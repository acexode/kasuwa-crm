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

Proceeding rather than stopping, because the stated requirement is met with
margin in both themes and the rest of the import verifies exactly. **If 3.79 was
measured against a specific pairing, say which and I will add it to
`CONTRAST_PAIRS`** — every candidate above still clears 3.0.
