import {
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';

/**
 * Server-side flag reads for `apps/web`. Import this from SERVER components
 * only: the answer is decided by the process, never by anything the browser
 * sends.
 *
 * `self_serve_signup` (D-P2) gates the ROUTES of `P01/3`, `P01/4` and
 * `P01/5.1`. Each of those pages calls `notFound()` when it is off, so typing
 * the path gets a real HTTP 404 — "not found", never "forbidden" (CLAUDE.md
 * 6.4) — and nothing of the screen is shipped. It is deliberately NOT checked
 * by `/onboarding`: the first-admin steps are for every tenant (T-0018).
 */

/**
 * Sign-up happens before there is a tenant, so the evaluation cannot carry a
 * real `tenantId`. A fixed sentinel keeps the context well-formed and makes it
 * explicit that no per-tenant rule can apply here: the switch is global.
 */
const PRE_TENANT = 'pre-tenant:self-serve-sign-up';

export async function selfServeSignupEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'self_serve_signup',
    false,
    toEvaluationContext({ tenantId: PRE_TENANT }),
  );
}
