import { totpCode } from '@kasuwa/auth-crypto';
import { seedPrimaryUser, seedSignIn, type SeedSignIn } from '@kasuwa/db';
import { Client } from 'pg';

/**
 * Helpers for tests that need a real, signed-in session.
 *
 * They exist so that a test says "sign in as Tunde" in one line instead of
 * restating the workspace slug, the address and the TOTP secret and getting one
 * of the three wrong. They do NOT forge anything: everything here goes through
 * the real endpoints or, for `disableSeededUser`, through the migrator role
 * exactly as an administrator's own tooling would.
 *
 * Like the rest of @kasuwa/testing, application code must never import this.
 */

/** Credentials for a seeded user, by user id. Throws if they are not seeded. */
export function seededCredentials(userId: string): SeedSignIn {
  const fixture = seedSignIn(userId);
  if (fixture === undefined) {
    throw new Error(`No seeded sign-in fixture for user ${userId}`);
  }
  return fixture;
}

/** Credentials for the user a test means by "sign in as tenant A". */
export function seededCredentialsForTenant(tenantId: string): SeedSignIn {
  const userId = seedPrimaryUser(tenantId);
  if (userId === undefined) {
    throw new Error(`No seeded users for tenant ${tenantId}`);
  }
  return seededCredentials(userId);
}

/**
 * The code a seeded user's authenticator app would show right now.
 *
 * Computed from the fixture secret, so the test proves the real TOTP path
 * rather than a bypass. Nothing in the application accepts a code produced any
 * other way.
 */
export function seededTotpCode(userId: string, at: Date = new Date()): string {
  return totpCode(seededCredentials(userId).totpSecret, at);
}

/**
 * How many steps this harness has already handed out for a user.
 *
 * TOTP codes are single-use (RFC 6238 section 5.2): the server records the
 * step it accepted and refuses anything at or below it. That is correct, and a
 * real person almost never notices it, because signing in twice inside one
 * thirty-second window is not a thing people do. Test suites do it constantly.
 *
 * The server accepts the step either side of the current one for clock drift,
 * so three sign-ins in quick succession ARE possible — at steps n-1, n and
 * n+1 — provided the harness hands them out in increasing order rather than
 * returning the same current code three times. That is all this map does.
 *
 * A fourth rapid sign-in as the same user cannot work, and no harness can make
 * it: step n+2 is outside the window the server will accept, so the only way
 * through is to let the clock move on. If a suite needs more than three, it
 * should either reuse the session it already has or reset the watermark with
 * `resetSeededTotpUsage`.
 */
const issuedSteps = new Map<string, number>();

const STEP_SECONDS = 30;

/**
 * A code for a seeded user that has not been used yet, if one is available.
 *
 * Walks forward through the acceptable window rather than returning the same
 * current code every time. Throws a message naming the fix when the window is
 * exhausted, because failing with "that code did not match" three layers down
 * would send the next person looking in the wrong place entirely.
 */
export function freshSeededTotpCode(userId: string, at: Date = new Date()): string {
  const currentStep = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  const previous = issuedSteps.get(userId);
  const step = previous === undefined ? currentStep - 1 : previous + 1;

  if (step > currentStep + 1) {
    throw new Error(
      `No unused TOTP step left for ${userId} in this window. Codes are single-use ` +
        `and the server accepts only one step either side of the current one, so at most ` +
        `three sign-ins as one user can happen inside thirty seconds. Reuse the session ` +
        `you already have, or call resetSeededTotpUsage(migrationUrl) between tests. ` +
        `There is no switch that turns single-use codes off.`,
    );
  }

  issuedSteps.set(userId, step);
  return totpCode(seededCredentials(userId).totpSecret, new Date(step * STEP_SECONDS * 1000));
}

/**
 * Clears the server's single-use watermark and the harness's own.
 *
 * For a suite that signs the same user in more than three times in quick
 * succession. It is NOT the same as turning single-use codes off: the control
 * stays on and every sign-in still goes through it; the fixture simply starts
 * each test from a clean sheet, exactly as truncating a rate-limit counter
 * does. Replay rejection has its own test, with the default on, in
 * `apps/api/src/auth/auth-hardening.integration.test.ts`.
 */
export async function resetSeededTotpUsage(migrationUrl: string): Promise<void> {
  issuedSteps.clear();
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query('UPDATE user_mfa_factor SET last_used_step = NULL');
  } finally {
    await client.end();
  }
}

/**
 * The same, for a test that says "sign in as tenant A" and does not care which
 * of that tenant's users it gets. It gets the first one, consistently, so the
 * credentials and the code always belong to the same person.
 */
export function seededTotpCodeForTenant(tenantId: string, at: Date = new Date()): string {
  const userId = seedPrimaryUser(tenantId);
  if (userId === undefined) {
    throw new Error(`No seeded users for tenant ${tenantId}`);
  }
  // Deliberately the step-walking variant. A suite that says "sign in as
  // tenant A" and means it several times over is exactly the caller that trips
  // over single-use codes, and returning the same current code each time would
  // fail it on the second call.
  return freshSeededTotpCode(userId, at);
}

/**
 * Disables a seeded user, as an administrator would.
 *
 * Runs as kasuwa_migrator, because the API has no user-administration endpoint
 * yet (that is M2's permissions work, a separate task). The point of the test
 * this serves is that a disabled user is refused on their NEXT request, not
 * that some particular endpoint did the disabling.
 */
export async function disableSeededUser(migrationUrl: string, userId: string): Promise<void> {
  await updateUserStatus(migrationUrl, userId, 'disabled');
}

/** Puts a user back, so one test does not silently break the next. */
export async function enableSeededUser(migrationUrl: string, userId: string): Promise<void> {
  await updateUserStatus(migrationUrl, userId, 'active');
}

async function updateUserStatus(
  migrationUrl: string,
  userId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query(`UPDATE "user" SET status = $2, updated_at = now() WHERE id = $1`, [
      userId,
      status,
    ]);
  } finally {
    await client.end();
  }
}
