# ADR-0021 — Portal identity is a separate table set; invite and session lookup stay off a third `SECURITY DEFINER`

- **Status:** Proposed (T-0178, Phase 3 S2 / B2). Docs only. @acexode reviews (D-A3; CLAUDE.md §2.7).
- **Date:** 2026-10-28
- **Deciders:** Lead; Agent A4 drafted it; @acexode decides B2
- **Source:** `docs/phase3/PLAN.md` S2; brief §11.7; M18 open question 1; D-L52 M18 gates; CLAUDE.md §2.2 and §2.7
- **Amends:** nothing accepted yet. Relates to ADR-0008 (opaque sessions), ADR-0009 (presented-key, no new definer), ADR-0013 (`kasuwa_auth`), ADR-0019 (browser session). Does not change the count of `SECURITY DEFINER` functions.
- **Does not resolve B2 in `team/DECISIONS.md`.** This file proposes the text; @acexode marks B2 answered.

## Context

M18's admin side already exists: `portal_user` (migration 0013, T-0030) holds one invited address per programme, with a hashed invite token. The portal itself — sign-in, a session, multi-programme scope, reads of real data — has not started. Phase 3 S2 (T-0179 onwards) cannot start until the identity model is decided (blocker B2 / brief §11.7).

Three constraints force the decision:

1. **A portal user is an external identity**, not a tenant staff user (M18 open question 1; PRD US-7). Staff scope is resolved from `user_programme` inside every tenant transaction (CLAUDE.md §2.2). Putting an external person on that path mixes permission sets (`client_portal` vs agent/admin), lifetimes (invite tokens, suspension by the BPO's client, not by HR), and blast radius: a bug that joins `"user"` for staff must not quietly admit a portal row.
2. **Sign-in and invite acceptance happen before any tenant session exists.** Staff already solves the first half with `app.resolve_tenant_by_slug` (one of the two existing `SECURITY DEFINER` functions). Invite-token lookup was flagged in D-L52 as needing a *third* definer — and CLAUDE.md §2.7 says a third is an ADR, not a convenience. The standing preference in `docs/phase3/PLAN.md` is to avoid that third function if a `kasuwa_auth`-pool path that is **not** `SECURITY DEFINER` can do the job.
3. **Scope is always the database's answer.** A portal client must never supply `programmeIds` that widen reach. The session says *who*; `portal_programme` (or whatever membership table is chosen) says *what*. The stub auth guard already refuses scope headers; portal routes must keep that shape.

`portal_user` as built is a groundwork row for invitations, not an identity model. It is one programme per row, has no credential, no session, and no multi-programme membership. T-0179 and T-0180 will replace or absorb it; this ADR decides *into what*.

## Decision

### 1. Separate tables: `portal_identity`, `portal_session`, `portal_programme`

**Do not reuse `"user"` / `user_programme` for portal people.**

| Table | Holds | Notes |
|---|---|---|
| `portal_identity` | The external person: tenant, email (unique per tenant, case-insensitive), display name, status, credential linkage | One row per person per tenant. Not a `"user"` row. |
| `portal_session` | Opaque token hash, identity, absolute expiry, revoked_at | Same shape and rules as `auth_session` (ADR-0008): random opaque token, SHA-256 stored, twelve-hour absolute lifetime provisional, re-resolved every request. |
| `portal_programme` | `(tenant_id, portal_identity_id, programme_id)` membership | The *only* source of programme scope for a portal session. Re-read inside every portal tenant transaction, never taken from the client. |

Invitations stay a separate concern (T-0180): either columns on a `portal_invite` table or a hardened evolution of today's `portal_user`. Accepting an invite creates or links a `portal_identity` and inserts `portal_programme` row(s). An identity may hold many programmes; today's one-programme-per-invite row becomes membership, not identity.

**Permissions.** Portal routes run under the existing `client_portal` permission set (and whatever field-security D-P26 requires). Staff routes never resolve scope from `portal_programme`. Portal routes never resolve scope from `user_programme`. The two graphs do not meet.

**Auth role.** Credential and session writes for portal identities live on the `kasuwa_auth` pool (ADR-0013), with the same revoke/grant discipline a new auth table already requires: `kasuwa_app` loses write (and secret read) privileges; migration assertions name every grant. Exact column grants are T-0179's migration, not this ADR.

### 2. Sign-in before a tenant session exists

Portal sign-in mirrors staff sign-in's shape and reuses the existing definer:

1. Caller submits **workspace slug + email + password** (and later MFA).
2. `app.resolve_tenant_by_slug` returns a tenant id or nothing. Unknown slug and bad credentials answer identically (status, body, timing class) — the same oracle rule as staff sign-in (ADR-0009 / D-P3).
3. On the **auth pool**, inside a tenant transaction for that id: look up `portal_identity` by email, verify the credential, enforce MFA, insert `portal_session`, return an opaque token.
4. Subsequent requests carry that token (Bearer for non-browser; HttpOnly cookie via the BFF for browsers — ADR-0019's transport, a portal cookie name if the BFF must distinguish, decided in T-0179 / T-0184). The API resolves *who*, then opens a tenant transaction and reads `portal_programme` for *what*.

No new `SECURITY DEFINER` function is introduced for sign-in. The slug resolver already exists because "find a tenant before you have one" is the problem it was built for.

### 3. Invite-token lookup: argue hard against a third `SECURITY DEFINER`

D-L52 recorded that "the token lookup before any session exists needs a third SECURITY DEFINER". That sentence assumed the invite URL carried only the token. It does not have to.

**Preferred: tenant slug in the path, token in a fragment or POST body — same pattern as webhook tenant resolution (PLAN §3 / D-L205 #2).**

1. Accept URL shape: `/portal/invite/<tenantSlug>` with the token in a **URL fragment** or exchanged by **POST**, never a query string (D-L52).
2. Resolve the slug with the **existing** `app.resolve_tenant_by_slug`.
3. Open a tenant (auth-pool) transaction. Look up the invite by `sha256(token)` under RLS with explicit `tenant_id` predicates.
4. Unknown slug, unknown token, expired token, already-accepted invite: **one identical response**. No enumeration of which tenants have pending invites.

That is a function the auth module runs on the `kasuwa_auth` pool. It is ordinary SQL under RLS. It is **not** `SECURITY DEFINER`. The census stays at two.

**Why this is enough.** A token is a CSPRNG secret; binding it to a slug does not weaken it. The slug is already public at sign-in. Carrying it on the invite link is the same public fact the invitee will type on the next screen. The webhook path already established that "no tenant context yet" is solved by a slug in the URL plus the existing definer, not by minting a new one.

**Rejected: a third definer `app.resolve_portal_invite(token_hash)`.** It would return identifiers only, be `STABLE`, pin `search_path`, and be granted narrowly — the same shape as the two that exist. It is still a new RLS-free hole. CLAUDE.md §2.7 exists because each additional definer makes the next one easier to rubber-stamp. Invite lookup does not need one once the URL carries the slug. **Do not add it.**

**Also rejected: looking up by token alone through a new non-tenant-scoped directory table.** That would grow `NON_TENANT_SCOPED_TABLES` (ADR-0009: a second entry needs an ADR of its own) for a problem the slug already solves. Keep that list at one.

### 4. Portal session resolution without a third definer

After sign-in the caller has only an opaque token — the same situation that forced `app.resolve_session` for staff. Extending that definer to join `portal_session` would couple two identity graphs inside the system's most sensitive function. A new `app.resolve_portal_session` would be the third definer this ADR exists to avoid.

**Preferred: a presented-token SELECT policy on `portal_session`, plus a non-definer GUC accessor** (the ADR-0009 amendment pattern).

- `app.current_portal_session_token()` reads a transaction-local GUC and returns NULL when unset. **Not** `SECURITY DEFINER`; touches no table. Same shape as `app.current_rate_limit_key()`.
- A SELECT policy on `portal_session` admits the row whose `token_hash` equals the presented value (AND the usual tenant isolation policy remains for in-session work; Postgres ORs policies).
- The auth (or app) repository presents the hash, selects identifiers only (`session_id`, `tenant_id`, `portal_identity_id`), then opens `withTenantTransaction` and **re-reads** the session row under RLS with explicit tenant and identity predicates — two layers, as ADR-0008 requires for staff.
- Presenting a hash confines and cannot widen (CLAUDE.md §2.2): knowing the hash is knowing the token's digest; anyone who has the token can already act as that session.

**Fallback, only if the presented-token policy is rejected in review:** a narrowly built third definer `app.resolve_portal_session(p_token_hash bytea)` returning identifiers only, granted to the serving role(s) that need it, never to PUBLIC, still `STABLE` with pinned `search_path`. That fallback needs @acexode's explicit say and an amendment to this ADR before it is written. It is not the default.

### 5. Scope always from the database

Non-negotiable, restated for portal so T-0179 cannot "optimise" it away:

- `portal_programme` is read inside the portal tenant transaction on every request.
- Removing a membership takes effect on the next request (and on the next realtime revalidation, when portal sockets exist).
- Request bodies, query strings, path segments and headers that name a programme **filter within** the resolved set; an id outside it is the same `404` as an id that does not exist (CLAUDE.md §6.4). Never `403` for cross-programme probes.
- No `programmeIds` claim in the token. No client-supplied scope list trusted as authority.
- Portal routes refuse the same scope headers staff routes refuse.

## Consequences

**For T-0179 (portal identity and session).** Migration ~0052 creates `portal_identity`, `portal_session`, `portal_programme` (all tenant-scoped, RLS ENABLED and FORCED, WITH CHECK = USING, listed in `TENANT_SCOPED_TABLES`). Auth-pool grants follow ADR-0013. Contract: `portal.openapi.yaml` with `portalSignIn`, `portalVerifyMfa`, `portalMe`. Acceptance: `portal-auth.acceptance.test.ts`. Feature flag `client_portal`. No third `SECURITY DEFINER`; the migration's census assertion stays at two. Session resolve uses the presented-token policy unless this ADR is amended.

**For T-0180 (invitations hardened).** Evolve or replace `portal_user`: authorisation on who may invite, audit per invite, token in fragment or POST, outbox send, per-address rate limit, paginated list (D-L52 / D-P26 / D-L115). Accept path: slug in URL + token lookup under tenant transaction. Do not introduce `app.resolve_portal_invite`.

**For T-0181–T-0183 (reads, branding, isolation).** Reads join only programmes in `portal_programme` for the resolved identity. T-0183's adversarial suite attacks every record route with other programmes' and tenants' ids, and the reverse (portal token against staff routes and staff token against portal routes). `TENANT_SCOPED_TABLES` gains the new portal tables.

**For T-0184 (screens) and S6 (portal P1).** White-label shell and programme selector list only entitled programmes from `portalMe` / `listPortalProgrammes`. P1 statements and script approvals inherit the same scope rule.

**For B2.** Proposed resolution text for @acexode (do **not** paste into `DECISIONS.md` until accepted):

> **B2 — Portal identity model: ANSWERED by ADR-0021.** Portal people are `portal_identity` + `portal_session` + `portal_programme`, not `"user"` / `user_programme`. Sign-in and invite acceptance resolve the tenant with the existing `app.resolve_tenant_by_slug`; invite URLs carry the tenant slug and the token in a fragment or POST. Portal session resolve uses a presented-token SELECT policy (non-definer GUC accessor). **No third `SECURITY DEFINER` function.** Scope is always read from `portal_programme` inside the tenant transaction. Unblocks T-0179 onwards.

**Good.** External and staff identity graphs stay apart; the definer census stays at two; invite and webhook resolution share one pattern; CLAUDE.md §2.2 holds for a new class of actor.

**Bad / watch.**
- Two session tables means two resolve paths and two cookie/Bearer stories until the BFF learns a portal cookie name (or a shared cookie with a kind discovered only after resolve — decide in T-0179, prefer separate names so a staff session cannot be presented to a portal guard by accident).
- `portal_user` (0013) becomes transitional. T-0180 must migrate outstanding invites without logging emails or tokens.
- The presented-token policy is a second SELECT path on `portal_session`. The acceptance suite must prove that without the GUC, and with a wrong hash, the table yields nothing; and that presenting a hash never returns another row's data.
- Realtime for portal (if ever) must resolve through the portal path, not `user_programme` (ADR-0020 is staff-shaped today).

## Alternatives rejected

- **Reuse `"user"` + `user_programme` with a `client_portal` permission set only.** Rejected. Isolation is the point of M18. One shared membership table means one mistaken join, one shared session resolver, and one place a portal credential write meets staff MFA tables. Retrofitting a split later is the expensive outcome M18's open question warned about.
- **Reuse `user_programme` but keep a separate `portal_identity`.** Rejected as half a measure: scope resolution would still share the staff primitive (`withTenantTransaction` today reads `user_programme` only), so the session layer would need a fork anyway. Prefer an honest fork: portal transactions read `portal_programme`.
- **Third `SECURITY DEFINER` for invite lookup.** Rejected; see Decision 3.
- **Third `SECURITY DEFINER` for portal session resolve as the default.** Rejected; see Decision 4. Kept only as an explicit fallback amendment.
- **Put portal sessions into `auth_session` with a kind discriminant.** Rejected. `app.resolve_session` joins `"user"` and encodes staff revocation rules. Widening it to portal identities couples the graphs inside the definer and forces `"user"` rows for external people — which is the reuse option under another name.
- **Trust `programmeIds` from the client or the token to skip the membership read.** Rejected; restates ADR-0008's rejected alternative and breaks CLAUDE.md §2.2.

## Open questions for @acexode

1. **Accept Decision 1–5 as the B2 answer?** In particular: separate tables; no third definer; invite URL carries the tenant slug.
2. **Presented-token policy vs fallback definer for portal session resolve.** Default is the policy. Say if you prefer the third definer up front.
3. **Cookie name.** Separate `__Host-kasuwa_portal_session` vs one cookie and a post-resolve kind. Recommendation: separate names.
4. **MFA.** Same TOTP/backup-code path as staff (ADR-0011), or a portal-lighter factor for P0? Recommendation: same factors, separate factor rows keyed by `portal_identity_id` (not `user_id`), so staff MFA tables stay staff-only.
5. **Fate of `portal_user`.** Absorb into `portal_invite` in 0053 (T-0180), or keep the table name and add identity linkage? Recommendation: new `portal_invite` + migrate, so the old one-programme-as-identity shape does not linger.
6. **SSO (US-7).** Out of S2 P0 per PLAN; confirm it does not change the table set (an SSO subject still lands on `portal_identity`).

## Deliberately not decided here

Refunds, MBS, FX, messaging provider, designs P23 — other Phase 3 blockers. Portal read redaction detail beyond restating D-P26. Exact OpenAPI paths and status codes (the contract PR). Migration number final assignment (merge order).
