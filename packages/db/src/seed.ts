import {
  createDevelopmentKeyProvider,
  hashPassword,
  mfaSecretAad,
  sealSecret,
  type KeyProvider,
} from '@kasuwa/auth-crypto';
import { Client } from 'pg';
import { SEED_CONTACTS, SEED_PASSWORD, SEED_TENANTS, seedTotpSecret } from './fixtures';
import { newId } from './ids';

/**
 * Seeds two tenants, each with a business unit, two programmes, users and
 * contacts (packages/db/src/fixtures.ts).
 *
 * Runs as kasuwa_migrator, which holds BYPASSRLS — it writes across both
 * tenants in one pass, which no application session can do. This is the only
 * process in the system with that property, and it never serves traffic.
 *
 * Idempotent: truncates the tenancy tables first, so `pnpm db:seed` is safe to
 * re-run and always produces byte-identical data.
 */

export interface SeedOptions {
  connectionString: string;
  log?: (message: string) => void;
  /**
   * How the fixture TOTP secrets are sealed (D-L13).
   *
   * Defaults to the development provider, which is the only one that can ever
   * apply here: `assertLocalDatabase` already refuses to seed anything but
   * localhost, and the development provider refuses to exist under
   * NODE_ENV=production. The option exists so a test can seal under a different
   * key id and prove the key id is honoured per row.
   */
  keyProvider?: KeyProvider;
}

/**
 * Refuses to seed anything but a local database.
 *
 * The guard lives HERE rather than on the `db:seed` CLI, which is where it
 * started. A check on the command line protects the one caller that happens to
 * go through the command line; `runSeed` is exported from `@kasuwa/db`, so
 * anything that imports the package could seed a shared environment and the
 * check would never run.
 *
 * What it is guarding is not tidiness. The seed installs five working users
 * whose shared password and TOTP secrets are committed to this repository and
 * exported from this very package. Run against anything reachable, it turns a
 * fixture into a published credential with a valid second factor. The fixtures
 * are fine as fixtures; running them somewhere real is the whole risk.
 *
 * Testcontainers publishes on 127.0.0.1, so the harness is unaffected.
 *
 * `[::1]` is in the list with its brackets because that is what
 * `new URL().hostname` actually returns for IPv6 loopback — `'::1'` alone never
 * matches. A guard that rejects a genuinely local database is not a safe
 * failure: it teaches the next person to reach around it.
 */
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLocalDatabase(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `runSeed refuses to run against a non-local host: ${host}. The seed installs ` +
        `users whose password and second-factor secrets are committed to the ` +
        `repository; running it anywhere shared publishes a way in.`,
    );
  }
}

export async function runSeed(options: SeedOptions): Promise<void> {
  assertLocalDatabase(options.connectionString);

  const log = options.log ?? (() => undefined);
  // Hashed once, outside the transaction: argon2id is memory-hard by design and
  // every seeded user shares the same fixture password, so hashing per user
  // would add seconds to every `pnpm db:reset` for no extra realism.
  const seededPasswordHash = await hashPassword(SEED_PASSWORD);
  const keyProvider = options.keyProvider ?? createDevelopmentKeyProvider();

  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    // CASCADE reaches business_unit, programme, user, user_programme and contact
    // through their tenant_id foreign keys.
    await client.query('TRUNCATE TABLE tenant CASCADE');

    for (const tenant of SEED_TENANTS) {
      await client.query(
        `INSERT INTO tenant (id, name, slug, region_cell, locale_default, currency_default)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenant.id,
          tenant.name,
          tenant.slug,
          tenant.slug.includes('rift') ? 'ke-1' : 'za-1',
          tenant.slug.includes('rift') ? 'en' : 'en-NG',
          tenant.slug.includes('rift') ? 'KES' : 'NGN',
        ],
      );

      await client.query(`INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, $3)`, [
        tenant.businessUnit.id,
        tenant.id,
        tenant.businessUnit.name,
      ]);

      for (const programme of tenant.programmes) {
        await client.query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, client_name, is_default)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            programme.id,
            tenant.id,
            tenant.businessUnit.id,
            programme.name,
            programme.clientName,
            programme.isDefault,
          ],
        );
      }

      for (const user of tenant.users) {
        await client.query(
          `INSERT INTO "user" (id, tenant_id, email, display_name, locale)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            user.id,
            tenant.id,
            user.email,
            user.displayName,
            tenant.slug.includes('rift') ? 'en' : 'en-NG',
          ],
        );
        // Every seeded user can actually sign in: a password and an enrolled
        // second factor. Without both, the only way to exercise the real auth
        // path in a test would be to build the rows by hand in each suite.
        await client.query(
          `INSERT INTO user_credential (user_id, tenant_id, password_hash)
           VALUES ($1, $2, $3)`,
          [user.id, tenant.id, seededPasswordHash],
        );

        const totpSecret = seedTotpSecret(user.id);
        if (totpSecret !== undefined) {
          // EXPAND PHASE (migration 0005): both forms are written. The envelope
          // is what the API reads; the plaintext column stays populated until
          // the contract migration drops it, so that rolling back to the
          // previous application version does not lock every seeded user out.
          const factorId = newId();
          const sealed = await sealSecret(
            keyProvider,
            totpSecret,
            mfaSecretAad(tenant.id, factorId),
          );
          await client.query(
            `INSERT INTO user_mfa_factor
               (id, tenant_id, user_id, type, label, secret,
                secret_ciphertext, secret_wrapped_key, secret_key_id, secret_algorithm,
                confirmed_at)
             VALUES ($1, $2, $3, 'totp', $4, $5, $6, $7, $8, $9, now())`,
            [
              factorId,
              tenant.id,
              user.id,
              'Authenticator app',
              totpSecret,
              sealed.ciphertext,
              sealed.wrappedKey,
              sealed.keyId,
              sealed.algorithm,
            ],
          );
        }

        for (const programmeId of user.programmeIds) {
          await client.query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id, skills)
             VALUES ($1, $2, $3, $4)`,
            [user.id, programmeId, tenant.id, ['voice']],
          );
        }
      }
    }

    for (const contact of SEED_CONTACTS) {
      await client.query(
        `INSERT INTO contact
           (id, tenant_id, programme_id, display_name, given_names, family_name,
            phones, emails, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $9)`,
        [
          contact.id,
          contact.tenantId,
          contact.programmeId,
          contact.displayName,
          contact.givenNames,
          contact.familyName,
          JSON.stringify([{ type: 'mobile', e164: contact.phoneE164 }]),
          JSON.stringify([]),
          contact.createdAt,
        ],
      );
    }

    await client.query('COMMIT');
    log(
      `seeded ${SEED_TENANTS.length} tenants, ` +
        `${SEED_TENANTS.reduce((n, t) => n + t.programmes.length, 0)} programmes, ` +
        `${SEED_TENANTS.reduce((n, t) => n + t.users.length, 0)} users, ` +
        `${SEED_CONTACTS.length} contacts`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
