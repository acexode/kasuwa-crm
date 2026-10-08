# ADR-0014 — Phase 2 search runs in Postgres; OpenSearch is deferred

- **Status:** Accepted (D-P30 item 3, answered by @acexode on 2026-10-07). Implemented by T-0084 (indexes) and T-0085/T-0086
  (global search).
- **Date:** 2026-10-08
- **Deciders:** Lead; @acexode (D-P30)

## Context
The founding pack (`docs/founding/kasuwa-main.md`, the stack table) names OpenSearch for global search and duplicate
matching, with per-tenant index aliases filtered by programme. `docker-compose.yml` runs an OpenSearch container, but no code
uses it.

Phase 2 needs three kinds of search:
- name, company, phone and email search on contacts, leads and accounts (the list screens, already served by scanning);
- global search with the command palette (P27, T-0085 to T-0087);
- exact-match duplicate candidates for import (T-0094).

Each read today folds and scans every row in the caller's scope with no index (D-L68, D-L78). That is fine for the seed. It is
not fine for a BPO tenant with hundreds of thousands of contacts.

Putting OpenSearch behind those reads now would mean:
- **Index sync.** Every contact, account and lead write must reach the index: through the outbox (not built, CLAUDE.md 2.6)
  or by dual writes, which the outbox exists to prevent.
- **Field security in a second store.** A withheld field must never be searchable. The record API does this per row,
  per programme, per permission set (D-L64, T-0076's `companyName` rule). An index would have to replicate the matrix, or
  hold only never-withheld fields, which makes it nearly useless.
- **Tenancy in a second store.** The "mandatory query wrapper" filtering tenant and programme is a second isolation layer to
  build, test and keep honest. RLS does not reach it.
- **Erasure.** Data-subject erasure (D-P27) must also reach the index.

## Decision
1. **Phase 2 search runs in Postgres, inside `withTenantTransaction`,** so RLS, explicit tenant and programme filters, and
   per-row field security apply exactly as they do to every other read. Nothing is copied to a second store.
2. **Indexes (T-0084, under D-L65):**
   - `pg_trgm` GIN indexes on the folded name expressions the repositories already search (contact display name and company,
     account name), scoped by `tenant_id`;
   - `jsonb_path_ops` GIN indexes on `contact.phones` and `contact.emails` for exact matches, which import dedupe also uses.
   - `pg_trgm` is a trusted extension, created by the migrator. Its one-line justification goes in T-0084's PR.
3. **Cursors stay id-only** (D-L80). Search results are paged by position, never by a name.
4. **A latency budget** is pinned by T-0084's suite against a seeded large tenant, so a regression is a red test, not a
   surprise.
5. **Global search (T-0086)** fans out over the existing scoped repositories and returns at most three hits per type, with no
   counts (D-P13, D-L87). It adds no search store.

## Consequences
- No second isolation layer, no sync and no index-side erasure in Phase 2.
- Trigram search is good for names and prefixes. It is not a relevance engine: no stemming, synonyms or typo tolerance beyond
  trigram similarity. Conversations and KB search (P08, M12) need those, and they bring OpenSearch back.
- **Revisit when** the inbox or KB lands, or when the T-0084 latency budget can no longer be met in Postgres. That ADR must
  answer the four points in Context: sync through the outbox, field security, tenancy wrapper tests, and erasure.
- `docker-compose.yml` keeps its OpenSearch container for now; nothing connects to it.
