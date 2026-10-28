import {
  createDevelopmentKeyProvider,
  hashPassword,
  mfaSecretAad,
  sealSecret,
  type KeyProvider,
} from '@kasuwa/auth-crypto';
import {
  effectiveDatabaseTarget,
  namesLocalDatabaseHost,
  nodeEnv,
  type EnvSource,
} from '@kasuwa/config';
import { Client } from 'pg';
import {
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_DEALS,
  SEED_PASSWORD,
  SEED_PERMISSION_SETS,
  SEED_PRICE_BOOKS,
  SEED_PRICE_BOOK_ENTRIES,
  SEED_PRODUCTS,
  SEED_PRODUCT_VARIANTS,
  SEED_APPROVAL_RULES,
  SEED_QUOTE_LINES,
  SEED_QUOTES,
  SEED_SCRIPTS,
  SEED_TAX_PROFILES,
  SEED_TENANTS,
  seedTotpSecret,
} from './fixtures';
import { newId } from './ids';
import { ensureStandardObjectDefs } from './standard-object-catalogue';

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
  /**
   * The environment whose NODE_ENV is judged (T-0117 re-review round 2).
   * Defaults to `process.env`, read through @kasuwa/config.
   */
  env?: EnvSource;
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
 * The host is judged as pg will use it (T-0117 review M3): parsed by
 * `pg-connection-string`, so a `?host=` overrides the URL's own, and a string
 * that names no host is not local, whatever PGHOST or pg's default would say.
 * `new URL().hostname` was fooled by `postgres://localhost/kasuwa?host=prod`.
 * Local is the D-L94 R5 list (`isLocalDatabaseHost` in @kasuwa/config). The
 * host is never echoed: a connection string's host can be internal.
 */
function assertLocalDatabase(connectionString: string, env: EnvSource | undefined): void {
  // An explicit production NODE_ENV is refused whatever the host: a loopback
  // tunnel can front a real cell (T-0117 re-review round 2). Before any
  // connection, and the host is not echoed.
  if (nodeEnv(env) === 'production') {
    throw new Error(
      'runSeed refuses to run with NODE_ENV=production. The seed installs users whose ' +
        'password and second-factor secrets are committed to the repository.',
    );
  }
  if (!namesLocalDatabaseHost(effectiveDatabaseTarget(connectionString, 'the seed connection string'))) {
    throw new Error(
      'runSeed refuses to run against a non-local host. The seed installs ' +
        'users whose password and second-factor secrets are committed to the ' +
        'repository; running it anywhere shared publishes a way in.',
    );
  }
}

export async function runSeed(options: SeedOptions): Promise<void> {
  assertLocalDatabase(options.connectionString, options.env);

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
    // through their tenant_id foreign keys. auth_rate_limit has no tenant key
    // (ADR-0009), so it is named explicitly: a lockout must not outlive a
    // reseed (D-L59).
    await client.query('TRUNCATE TABLE tenant, auth_rate_limit CASCADE');

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

      // Before the users: a membership names its permission set through a
      // composite foreign key (0015).
      for (const set of SEED_PERMISSION_SETS.filter(
        (candidate) => candidate.tenantId === tenant.id,
      )) {
        await client.query(
          `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [set.id, set.tenantId, set.key, set.label, set.locked, set.sortOrder],
        );
      }

      // The standard objects as metadata rows (T-0053): the same catalogue
      // provisioning writes for a new tenant, so a seeded tenant is not a
      // special case. TRUNCATE above removed the previous run's rows.
      await ensureStandardObjectDefs(
        (text, values) => client.query(text, [...values]).then((result) => result.rows),
        tenant.id,
      );

      for (const user of tenant.users) {
        await client.query(
          `INSERT INTO "user" (id, tenant_id, email, display_name, locale, is_tenant_admin)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            user.id,
            tenant.id,
            user.email,
            user.displayName,
            tenant.slug.includes('rift') ? 'en' : 'en-NG',
            user.isTenantAdmin,
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

        const permissionSet = SEED_PERMISSION_SETS.find(
          (candidate) =>
            candidate.tenantId === tenant.id && candidate.key === user.permissionSetKey,
        );
        if (permissionSet === undefined) {
          throw new Error(`Seed fixture names an unknown permission set: ${user.permissionSetKey}`);
        }
        for (const programmeId of user.programmeIds) {
          await client.query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id, skills, permission_set_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [user.id, programmeId, tenant.id, ['voice'], permissionSet.id],
          );
        }
      }
    }

    for (const account of SEED_ACCOUNTS) {
      await client.query(
        `INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)`,
        [account.id, account.tenantId, account.programmeId, account.name],
      );
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

    // After accounts (their FK target). created_by is the owner: a seeded
    // activity was logged by the user it belongs to.
    for (const activity of SEED_ACTIVITIES) {
      await client.query(
        `INSERT INTO activity
           (id, tenant_id, programme_id, type, subject, body,
            owner_user_id, created_by_user_id, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
        [
          activity.id,
          activity.tenantId,
          activity.programmeId,
          activity.type,
          activity.subject,
          activity.body,
          activity.ownerUserId,
          activity.accountId,
        ],
      );
    }

    // One deal (T-0106), in the first open stage of its programme's default
    // pipeline, which ensureStandardObjectDefs created above. After the users:
    // the owner is a composite FK.
    for (const deal of SEED_DEALS) {
      const stages = await client.query<{ pipeline_id: string; stage_id: string }>(
        `SELECT s.pipeline_id, s.id AS stage_id
           FROM pipeline_stage s
          WHERE s.tenant_id = $1 AND s.programme_id = $2 AND s.kind = 'open'
          ORDER BY s.position
          LIMIT 1`,
        [deal.tenantId, deal.programmeId],
      );
      const first = stages.rows[0];
      if (first === undefined) {
        throw new Error('Seed: the deal fixture names a programme with no default pipeline');
      }
      await client.query(
        `INSERT INTO deal
           (id, tenant_id, programme_id, pipeline_id, stage_id, name, amount_minor, currency,
            owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9)`,
        [
          deal.id,
          deal.tenantId,
          deal.programmeId,
          first.pipeline_id,
          first.stage_id,
          deal.name,
          deal.amountMinor,
          deal.currency,
          deal.ownerUserId,
        ],
      );
    }

    // One published script (T-0113): the draft, then its version 1, the draft
    // as published (so it has no unpublished changes). After the users: a
    // version names its publisher through a composite FK.
    for (const tax of SEED_TAX_PROFILES) {
      await client.query(
        `INSERT INTO tax_profile (id, tenant_id, programme_id, name, rate_bps)
         VALUES ($1, $2, $3, $4, $5)`,
        [tax.id, tax.tenantId, tax.programmeId, tax.name, tax.rateBps],
      );
    }

    for (const book of SEED_PRICE_BOOKS) {
      await client.query(
        `INSERT INTO price_book (id, tenant_id, programme_id, name, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [book.id, book.tenantId, book.programmeId, book.name, book.currency],
      );
    }

    for (const product of SEED_PRODUCTS) {
      await client.query(
        `INSERT INTO product
           (id, tenant_id, programme_id, name, sku, tax_profile_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          product.id,
          product.tenantId,
          product.programmeId,
          product.name,
          product.sku,
          product.taxProfileId,
        ],
      );
    }

    for (const variant of SEED_PRODUCT_VARIANTS) {
      await client.query(
        `INSERT INTO product_variant
           (id, tenant_id, programme_id, product_id, name, sku)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          variant.id,
          variant.tenantId,
          variant.programmeId,
          variant.productId,
          variant.name,
          variant.sku,
        ],
      );
    }

    for (const entry of SEED_PRICE_BOOK_ENTRIES) {
      await client.query(
        `INSERT INTO price_book_entry
           (id, tenant_id, programme_id, price_book_id, product_id, variant_id,
            amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8)`,
        [
          entry.id,
          entry.tenantId,
          entry.programmeId,
          entry.priceBookId,
          entry.productId,
          entry.variantId,
          entry.amountMinor,
          entry.currency,
        ],
      );
    }

    for (const quote of SEED_QUOTES) {
      await client.query(
        `INSERT INTO quote
           (id, tenant_id, programme_id, price_book_id, deal_id, contact_id, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')`,
        [
          quote.id,
          quote.tenantId,
          quote.programmeId,
          quote.priceBookId,
          quote.dealId,
          quote.contactId,
          quote.currency,
        ],
      );
    }

    for (const line of SEED_QUOTE_LINES) {
      await client.query(
        `INSERT INTO quote_line
           (id, tenant_id, programme_id, quote_id, product_id, variant_id,
            quantity, unit_amount_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint)`,
        [
          line.id,
          line.tenantId,
          line.programmeId,
          line.quoteId,
          line.productId,
          line.variantId,
          line.quantity,
          line.unitAmountMinor,
        ],
      );
    }


    for (const rule of SEED_APPROVAL_RULES) {
      await client.query(
        `INSERT INTO approval_rule
           (id, tenant_id, programme_id, threshold_bps, approver_permission_set_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          rule.id,
          rule.tenantId,
          rule.programmeId,
          rule.thresholdBps,
          rule.approverPermissionSetKey,
        ],
      );
    }

    for (const script of SEED_SCRIPTS) {
      await client.query(
        `INSERT INTO script
           (id, tenant_id, programme_id, name, source_locale, draft_graph,
            revision, published_revision)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, 1)`,
        [
          script.id,
          script.tenantId,
          script.programmeId,
          script.name,
          script.sourceLocale,
          JSON.stringify(script.graph),
        ],
      );
      await client.query(
        `INSERT INTO script_version
           (id, tenant_id, programme_id, script_id, number, name, source_locale, graph,
            published_by_user_id)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8)`,
        [
          script.versionId,
          script.tenantId,
          script.programmeId,
          script.id,
          script.name,
          script.sourceLocale,
          JSON.stringify(script.graph),
          script.publishedByUserId,
        ],
      );
    }

    await client.query('COMMIT');
    log(
      `seeded ${SEED_TENANTS.length} tenants, ` +
        `${SEED_TENANTS.reduce((n, t) => n + t.programmes.length, 0)} programmes, ` +
        `${SEED_TENANTS.reduce((n, t) => n + t.users.length, 0)} users, ` +
        `${SEED_CONTACTS.length} contacts, ${SEED_ACCOUNTS.length} accounts, ` +
        `${SEED_ACTIVITIES.length} activities, ${SEED_DEALS.length} deals, ` +
        `${SEED_SCRIPTS.length} scripts, ${SEED_TAX_PROFILES.length} tax profiles, ` +
        `${SEED_PRICE_BOOKS.length} price books, ${SEED_PRODUCTS.length} products`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
