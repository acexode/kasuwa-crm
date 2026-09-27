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
 * The same, for a test that says "sign in as tenant A" and does not care which
 * of that tenant's users it gets. It gets the first one, consistently, so the
 * credentials and the code always belong to the same person.
 */
export function seededTotpCodeForTenant(tenantId: string, at: Date = new Date()): string {
  return totpCode(seededCredentialsForTenant(tenantId).totpSecret, at);
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
