# ADR-0015 — Marking selected search builtins LEAKPROOF so trigram and jsonb indexes work under FORCE RLS

- **Status:** Proposed. This is D-P33's second step. Open questions for @acexode are marked **Q1 to Q6**.
- **Date:** 2026-10-13
- **Deciders:** Lead; @acexode
- **Amends:** ADR-0014 decision 2. Under this ADR, `pg_trgm` is created by the bootstrap superuser, not by the migrator.

## Context
ADR-0014 keeps Phase 2 search in Postgres, inside `withTenantTransaction`, under RLS. T-0084 (migration 0035) shipped only
plain-column B-tree indexes. The trigram and jsonb GIN indexes were deferred because `kasuwa_app` could not use them (D-P33).
`q` still folds and scans every row in scope (D-L68, D-L80). Global search and the command palette (T-0085 to T-0087) need it
indexed.

**Why the index is refused.** Every table is `FORCE`d (CLAUDE.md 2.4), so the policy quals apply to `kasuwa_app` as security
barrier quals. The planner gives the user's own `WHERE` clauses a higher security level than the policy quals. It may run one
of those clauses before the policy quals, and an index condition always runs first, only if the clause is leakproof:
`restriction_is_securely_promotable` reads `RestrictInfo.leakproof`, and `contain_leaked_vars` sets it. The test is that
every function or operator in the clause that has a column reference beneath it must be `proleakproof`. Otherwise
`fold(display_name) % $1` could run on another tenant's row and raise an error carrying that row's value before RLS discards
the row. So the planner keeps the clause as a filter after the policy quals, and the GIN index is never chosen. Two
consequences follow:
- **The check runs on the clause, not the index.** GIN support functions (`gin_extract_value_trgm`,
  `gin_extract_query_trgm`, `gin_trgm_consistent`, `gin_trgm_triconsistent`) are never consulted, so marking them gains
  nothing. Functions applied only to a parameter (`foldForSearch` on the query text, `jsonb_build_array(...)`) do not count.
  What counts is everything on the column side.
- **Today's predicate is unfixable as written.** `contact.repository.ts` searches with
  `strpos(lower(regexp_replace(normalize(coalesce(col,''), NFD), ...)), $q) > 0`. Making that indexable would mean marking
  `lower`, `normalize`, `regexp_replace` and `textpos`, and `regexp_replace` compiles a regular expression. That cannot be
  safe (see the criteria below).

**What is already leakproof in PG16.** 0035's self-check shows that the same-type B-tree operators of `uuid`, `timestamptz`
and `text` are leakproof. We believe that none of the following are, but this comes from catalogue knowledge, not a query
against our image, so it must be confirmed:
- the `pg_trgm` operator functions: `similarity_op` (`%`), `word_similarity_op` (`<%`), `word_similarity_commutator_op`
  (`%>`), the `strict_` variants (`<<%`, `%>>`) and `similarity_dist` (`<->`). The extension script declares none of them
  LEAKPROOF.
- the core `textlike` (`~~`), `texticlike` (`~~*`), `textregexeq` (`~`), `texticregexeq` (`~*`), `jsonb_contains` (`@>`),
  `lower`, `normalize`, `regexp_replace` and `textpos` (`strpos`).

Check it on the pinned image with:
```sql
SELECT o.oprname, format_type(o.oprleft, NULL) AS l, format_type(o.oprright, NULL) AS r,
       p.oid::regprocedure, p.proleakproof
  FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode
 WHERE o.oprname IN ('%','<%','%>','<<%','%>>','~~','~~*','~','~*','@>')
   AND o.oprleft IN ('text'::regtype, 'jsonb'::regtype);
SELECT oid::regprocedure, proleakproof FROM pg_proc
 WHERE proname IN ('lower','normalize','regexp_replace','strpos','textpos','similarity','jsonb_contains');
```

## Decision
1. **Move the folding out of the predicate.** Search reads a stored folded column (for example `display_name_search`,
   `GENERATED ALWAYS AS (<fold>) STORED`), so that only an operator touches a column reference. This shrinks the set to be
   marked from about seven functions to three or four. It is a new column on a hot table under D-L65 (Q1).
2. **Mark exactly these, and nothing else:**
   - `similarity_op(text,text)` (`%`) and `word_similarity_op(text,text)` (`<%`), with
     `word_similarity_commutator_op(text,text)` (`%>`) only if a query writes it that way;
   - `jsonb_contains(jsonb,jsonb)` (`@>`), for exact phone and email matches through `jsonb_path_ops`;
   - `textlike(text,text)` (`~~`) **only if @acexode accepts its residual** (Q2). It is what keeps today's substring
     semantics (`col LIKE '%' || escaped || '%'`) on a trigram index. Without it, search becomes trigram similarity.
3. **Never mark** `texticlike` (unneeded on a folded column), any regex operator, `regexp_replace`, `lower`, `normalize`,
   `textpos`, `similarity()` (not an operator, so not indexable), or any GIN support function.
4. **Review criteria, applied per function and recorded in the PR.** A function is leakproof only if, for every input, it:
   - has no side effects;
   - raises no error, warning or notice whose occurrence or text depends on an argument's value;
   - does not take a code path whose time varies grossly with a value in a way a caller could aim at.

   An out-of-memory error on an absurd input is treated as Postgres core treats it: ignored. Functions that can throw on
   malformed input fail outright, and regex compilation is the canonical case. Per candidate:
   - `similarity_op`, `word_similarity_op`: they compute trigrams of two valid texts and compare them against
     `pg_trgm.similarity_threshold`. We know of no value-dependent error. To confirm in review: `generate_trgm`'s size
     checks and the locale-aware lower-casing.
   - `jsonb_contains`: it compares two already-valid jsonb values. `JsonbDeepContains` calls `check_stack_depth()`, so a
     pathologically nested value could raise "stack depth limit exceeded". That leaks nesting depth, not content. The
     reviewer must decide whether a write-side nesting limit is needed (Q3).
   - `textlike`: it raises "LIKE pattern must not end with escape character" when the *pattern* ends in a backslash. The mark
     is global, so `'x' LIKE contact.display_name` reveals one bit per row: whether a value ends in `\`. PG16 also refuses
     LIKE under a nondeterministic collation, but that depends on the collation, not the value.
5. **Who applies it, and how.** `ALTER FUNCTION ... LEAKPROOF` is superuser-only, and so is the reverse. `kasuwa_migrator` is
   not a superuser (BYPASSRLS, schema owner), so no migration it runs can do this. Lead-owned `packages/db/sql/bootstrap.sql`,
   which already runs as the superuser before any migration, will:
   - `CREATE EXTENSION IF NOT EXISTS pg_trgm`, because the functions must exist before they can be marked;
   - apply the `ALTER FUNCTION ... LEAKPROOF` list idempotently.

   The migration that creates the GIN indexes then *reads* `proleakproof`, as 0035 does, and fails if any mark is missing.
   The migrator never marks or unmarks anything. As the extension's owner, though, it could `ALTER EXTENSION pg_trgm
   UPDATE` or drop the extension, which would remove the marks silently. The self-check and the acceptance test exist to
   catch that.
6. **Durability: assume the mark does not survive.**
   - An extension update whose script runs `CREATE OR REPLACE FUNCTION` on a marked function resets it to `NOT LEAKPROOF`.
   - `pg_dump` never dumps a `pg_catalog` builtin, so the `jsonb_contains` mark is lost on dump and restore, and we believe on
     `pg_upgrade` too.
   - We are unsure whether `pg_upgrade --binary-upgrade` carries an extension member's flag.

   So bootstrap is re-applied after every major upgrade, restore or extension update. The marked set is re-reviewed per
   Postgres major version, because the implementations change. A failure here is never a leak: the query falls back to a
   correct, slow scan, and the tests go red.

## Verification
- **No drift (tenancy folder, so it runs on every PR per D-L111).** As the test-admin login, assert that the set of
  `proleakproof` functions equals the stock PG16 baseline plus exactly the list above. The baseline is captured once from a
  clean container of the pinned image and committed. Assert also that no function belonging to an extension (`pg_depend`
  `deptype = 'e'`) is leakproof except the listed ones. A new mark anywhere is a red test.
- **Index use as kasuwa_app, under FORCE RLS,** inside `withTenantTransaction` on T-0084's 120k/60k seed:
  - `EXPLAIN (FORMAT JSON)` shows a Bitmap Index Scan on each trigram index, with the search clause as its Index Cond, for a
    one-programme agent and an all-programme supervisor;
  - the same holds for `phones @> ...` on the `jsonb_path_ops` index;
  - a negative control: a `strpos` predicate is still a Filter, which proves the mechanism and not luck.
- **Error probes.** Each marked function gets adversarial inputs: huge strings, deep jsonb, a trailing backslash for
  `textlike` if marked, and invalid-looking text. Every call either returns, or raises a message that contains no argument
  text.
- **Unchanged:** the `rls-enforcement`, `adversarial` and isolation suites, and T-0084's `q` result pins, which must still
  pass. Under Decision 2 without `textlike`, the semantic change needs a lead edit to those pins (Q2).

## Consequences
- `q`, global search and import dedupe get indexes. RLS and explicit filters stay intact, and no second store appears.
  T-0085 to T-0087 are unblocked once the marks, the folded columns and the GIN migration land.
- **Risk if a function is wrongly marked.** The planner may run it on any row of any table in the cell before RLS, for every
  role and every future policy, the auth tables included. A value-dependent error or a timing difference then leaks another
  tenant's data. **Blast radius:** the whole cell, every Pooled tenant in `za-1` together. Each Silo cell has its own marks.
  **Mitigations:**
  - the API scrubs errors to a bodiless 500, so the leak needs the injected-SQL attacker of ADR-0010 and D-P16, who can
    already forge the scope GUCs;
  - the incremental harm is therefore small today, but it grows if the GUC hole is ever closed by a proxy.
- **Residual even with correct marks:** a GIN index on a folded column is not tenant-led. A trigram's posting list spans
  tenants, so latency carries a coarse signal of cell-wide match counts. A `btree_gin` `(tenant_id, col)` index narrows this,
  at the cost of a second extension (Q4).
- Queries under three characters produce no trigrams and fall back to a scan. The palette should require at least three.
- **Rollback:** as superuser, `ALTER FUNCTION <f> NOT LEAKPROOF`. Queries return to scans, results do not change, and the
  indexes become dead weight to drop later. It is safe at any time and needs no migration.

## Alternatives considered
- **SECURITY DEFINER search functions.** These would bypass RLS by design and filter inside. CLAUDE.md 2.7 makes each one an
  ADR-level hole. Search would need one per object type, each reimplementing the tenant, programme and field-security filter
  that RLS and the repositories already enforce. Rejected: more holes, larger ones, in the place where a filter bug matters
  most.
- **A per-tenant materialised search table** (an RLS-free table per tenant, or a table with only never-withheld fields). It
  needs sync (the outbox is unbuilt, 2.6), it duplicates field security (D-L64, T-0076) and it adds an erasure path (D-P27).
  It is ADR-0014's objections to OpenSearch, moved into Postgres. A per-tenant table is also a DDL-per-tenant pattern we do
  not have.
- **OpenSearch.** Deferred by ADR-0014 until the inbox or KB lands, for the same four reasons. Unchanged.
- **Stay with scans plus plain-column prefix indexes.** It needs no superuser act. A B-tree on the folded column with
  `col >= $q AND col < $q_next` uses only leakproof text comparisons. But it is prefix-only, not substring, and computing
  `$q_next` is only correct under `C` collation, which needs a `COLLATE "C"` index (Q5). It is a viable fallback if Q6 says
  the marks cannot be applied in production.

## Open questions for @acexode
- **Q1.** Is a stored generated folded column per searched field acceptable, given D-L65 on hot tables? The alternative is
  an app-written column, which can drift from `foldForSearch`. Can `normalize()` be used in a generated column? We believe
  it is IMMUTABLE, but have not checked.
- **Q2.** Mark `textlike` and keep substring search, accepting the one-bit "ends in a backslash" leak? Or move to trigram
  similarity, a behaviour change that needs a lead edit to T-0084's `q` pins?
- **Q3.** Is `jsonb_contains`'s stack-depth error acceptable, or do we first add a nesting limit on `phones` and `emails`?
- **Q4.** Add `btree_gin` for tenant-led GIN indexes (a new extension, with its justification line)?
- **Q5.** For the fallback only: is `COLLATE "C"` acceptable on a folded search column?
- **Q6. Blocking: the deploy target (T-0005) is undecided.** Managed Postgres services generally give no true superuser,
  and we believe RDS's `rds_superuser` cannot set LEAKPROOF. If production is managed, this ADR may be impossible as
  written. Check this before any build work starts.
