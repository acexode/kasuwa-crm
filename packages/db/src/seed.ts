import { hashPassword } from '@kasuwa/auth-crypto';
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
}

export async function runSeed(options: SeedOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  // Hashed once, outside the transaction: argon2id is memory-hard by design and
  // every seeded user shares the same fixture password, so hashing per user
  // would add seconds to every `pnpm db:reset` for no extra realism.
  const seededPasswordHash = await hashPassword(SEED_PASSWORD);

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
          await client.query(
            `INSERT INTO user_mfa_factor (id, tenant_id, user_id, type, label, secret, confirmed_at)
             VALUES ($1, $2, $3, 'totp', $4, $5, now())`,
            [newId(), tenant.id, user.id, 'Authenticator app', totpSecret],
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
