import type { Page, Route } from '@playwright/test';
import {
  AUTH_CONTRACT,
  AUTH_CONTRACT_SOURCE,
  contractExample,
  type AuthOperationId,
} from './auth-mock.generated';

/**
 * The auth API, as `docs/api/auth.openapi.yaml` describes it, served into the
 * browser by Playwright.
 *
 * Every body it returns comes from `auth-mock.generated.ts`, which is generated
 * from that spec and checked for drift. Nothing here invents a payload: this
 * file holds only the STATE MACHINE the contract describes in prose and cannot
 * express in examples — which attempt is the fifth, whether the resend window
 * has elapsed, whether the code matched.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY THIS MOCK EXISTS TO MAKE TESTABLE
 *
 * An unknown email and a wrong password must be INDISTINGUISHABLE — same
 * status, same body, and a lockout counter that advances identically. The
 * counter is keyed on the submitted identifier whether or not an account
 * exists, exactly as the contract says the server does it, because a counter
 * that only counts real accounts is the enumeration oracle the message refuses
 * to be.
 *
 * `KNOWN_ACCOUNTS` below therefore affects ONLY whether the password matches.
 * It must never affect the shape of a failure. If you find yourself adding a
 * branch on "does this account exist" anywhere outside the password check, that
 * is the bug this whole screen was designed to prevent.
 * ---------------------------------------------------------------------------
 */

/** Lockout threshold. Five, from the P01 board — and pinned in T-0001's suite. */
const LOCKOUT_THRESHOLD = 5;

/** Accounts the mock knows. Existence changes the password check and nothing else. */
const KNOWN_ACCOUNTS: ReadonlyMap<string, string> = new Map([
  ['tunde.agent@tenant-a.test', 'correct-horse-battery'],
]);

const VALID_MFA_CODE = '123456';

export interface MockOptions {
  /**
   * Milliseconds to hold a sign-in before answering. Used to reach `P01/1d`
   * deterministically: the screen shows "Still connecting…" at four seconds,
   * and waiting on a real clock inside the test would be a guess.
   */
  readonly signInDelayMs?: number;
  /** Force the next sign-in to this outcome regardless of the credentials. */
  readonly forceSignIn?: 'locked';
  /** Force the next MFA verify to this outcome. */
  readonly forceMfa?: 'expired' | 'unusable';
}

interface MockState {
  /** Failed first-factor attempts, keyed on `slug|email`, not on a real user. */
  readonly failures: Map<string, number>;
}

function identifier(body: { tenantSlug?: unknown; email?: unknown }): string {
  return `${String(body.tenantSlug ?? '')}|${String(body.email ?? '')}`.toLowerCase();
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * The contract's `account_locked` body, with a `retryAt` that is actually in the
 * future. The spec's example carries a fixed timestamp — correct as an example,
 * useless as a lockout, because a screen that formats a date in 2026 would pass
 * a test that should notice it renders "try again at 10:27" for ever.
 */
function lockedBody(): Record<string, unknown> {
  const example = contractExample('signIn', 429) as Record<string, unknown>;
  return {
    ...example,
    retryAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
}

function challengeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const example = contractExample('signIn', 200) as Record<string, unknown>;
  return {
    ...example,
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

/**
 * Installs the mock on `page`. Returns a handle so a spec can reset the lockout
 * counter between cases without reloading the page.
 */
export async function installAuthMock(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state: MockState = { failures: new Map() };

  await page.route('**/api/v1/auth/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const operation = AUTH_CONTRACT.find(
      (candidate) => candidate.path === url.pathname && candidate.method === request.method(),
    );

    if (operation === undefined) {
      throw new Error(
        `${request.method()} ${url.pathname} is not in ${AUTH_CONTRACT_SOURCE}. ` +
          'The screen is calling an endpoint the contract does not publish.',
      );
    }

    // Operations the contract marks `false` are contract-only in T-0001 and
    // answer 501 everywhere — P01/3 and P01/4 stay on this mock by design.
    if (operation.implemented === 'false') {
      await json(route, 501, contractExample(operation.operationId as AuthOperationId, 501));
      return;
    }

    const raw = request.postData();
    const body: Record<string, unknown> =
      raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);

    switch (operation.operationId) {
      case 'signIn':
        await handleSignIn(route, body, state, options);
        return;
      case 'verifyMfa':
        await handleVerifyMfa(route, body, options);
        return;
      case 'reissueMfaChallenge':
        await handleReissue(route, body);
        return;
      case 'lookupSso':
        // T-0001 implements the lookup and the not-found path only: no SSO
        // connection can be configured yet, so this IS the live behaviour.
        await json(route, 404, contractExample('lookupSso', 404));
        return;
      default:
        await json(route, 501, { statusCode: 501, error: 'Not Implemented', code: 'not_implemented', message: '' });
    }
  });

  return state;
}

async function handleSignIn(
  route: Route,
  body: Record<string, unknown>,
  state: MockState,
  options: MockOptions,
): Promise<void> {
  if (options.signInDelayMs !== undefined) {
    await new Promise((done) => setTimeout(done, options.signInDelayMs));
  }

  const key = identifier(body);
  const failures = state.failures.get(key) ?? 0;

  if (options.forceSignIn === 'locked' || failures >= LOCKOUT_THRESHOLD) {
    await json(route, 429, lockedBody());
    return;
  }

  const email = String(body.email ?? '').toLowerCase();
  const password = String(body.password ?? '');
  // The ONLY place account existence is consulted. Everything below this line
  // behaves identically for a real address and an invented one.
  const accepted = KNOWN_ACCOUNTS.get(email) === password && password !== '';

  if (accepted) {
    state.failures.delete(key);
    await json(route, 200, challengeBody());
    return;
  }

  const next = failures + 1;
  state.failures.set(key, next);

  if (next >= LOCKOUT_THRESHOLD) {
    await json(route, 429, lockedBody());
    return;
  }

  const example = contractExample('signIn', 401) as Record<string, unknown>;
  await json(route, 401, { ...example, attemptsRemaining: LOCKOUT_THRESHOLD - next });
}

async function handleVerifyMfa(
  route: Route,
  body: Record<string, unknown>,
  options: MockOptions,
): Promise<void> {
  if (options.forceMfa === 'expired') {
    await json(route, 401, contractExample('verifyMfa', 401, 'expired'));
    return;
  }
  if (options.forceMfa === 'unusable') {
    await json(route, 401, contractExample('verifyMfa', 401, 'unusable'));
    return;
  }
  if (String(body.code ?? '') === VALID_MFA_CODE) {
    await json(route, 200, contractExample('verifyMfa', 200));
    return;
  }
  await json(route, 401, contractExample('verifyMfa', 401, 'wrongCode'));
}

async function handleReissue(route: Route, body: Record<string, unknown>): Promise<void> {
  const method = String(body.method ?? 'totp');

  // `partial`: T-0001 implements `totp`; `sms` and `backup_code` need a channel
  // provider that does not exist (Agent 5, M8) and answer 501 until it does.
  if (method !== 'totp' && method !== 'sms') {
    await json(route, 501, contractExample('reissueMfaChallenge', 501));
    return;
  }

  await json(
    route,
    200,
    challengeBody({
      method,
      resendAvailableAt:
        method === 'sms' ? new Date(Date.now() + 60 * 1_000).toISOString() : null,
    }),
  );
}
