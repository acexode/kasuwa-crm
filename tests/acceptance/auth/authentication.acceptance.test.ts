import { describe, it } from 'vitest';

/**
 * ACCEPTANCE STUB — T-0001, real authentication (Agent 1, M2).
 *
 * These are `todo` rather than failing so that the scaffold's first PR lands
 * with CI green. That is a deliberate compromise and worth stating plainly:
 * Addendum A1 section 3.3 says acceptance tests are committed *failing* before
 * a builder starts, and a `todo` does not hold anyone to anything.
 *
 * The intended flow is therefore: the lead converts these to real, failing
 * tests in a `lead-approved` PR **before T-0001 is assigned**. Agent 1 cannot
 * do it — this file is protected.
 *
 * Each `todo` below is written as the assertion it will become, not as a vague
 * heading, so that converting it is transcription rather than invention.
 */
describe('acceptance (stub): authentication', () => {
  it.todo('establishes a session for a valid password and TOTP code');

  it.todo('rejects a valid password with an invalid TOTP code');

  it.todo(
    'returns an identical response for an unknown email and a wrong password, ' +
      'and does not distinguish them by response time',
  );

  it.todo('rejects a session issued for tenant A when presented against tenant B');

  it.todo('rejects the next request after a user is disabled, without waiting for expiry');

  it.todo('never accepts a session token from a query string or URL fragment');

  it.todo('writes no credential material to logs, error bodies or traces');

  it.todo(
    'leaves tests/acceptance/tenancy passing unmodified — scope is still resolved ' +
      'from user_programme, never from the token',
  );
});
