import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  accountLocked,
  invalidCredentials,
  mfaChallengeExpired,
  mfaChallengeInvalid,
  mfaCodeInvalid,
  notAuthenticated,
  notImplemented,
  ssoDomainNotFound,
} from './auth.errors';

/**
 * These assert the property the P01 sign-in screen is built on: the API must
 * not be able to tell an attacker which addresses exist.
 */
describe('authentication error bodies', () => {
  it('is byte-identical for every first-factor failure', () => {
    // Unknown workspace, unknown email, wrong password, disabled user and a
    // user in another tenant all come through this one function. If a future
    // change adds a friendlier variant for any of them, this fails.
    const unknownEmail = invalidCredentials(4).getResponse();
    const wrongPassword = invalidCredentials(4).getResponse();
    expect(unknownEmail).toEqual(wrongPassword);
    expect(unknownEmail).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'invalid_credentials',
      message: 'Sign-in failed. Check your email address and password, then try again.',
      attemptsRemaining: 4,
    });
  });

  it('reports a null countdown when lockout is disabled', () => {
    expect(invalidCredentials(null).getResponse()).toMatchObject({ attemptsRemaining: null });
  });

  it('never names a field, a user or a tenant in any message', () => {
    const messages = [
      invalidCredentials(1),
      accountLocked(new Date(0), 'Africa/Lagos'),
      mfaCodeInvalid(2),
      mfaChallengeExpired(),
      mfaChallengeInvalid(),
      notAuthenticated(),
    ].map((error) => (error.getResponse() as { message: string }).message);

    for (const message of messages) {
      expect(message).not.toMatch(/email address does not|no such|unknown user|disabled|tenant/iu);
    }
  });

  it('carries a retry time and an IANA zone when an account is locked', () => {
    // P01/1b: "try again in 15 minutes" is useless to somebody whose phone
    // clock is on a different zone from the workspace.
    const response = accountLocked(new Date('2026-09-27T10:27:00.000Z'), 'Africa/Lagos');
    expect(response.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.getResponse()).toMatchObject({
      code: 'account_locked',
      retryAt: '2026-09-27T10:27:00.000Z',
      timeZone: 'Africa/Lagos',
    });
  });

  it('uses the statuses the published contract promises', () => {
    expect(invalidCredentials(null).getStatus()).toBe(401);
    expect(mfaCodeInvalid(1).getStatus()).toBe(401);
    expect(mfaChallengeExpired().getStatus()).toBe(401);
    expect(mfaChallengeInvalid().getStatus()).toBe(401);
    expect(notAuthenticated().getStatus()).toBe(401);
    expect(ssoDomainNotFound().getStatus()).toBe(404);
    expect(notImplemented().getStatus()).toBe(501);
  });

  it('distinguishes the second-factor failures, which is safe and necessary', () => {
    // Holding a challenge id already proves the password was right, so telling
    // this caller that their code expired reveals nothing new — and P01/2b
    // needs it to offer "Send a new code".
    const codes = [mfaCodeInvalid(3), mfaChallengeExpired(), mfaChallengeInvalid()].map(
      (error) => (error.getResponse() as { code: string }).code,
    );
    expect(new Set(codes).size).toBe(3);
  });
});
