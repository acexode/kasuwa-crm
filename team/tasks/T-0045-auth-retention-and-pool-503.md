# T-0045 — Auth-table retention job, and pool exhaustion answered as 503

**status** `not-assigned` (builder running: Agent 1, `agent1/T-0045-auth-retention`; suite on `lead/T-0045-acceptance` a337c43) · **owner** Agent 1 · **priority** P1 · **decisions** D-L56, D-L66, ADR-0009

## Goal
1. **Retention job.** An `apps/worker` job prunes `auth_challenge`, `auth_session` and `auth_rate_limit` on a stated
   retention: expired challenges after 1 day, revoked or expired sessions after 30 days, and rate-limit rows whose
   window and lock have both lapsed. It runs in bounded batches. `auth_rate_limit` grows with attacker traffic, so it
   is the urgent one. The job must not use a pool that bypasses RLS: work out how a cross-tenant prune is done safely
   (ADR-0009 tables have no tenant_id), and argue it in the PR.
2. **503 on pool exhaustion.** A `pg` pool connection timeout (5 s since T-0013) is answered 503
   `service_unavailable` with `Retry-After`, not 500. Indistinguishable for every route, including sign-in.

## Acceptance tests
`tests/acceptance/platform/auth-retention.acceptance.test.ts`, written by the lead.

## Escalate if
The prune needs a third SECURITY DEFINER function. That needs an ADR (CLAUDE.md 2.7).
