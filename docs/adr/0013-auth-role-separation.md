# ADR-0013 — A separate `kasuwa_auth` role is the only writer of the auth tables

- **Status:** Proposed (T-0049, D-P16 answered 2026-10-04); @acexode reviews (D-A3)
- **Date:** 2026-10-06
- **Deciders:** Lead; Agent 1 drafted it; @acexode reviews (D-A3)
- **Amends:** ADR-0002 (one runtime role) and ADR-0008 (sessions written by the app role)
- **Reviews:** security, tenancy and migration reviews of T-0049 found no blockers. Their required changes are folded in below.

## Context

Until now every statement the API ran was `kasuwa_app`. The database therefore could not tell the
auth module from any other code. The policies on the auth tables are tenant-only and `FOR ALL`, or
for `auth_rate_limit`, presented-key. Given SQL on `kasuwa_app` inside a tenant (an injection, or an
app bug), an attacker could:

- insert an `auth_session` for the tenant admin, which `app.resolve_session` then honours: a
  session with no password and no MFA;
- overwrite `user_credential.password_hash`;
- delete the admin's MFA factors and backup codes;
- give a backdoor `"user"` a credential;
- un-revoke or extend a session;
- reset the TOTP replay watermark;
- plant a confirmed factor;
- revive a used backup code;
- reset a challenge's wrong-code counter;
- delete another user's MFA lockout row. The key is a hash of tenant and user ids, so it can be
  computed and presented. The T-0049 reviews found this.

That is not a cross-tenant leak. It needs the same attacker as the ADR-0010 residual, who can
already forge `app.user_id`. It is defence in depth, but each of those writes turns a data bug into
an account takeover.

## Decision

1. **A third LOGIN role, `kasuwa_auth`,** created in `bootstrap.sql`.
   - NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION.
   - A member of no role, and no role is a member of it. So no `SET ROLE` leads into it from
     `kasuwa_app` (unlike `kasuwa_sweeper`, ADR-0012) or out of it to anything.
   - It owns nothing, may create nothing, and no default privilege names it.

2. **Migration 0024 makes it the only writer of six tables:** `auth_session`, `auth_challenge`,
   `user_credential`, `user_mfa_factor`, `user_mfa_backup_code` and `auth_rate_limit`.
   - **`kasuwa_app` and PUBLIC lose INSERT, UPDATE, DELETE and TRUNCATE on all six.** The D-L66
     sweeper keeps its DELETE on `auth_challenge`, `auth_session` and `auth_rate_limit`, which its
     own policies confine to rows already past retention.
   - **`kasuwa_auth` gets SELECT, DELETE and INSERT on the six, with two narrowings:**
     - `user_mfa_factor` INSERT covers every column except the legacy plaintext `secret`. New
       factors are envelope-only (D-L13) by privilege, not by convention.
     - UPDATE is limited to the columns the module changes. On `auth_session` that is
       `revoked_at` alone, so even SQL on the auth pool cannot extend a session or re-point it.
       On `user_credential` it is `password_hash` alone (see Consequences, "the review's
       narrowing").
   - **On `"user"`:** SELECT, and UPDATE (`updated_at`) only. The UPDATE exists because
     `lockUserForFactorWrite` takes `SELECT ... FOR UPDATE`, which Postgres refuses without UPDATE
     on some column. 0023's guard trigger passes every role but `kasuwa_app` through, so this
     column grant is the whole bound.
   - **Reads:** `tenant` (to confirm a tenant) and `user_programme` (to resolve scope).
   - **Schema `app`:** USAGE, plus EXECUTE on the four context accessors and on
     `app.resolve_tenant_by_slug`. Of the SECURITY DEFINER functions it may run that one only.
     The migration enumerates every definer to check this.
   - **A refusal is a privilege** (42501, visible in the catalogue), not a policy that silently
     matches no rows.
   - **The migration asserts all of it at migrate time.** It checks that nothing beyond the plan
     is held and that everything in the plan landed. It also checks that no `pg_default_acl` row
     names `kasuwa_auth`.

3. **Its own pool, confined to the auth module.**
   - `DATABASE_AUTH_URL` is required by `apiEnv`, refused by presence by `webEnv` and
     `webBuildEnv`, and carried by no other process.
   - `AuthModule` (`apps/api/src/auth/auth.module.ts`) hosts the auth controller, services and
     guards, and `AuthTenantTransactionInterceptor`. It is the **only** importer of
     `AuthDatabaseModule`, which builds the pool from `AppModuleOptions.authDatabaseUrl` under
     `AUTH_PG_POOL`. It exports nothing.
   - A controller outside `AuthModule` that uses the auth interceptor fails at boot. A unit test
     proves this. No file in `apps/` outside `src/auth/` names the token; the T-0049 suite checks
     that statically.

4. **The API refuses to boot unless `DATABASE_URL` logs in as `kasuwa_app` and `DATABASE_AUTH_URL`
   as `kasuwa_auth`.** It checks `current_user` and `session_user` on both pools at bootstrap,
   before `listen`. The roles are fixed, not configurable. Swapped URLs, both on one role, or
   either on the migrator or a superuser all stop the process.

5. **Which pool each path uses.**
   - Every transaction that writes any of the six tables runs on the auth pool:
     - sign-in's recording phase;
     - MFA verify;
     - challenge re-issue;
     - enrolment;
     - sign-out's revoke;
     - the signed-in `POST /auth/me/mfa/*` writes. These run their whole request transaction there
       through `AuthTenantTransactionInterceptor`, which calls the same
       `interceptInTenantTransaction` as the general interceptor. So scope is still resolved from
       `user_programme`, and the session row is still re-read under RLS.
   - `GET /auth/me` and `GET /auth/me/mfa` are reads and stay on the app pool.
   - Sign-out resolves the token with `app.resolve_session` on the app pool. That definer stays
     granted to `kasuwa_app` only.

6. **RESOLVED BY T-0157 (migration 0046). WAS: an accepted deviation from D-P16, sign-in's read phase on the app pool.**
   Phase one now runs on the auth pool, and `kasuwa_app` has no SELECT on `user_credential` at all, nor on the secret
   columns of `user_mfa_factor` (`secret`, `secret_ciphertext`, `secret_wrapped_key`, `secret_key_id`, `secret_algorithm`)
   and `user_mfa_backup_code` (`code_hash`, `hash_key_wrapped`, `hash_key_id`, `hash_algorithm`). It keeps the non-secret
   columns the MFA status read and the admin home count use. The legacy plaintext `secret` column is revoked, not dropped;
   dropping it (follow-up 4 below) is still a contract migration of its own. The text below is the original decision, kept
   for the reasoning. **One consequence to know:** with phase one on the auth pool, the lock-starvation argument below
   applies to the auth pool, so T-0045 part 2 (auth-retention) must starve BOTH pools and expect one 503 (the lead restates
   it; follow-up 1).

   Original decision:
   - **What and why.** Phase one (the lock read and the account lookup) writes nothing, and it
     runs as `kasuwa_app`. So `kasuwa_app` keeps SELECT on `user_credential.password_hash`, on
     `user_mfa_factor`'s secret columns and on `auth_rate_limit`. D-P16 said `kasuwa_app` "keeps
     SELECT only where it needs it". Here it needs it only because of this placement.
   - **The reason.** T-0045's acceptance contract (auth-retention part 2) starves the *app* pool
     by locking `"user"` and `user_programme`, and requires both sign-in branches to answer the
     same 503. If phase one ran on a separate pool, two things would happen:
     - The real-workspace branch would block on the `"user"` lock until `statement_timeout`.
     - The unknown-workspace branch, which reads no `"user"` row, would answer 401.

     That is a hang and an enumeration oracle. On the app pool both branches fail together, as
     before.
   - **Conditions from the review:**
     - it is recorded here as a deviation, not as the design;
     - phase one stays read-only, which the T-0049 unit test pins by pool per path;
     - no other path may read the auth tables on the app pool except the interceptor's session
       re-read, the admin home's MFA count and `GET /auth/me/mfa`.
   - **Follow-up (to be numbered by the lead)**, done together:
     1. restate T-0045 part 2 as "either pool exhausted" and starve both pools in that suite;
     2. move phase one to the auth pool;
     3. column-revoke `kasuwa_app`'s SELECT on `user_credential.password_hash` and on the
        `user_mfa_factor` secret columns. The admin home's count reads only non-secret columns;
     4. drop the legacy plaintext `user_mfa_factor.secret` column (the D-L13 contract step).

7. **Unchanged.**
   - Tenant RLS applies to the auth pool exactly as before: `kasuwa_auth` is NOBYPASSRLS, and
     every auth-table policy is `FOR ALL TO PUBLIC`.
   - The role-forgery check (`current_user = session_user` at start and commit) and
     `releaseClean` apply. The auth pool is used only through `withAuthTransaction` and
     `withTenantTransaction`. The one exception is the boot-time `SELECT current_user`, which
     reads no table.
   - There are still exactly two SECURITY DEFINER functions.

## Consequences

**Good.** SQL injected anywhere outside `apps/api/src/auth/` can no longer mint a session, rewrite
a credential, touch a factor or backup code, or clear a lockout. It gets 42501, and the T-0049
suite proves each attack against the tenant admin. Inside the auth module, the column grants shrink
what a bug there can do. Authentication still establishes WHO and never WHAT:
`tests/acceptance/tenancy/` passes unmodified.

**Bad.**
- **Connections double.** Each API process opens up to `2 × DATABASE_POOL_MAX` connections, one
  pool per role, both sized by `poolMax`. Cell Postgres `max_connections` and any pooler must be
  sized for that.
- Sign-in touches only the auth pool since T-0157; `kasuwa_app` no longer reads password hashes or
  factor secrets (migration 0046).
- A new auth table must repeat 0024's revoke and grant by hand. Bootstrap's default privileges still
  give every future table's DML to `kasuwa_app` (`packages/db/CLAUDE.md` invariant 9).
- **The review's narrowing of `user_credential`.** The review asked for UPDATE on `updated_at`
  only, because no code changes a hash yet. The T-0049 acceptance suite's control runs
  `UPDATE user_credential SET password_hash = password_hash` as `kasuwa_auth`, so `password_hash`
  is the narrowest grant the suite accepts. `updated_at` needs no grant; a trigger sets it. If the
  suite's control is changed, this narrows to no column at all, and the I2 check that requires
  some UPDATE on each table must change with it.
- **Not audited, pre-existing.** MFA factor replacement and backup-code regeneration write no
  audit event. CLAUDE.md 6.7 lists permission changes and similar sensitive actions; whether a
  user's own second-factor change is one needs a decision. When it is audited, note that
  `audit_event` is writable by `kasuwa_app`, not `kasuwa_auth`, so the write needs either a grant
  or the event emitted from the app pool.

**Rollout.**
- Real environments create `kasuwa_auth` with a secrets-manager password before `bootstrap.sql`
  runs. The bootstrap's `IF NOT EXISTS` keeps that password and only asserts the attributes.
- Then apply 0024. It stops with instructions if the role is missing or mis-shaped.
- `DATABASE_AUTH_URL` goes into the API's environment only.
- 0024 ships expand (grants) and contract (revokes) in one file. That is acceptable only under
  D-L65, because no populated cell exists. An API built before T-0049 cannot sign anyone in
  against a database that has run 0024.
- Rollback is an out-of-band GRANT as `kasuwa_migrator`, because the T-0049 suite fails on such a
  migration. Rolling forward is usually faster. The 0024 header says how.

**Honest.** This is a privilege boundary for code outside the auth module, not for code inside it.
The auth pool's SQL can still do whatever the auth module may do, within one tenant. A hostile
callback inside `apps/api/src/auth/` is the ADR-0010 class of problem, one directory smaller.

## Alternatives rejected

- **Narrow policies for `kasuwa_app` instead of grants.** A policy that refuses is a 0-row match:
  invisible in a privilege audit and indistinguishable from "no such row".
- **SECURITY DEFINER write functions.** Each would be a writing, RLS-free path, and CLAUDE.md 2.7
  makes every definer an ADR of its own.
- **Grant `kasuwa_auth` to `kasuwa_app` (`SET` membership), as with the sweeper.** Any injected
  SQL could `SET ROLE kasuwa_auth`. The commit-time role check would detect that only after the
  fact, and this role reaches every live session.
- **Leave `auth_rate_limit` writable by `kasuwa_app`** (the first draft). The presented-key policy
  confines a session to a key it can present, and a user's MFA key can be computed from ids an
  attacker inside a tenant already has.
- **Move sign-in's read phase to the auth pool now.** Done in T-0157, once T-0045's contract was
  restated. It was the named follow-up, not a rejection.
- **A lint rule instead of `AuthModule`** to confine the interceptor. A rule catches an import
  path; a module boundary catches any use at boot, however it is reached.
