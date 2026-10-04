import { createHash } from 'node:crypto';
import {
  createPool,
  loadMigrations,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import type { Migration, TenantTx } from '@kasuwa/db';
import { readTableSecurity, reseed, withForcedScope } from '@kasuwa/testing';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0040, contact fields and accounts (migration only).
 *
 * Source: team/tasks/T-0040-contact-fields-and-accounts.md, D-L60 item 2,
 * D-L12 (what the slice deferred), D-L13 (NIN/BVN stays out), CLAUDE.md 2.3/2.4,
 * the `contact` table and policy in packages/db/migrations/0001_tenancy_core.sql,
 * and the P04 list-view export (docs/design/P04/) for the value sets.
 *
 * Everything runs against the real migrated database. Behaviour is asserted as
 * `kasuwa_app` (NOBYPASSRLS — what the API runs as), either through
 * `withTenantTransaction` (the legitimate path) or `withForcedScope` (forged
 * GUCs, always rolled back). The catalogue is read as `kasuwa_migrator` through
 * `pg_attribute`/`pg_constraint`, NOT `information_schema`: information_schema
 * only lists columns the current role holds a privilege on, so a column hidden
 * from kasuwa_app would be invisible to the very check meant to find it.
 *
 * THE VALUE SETS (the contract; T-0039/T-0041 must agree with these):
 *   status            new, contacted, qualified, unqualified, customer
 *   source            whatsapp, ussd, web_form, missed_call, import, api,
 *                     manual, referral, walk_in
 *   preferred_channel whatsapp, sms, voice, email
 *   consent_state     unknown, opted_in, pending, withdrawn — NOT NULL, DEFAULT
 *                     'unknown'
 *   preferred_language  a BCP-47 tag, format-checked (see the test for why it is
 *                     not checked against @kasuwa/i18n SUPPORTED_LOCALES)
 * Stored values are snake_case CODES. P04's display labels ("Opted in",
 * "Missed call", "Qualified") are i18n strings and must be rejected by the
 * database, because storing a label is the mistake this most invites.
 * How a set is enforced (CHECK, lookup table + FK, or an enum type) is the
 * builder's call; the probes accept a check, FK or invalid-input rejection.
 *
 * Assumptions, stated so they can be argued with:
 *   - `account` needs only id, tenant_id, programme_id and name on INSERT;
 *     created_at/updated_at default.
 *   - A contact may be inserted naming only id, tenant_id, programme_id and
 *     display_name — every new contact column is nullable or defaulted, which
 *     is also what "existing seeded rows still load" requires.
 *   - owner_user_id and account_id are nullable.
 *
 * Deliberately NOT asserted: ON DELETE behaviour of the new FKs, whether an
 * owner must belong to the contact's programme, phone_network values (PRD Q5,
 * detection is out of scope), indexes, the Drizzle mirror, and whether the
 * seed carries accounts. (It should: T-0011's generic updated_at probe fails
 * on any table with updated_at, no seeded row and no plant.)
 */

// --- value sets --------------------------------------------------------------

const STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'customer'];
const SOURCES = [
  'whatsapp',
  'ussd',
  'web_form',
  'missed_call',
  'import',
  'api',
  'manual',
  'referral',
  'walk_in',
];
const CHANNELS = ['whatsapp', 'sms', 'voice', 'email'];
const CONSENT_STATES = ['unknown', 'opted_in', 'pending', 'withdrawn'];

/**
 * Hand-copied from DESIGN_MENU_LOCALES in packages/i18n/src/catalogues.ts plus
 * the en-NG overlay; @kasuwa/i18n is not a dependency of this package.
 */
const LANGUAGES_ACCEPTED = ['en', 'en-NG', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'];
/** Not BCP-47 under any reading: a display name, underscore, empty, dangling hyphen, one letter, padding. */
const LANGUAGES_REJECTED = ['Yorùbá', 'en_NG', '', 'en-', 'e', ' en'];

// --- fixed ids for rows this suite plants. Nothing seeds them. --------------

const ACCOUNT_A1 = '11111111-0000-4000-8000-00000040a001';
const ACCOUNT_A2 = '11111111-0000-4000-8000-00000040a002';
const ACCOUNT_B1 = '22222222-0000-4000-8000-00000040a003';
const ACCOUNT_SCRATCH = '11111111-0000-4000-8000-00000040a0ff';

// --- migrations as they stood on origin/main (d31a22e) before T-0040 ---------
// Checksums computed exactly as loadMigrations() does (CRLF -> LF, sha256).
// Append a row when a new migration merges; never edit one.

const PINNED_MIGRATIONS: readonly (readonly [string, string])[] = [
  ['0000_app_session_context', '82b5db8a63cf2a3b29ddd86a050beb50a01f6611365b09a81c5816663d8194f2'],
  ['0001_tenancy_core', 'ae037c3ef279589f7b3d326b4ce62e63e23f5ce4e0b67a61f3debee0fdc52a89'],
  ['0002_authentication', 'd78e5259b07aa08883bc851b5ad486a735d63cf3e54e5df4a00445ee0ca1723e'],
  [
    '0002_metadata_object_and_field_def',
    'c9e460a978e152a691b30f8f8e7d8525a40a67fa1ab270c019f789a1b34617dd',
  ],
  [
    '0003_authentication_hardening',
    '52dafd02d9463c4ac65fe0c05e6bd5427f1283c0ed3e1758c9f7412b591b9a8e',
  ],
  ['0004_rate_limit_key_scope', 'ee4e5993946676bbd076d95daf7ad132f1076dbc83014141f42399dcae5e6e60'],
  ['0005_mfa_secret_envelope', '669039e8bde5ef1b40a5966f2b39205ada466caeefb1677754acaa8b46a0acbc'],
  [
    '0006_roles_and_permission_sets',
    '24d1d6c198f41bbd2cabf256147dc357c4a55a9a1b917f06043f690db707e42e',
  ],
  [
    '0007_metadata_api_name_immutable_no_nin',
    'bfdf3b79b10555f4826aa358b1fa281a9d471029e519666bb793eb3cd4b8d3a7',
  ],
  ['0008_audit_event', '5508ad9ea21ddfe2c08796783872dd5d9045169cb8add6bd07168c761f2492d8'],
  [
    '0009_field_security_matrix',
    'dec9b9ccbb3a084316bd3223e7bffa152378e6705fc716a43adcd930709548b3',
  ],
  ['0010_disposition', '914edfeadb24e17db06cf26d5f4154f0c5afe7c71fae1c398a6a7aa4c4c4e764'],
  [
    '0011_programme_sla_retention',
    'b5deab2088a71da450c89bfb38f5aa11c2a9a52b4e69b2890e909aa283a28b5f',
  ],
  [
    '0012_programme_status_and_insert_policy',
    '5eebdb0032bae361ed65d812a6f2bb4217834e0cb5800ef0d6fad53b8d31ce6e',
  ],
  ['0013_portal_user', 'da432e9836646a39cf0ea38bc7e2889be7668d4939cb4f2639f3b6a09d5f0af0'],
  ['0014_admin_alert', '364f1d50b31e2d3c7ef2c85a9c47f330480ef00e406a3b2588d02a94b600b38a'],
  ['0015_permissions_engine', 'a87e80391f5aa13cb4020a813e06c06415359b9193c40afd5851455e308dd2e6'],
  [
    '0016_tenant_column_privileges',
    '8d4f58e409cb18e1348eb3351f49c6b446971740955542a51743b8d39eb87bec',
  ],
  [
    '0017_mfa_enrolment_and_backup_codes',
    '380d1cef45873adbf2f5b1e332e7bac0805e6fde393c89dfa49eae7b17e8ec2b',
  ],
];

/** Every way an applied migration can stop being what was applied. */
function migrationDrift(
  current: readonly Pick<Migration, 'id' | 'checksum'>[],
  pinned: readonly (readonly [string, string])[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(current.map((migration) => [migration.id, migration.checksum]));
  for (const [id, checksum] of pinned) {
    const now = byId.get(id);
    if (now === undefined) problems.push(`${id}: removed or renamed`);
    else if (now !== checksum) problems.push(`${id}: edited (checksum ${now}, pinned ${checksum})`);
  }
  const lastPinned =
    pinned
      .map(([id]) => id)
      .sort()
      .pop() ?? '';
  const pinnedIds = new Set(pinned.map(([id]) => id));
  for (const { id } of current) {
    if (!pinnedIds.has(id) && id < lastPinned) {
      problems.push(`${id}: new, but sorts before ${lastPinned}, so it runs out of order`);
    }
  }
  return problems;
}

// --- probing helpers -----------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

const SQLSTATE: Record<string, string> = {
  '23503': 'foreign_key_violation',
  '23514': 'check_violation',
  '23502': 'not_null_violation',
  '22P02': 'invalid_input',
  '42501': 'rls_or_privilege_violation',
};

function classify(error: unknown): string {
  const { code, message } = error as { code?: string; message?: string };
  if (code !== undefined && SQLSTATE[code] !== undefined) return SQLSTATE[code];
  // Anything else — notably 42703 undefined column and 42P01 undefined table —
  // is surfaced verbatim so the failure says exactly what is missing.
  return `error ${code ?? '?'}: ${message ?? String(error)}`;
}

/** Runs one statement under a savepoint, so a rejection does not abort the probe. */
async function attempt(query: Query, sql: string, values: unknown[] = []): Promise<string> {
  await query('SAVEPOINT t0040_probe');
  try {
    await query(sql, values);
    await query('RELEASE SAVEPOINT t0040_probe');
    return 'accepted';
  } catch (error) {
    await query('ROLLBACK TO SAVEPOINT t0040_probe');
    return classify(error);
  }
}

/** A value-set rejection may arrive as a CHECK, a lookup FK or an enum's invalid input. */
const asVerdict = (outcome: string) =>
  ['check_violation', 'foreign_key_violation', 'invalid_input'].includes(outcome)
    ? 'rejected'
    : outcome;

const insertContactWith = (column: string) =>
  `INSERT INTO contact (id, tenant_id, programme_id, display_name, ${column})
   VALUES (gen_random_uuid(), $1, $2, 'T-0040 probe', $3)`;

const INSERT_ACCOUNT = `INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)`;

/** Repoints the forged GUCs mid-transaction — only the harness can do this. */
const forceScope = (query: Query, tenantId: string, programmeIds: readonly string[]) =>
  query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.programme_ids', $2, true)`, [
    tenantId,
    `{${programmeIds.join(',')}}`,
  ]);

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction, but nothing commits: the callback's value is carried out by a throw. */
async function rolledBackTenantTx<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

/** The same savepoint probe, through a legitimate tenant transaction. */
async function attemptTx(tx: TenantTx, sql: string, values: unknown[] = []): Promise<string> {
  return attempt((text, params) => tx.query(text, params), sql, values);
}

interface ColumnInfo {
  column: string;
  type: string;
  notnull: boolean;
}

interface ForeignKey {
  name: string;
  refTable: string;
  /** "local->referenced", sorted, so column order inside the key does not matter. */
  pairs: string[];
}

// -----------------------------------------------------------------------------

describe('acceptance: contact fields and accounts (T-0040)', () => {
  /** kasuwa_app — NOBYPASSRLS. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema. Catalogue reads and the detector probe only. */
  let migrator: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  async function columnsOf(table: string, client?: PoolClient): Promise<ColumnInfo[]> {
    const runner: Pick<Pool, 'query'> = client ?? migrator;
    const result = await runner.query<ColumnInfo>(
      `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );
    return result.rows;
  }

  async function foreignKeysOf(table: string): Promise<ForeignKey[]> {
    const result = await migrator.query<{ name: string; ref_table: string; pairs: string[] }>(
      `SELECT con.conname AS name, ref.relname AS ref_table,
              array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
         FROM pg_constraint con
         JOIN pg_class ref ON ref.oid = con.confrelid
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
         JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
         JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
        WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.' || $1)
        GROUP BY con.conname, ref.relname`,
      [table],
    );
    return result.rows.map((row) => ({
      name: row.name,
      refTable: row.ref_table,
      pairs: [...row.pairs].sort(),
    }));
  }

  // --- 1. contact: the catalogue -------------------------------------------

  describe('contact gains the M3 columns', () => {
    it('every new column exists with the right type and nullability', async () => {
      const columns = new Map((await columnsOf('contact')).map((row) => [row.column, row]));
      expect(columns.size, 'contact not found in the catalogue').toBeGreaterThan(0);

      // [column, expected type or null when the enforcement style is the builder's, NOT NULL?]
      const expected: readonly (readonly [string, string | null, boolean])[] = [
        ['owner_user_id', 'uuid', false],
        ['status', null, false],
        ['source', null, false],
        ['tags', 'text[]', false],
        ['preferred_language', 'text', false],
        ['preferred_channel', null, false],
        ['state', 'text', false],
        ['lga', 'text', false],
        ['dnd', 'boolean', true],
        ['whatsapp_opt_in', 'boolean', true],
        ['consent_state', null, true],
        ['phone_network', 'text', false],
        ['account_id', 'uuid', false],
      ];

      const problems: string[] = [];
      for (const [name, type, notnull] of expected) {
        const column = columns.get(name);
        if (column === undefined) {
          problems.push(`${name}: missing`);
          continue;
        }
        if (type !== null && column.type !== type) {
          problems.push(`${name}: type ${column.type}, expected ${type}`);
        }
        // Only NOT NULL is demanded where it is listed; elsewhere nullable is
        // required, because existing rows have no value to give.
        if (column.notnull !== notnull) {
          problems.push(
            `${name}: ${column.notnull ? 'NOT NULL' : 'nullable'}, expected ${notnull ? 'NOT NULL' : 'nullable'}`,
          );
        }
      }
      expect(problems, 'contact columns that do not match T-0040').toEqual([]);
    });

    it('owner_user_id references "user" through (tenant_id, owner_user_id)', async () => {
      const fks = await foreignKeysOf('contact');
      expect(
        fks.filter((fk) => fk.refTable === 'user').map((fk) => fk.pairs),
        `contact FKs found: ${JSON.stringify(fks)}`,
      ).toContainEqual(['owner_user_id->id', 'tenant_id->tenant_id']);
    });

    it('account_id references account through (tenant_id, programme_id, account_id)', async () => {
      const fks = await foreignKeysOf('contact');
      expect(
        fks.filter((fk) => fk.refTable === 'account').map((fk) => fk.pairs),
        `contact FKs found: ${JSON.stringify(fks)}`,
      ).toContainEqual(['account_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id']);
    });
  });

  // --- 1. contact: behaviour as kasuwa_app ----------------------------------

  describe('contact columns hold their invariants against kasuwa_app', () => {
    const A1_SCOPE = { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] };

    it('a new contact gets dnd=false, whatsapp_opt_in=false, consent_state=unknown by default', async () => {
      const row = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const rows = await query<{
          dnd: unknown;
          whatsapp_opt_in: unknown;
          consent_state: unknown;
          account_id: unknown;
        }>(
          `INSERT INTO contact (id, tenant_id, programme_id, display_name)
           VALUES (gen_random_uuid(), $1, $2, 'T-0040 defaults')
           RETURNING dnd, whatsapp_opt_in, consent_state, account_id`,
          [TENANT_A, PROGRAMME_A1],
        );
        return rows[0];
      });
      // Never default to consent. A contact nobody asked is not opted in, and
      // NULL is refused because `consent_state <> 'opted_in'` silently drops
      // NULL rows from exactly the "not consented" filters NDPA cares about.
      expect(row).toEqual({
        dnd: false,
        whatsapp_opt_in: false,
        consent_state: 'unknown',
        account_id: null,
      });
    });

    it('dnd, whatsapp_opt_in and consent_state refuse an explicit NULL', async () => {
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const result: Record<string, string> = {};
        for (const column of ['dnd', 'whatsapp_opt_in', 'consent_state']) {
          result[column] = await attempt(query, insertContactWith(column), [
            TENANT_A,
            PROGRAMME_A1,
            null,
          ]);
        }
        return result;
      });
      expect(outcomes).toEqual({
        dnd: 'not_null_violation',
        whatsapp_opt_in: 'not_null_violation',
        consent_state: 'not_null_violation',
      });
    });

    async function probeValues(column: string, values: readonly string[]) {
      return withForcedScope(appPool, A1_SCOPE, async (query) => {
        const result: Record<string, string> = {};
        for (const value of values) {
          result[value] = asVerdict(
            await attempt(query, insertContactWith(column), [TENANT_A, PROGRAMME_A1, value]),
          );
        }
        return result;
      });
    }

    const verdicts = (accepted: readonly string[], rejected: readonly string[]) =>
      Object.fromEntries([
        ...accepted.map((value) => [value, 'accepted']),
        ...rejected.map((value) => [value, 'rejected']),
      ]);

    it.each([
      // P04's display labels and near-misses must all be refused: the store is
      // codes, never labels, never a case variant.
      ['status', STATUSES, ['Qualified', 'customer ', 'bogus_status', '']],
      ['source', SOURCES, ['WhatsApp', 'Missed call', 'missed-call', 'sms_blast', '']],
      ['preferred_channel', CHANNELS, ['WhatsApp', 'ussd', 'telegram', '']],
      ['consent_state', CONSENT_STATES, ['Opted in', 'opted-in', 'yes', '']],
    ] as const)('%s accepts exactly its documented codes', async (column, accepted, rejected) => {
      expect(await probeValues(column, [...accepted, ...rejected])).toEqual(
        verdicts(accepted, rejected),
      );
    });

    it('preferred_language accepts BCP-47 tags and refuses anything else', async () => {
      // A FORMAT check, not membership of @kasuwa/i18n SUPPORTED_LOCALES. That
      // list is derived from which UI catalogues are complete and attested
      // (T-0009) — it says what Kasuwa's screens can render, not what a
      // customer speaks. A Hausa speaker is a Hausa speaker before the Hausa
      // catalogue is signed off, and a DB CHECK cannot follow a derived list.
      expect(
        await probeValues('preferred_language', [...LANGUAGES_ACCEPTED, ...LANGUAGES_REJECTED]),
      ).toEqual(verdicts(LANGUAGES_ACCEPTED, LANGUAGES_REJECTED));
    });

    it('tags, state, lga and phone_network store free text', async () => {
      const row = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const rows = await query<Record<string, unknown>>(
          `INSERT INTO contact (id, tenant_id, programme_id, display_name, tags, state, lga, phone_network)
           VALUES (gen_random_uuid(), $1, $2, 'T-0040 text', $3, 'Lagos', 'Ikeja', 'MTN')
           RETURNING tags, state, lga, phone_network`,
          [TENANT_A, PROGRAMME_A1, ['Q4 promo', 'Lagos expo']],
        );
        return rows[0];
      });
      expect(row).toEqual({
        tags: ['Q4 promo', 'Lagos expo'],
        state: 'Lagos',
        lga: 'Ikeja',
        phone_network: 'MTN',
      });
    });

    it('an owner from another tenant is impossible, even though the id is real', async () => {
      // Referential checks bypass RLS, so a plain FK on owner_user_id alone
      // would accept tenant B's user. Only the composite key refuses it.
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => ({
        sameTenant: await attempt(query, insertContactWith('owner_user_id'), [
          TENANT_A,
          PROGRAMME_A1,
          USER_A_AGENT_1,
        ]),
        otherTenant: await attempt(query, insertContactWith('owner_user_id'), [
          TENANT_A,
          PROGRAMME_A1,
          USER_B_AGENT_1,
        ]),
      }));
      expect(outcomes).toEqual({ sameTenant: 'accepted', otherTenant: 'foreign_key_violation' });
    });

    it('an account from a sibling programme or another tenant is impossible', async () => {
      const outcomes = await withForcedScope(
        appPool,
        { tenantId: TENANT_B, programmeIds: [PROGRAMME_B1] },
        async (query) => {
          // Plant an account in tenant B, then become tenant A — something only
          // a forged session can do — and plant A1 and A2 accounts.
          const plantB = await attempt(query, INSERT_ACCOUNT, [
            ACCOUNT_B1,
            TENANT_B,
            PROGRAMME_B1,
            'Kilimani Traders',
          ]);
          await forceScope(query, TENANT_A, [PROGRAMME_A1, PROGRAMME_A2]);
          const plantA1 = await attempt(query, INSERT_ACCOUNT, [
            ACCOUNT_A1,
            TENANT_A,
            PROGRAMME_A1,
            'Ikeja Wholesale',
          ]);
          const plantA2 = await attempt(query, INSERT_ACCOUNT, [
            ACCOUNT_A2,
            TENANT_A,
            PROGRAMME_A2,
            'Kano Textiles',
          ]);
          // The session can see both A programmes, so RLS is not what refuses
          // the sibling link below. Only the key can.
          return {
            plantB,
            plantA1,
            plantA2,
            sameProgramme: await attempt(query, insertContactWith('account_id'), [
              TENANT_A,
              PROGRAMME_A1,
              ACCOUNT_A1,
            ]),
            siblingProgramme: await attempt(query, insertContactWith('account_id'), [
              TENANT_A,
              PROGRAMME_A1,
              ACCOUNT_A2,
            ]),
            otherTenant: await attempt(query, insertContactWith('account_id'), [
              TENANT_A,
              PROGRAMME_A1,
              ACCOUNT_B1,
            ]),
          };
        },
      );
      expect(outcomes).toEqual({
        plantB: 'accepted',
        plantA1: 'accepted',
        plantA2: 'accepted',
        sameProgramme: 'accepted',
        siblingProgramme: 'foreign_key_violation',
        otherTenant: 'foreign_key_violation',
      });
    });

    it('existing seeded contacts still load, with the defaults applied', async () => {
      const load = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
          tx.query<{
            id: string;
            dnd: boolean;
            whatsapp_opt_in: boolean;
            consent_state: string;
            account_id: string | null;
            status: string | null;
            source: string | null;
            tags: string[] | null;
          }>(
            `SELECT id, dnd, whatsapp_opt_in, consent_state, account_id, status, source, tags
               FROM contact WHERE tenant_id = $1 ORDER BY id`,
            [tenantId],
          ),
        );
      const rows = [
        ...(await load(TENANT_A, USER_A_SUPERVISOR)),
        ...(await load(TENANT_B, USER_B_AGENT_1)),
      ];

      // Supervisor sees A1+A2 (6), tenant B's agent sees B1 (3).
      const reachable = SEED_CONTACTS.filter((row) =>
        [PROGRAMME_A1, PROGRAMME_A2, PROGRAMME_B1].includes(row.programmeId),
      );
      expect(rows.map((row) => row.id).sort()).toEqual(reachable.map((row) => row.id).sort());

      for (const row of rows) {
        expect(row.dnd, `${row.id}.dnd`).toBe(false);
        expect(row.whatsapp_opt_in, `${row.id}.whatsapp_opt_in`).toBe(false);
        expect(row.consent_state, `${row.id}.consent_state`).toBe('unknown');
        expect(row.account_id, `${row.id}.account_id`).toBeNull();
        // The migration cannot know these; any default it picks must be a member.
        if (row.status !== null) expect(STATUSES, `${row.id}.status`).toContain(row.status);
        if (row.source !== null) expect(SOURCES, `${row.id}.source`).toContain(row.source);
        if (row.tags !== null) expect(row.tags, `${row.id}.tags`).toEqual([]);
      }
    });
  });

  // --- 2. account: the catalogue ---------------------------------------------

  describe('account is a programme-scoped table like contact', () => {
    it('has id, tenant_id, programme_id, name, created_at and updated_at', async () => {
      const columns = new Map((await columnsOf('account')).map((row) => [row.column, row]));
      expect(columns.size, 'table account does not exist').toBeGreaterThan(0);
      const expected: readonly (readonly [string, string])[] = [
        ['id', 'uuid'],
        ['tenant_id', 'uuid'],
        ['programme_id', 'uuid'],
        ['name', 'text'],
        ['created_at', 'timestamp with time zone'],
        ['updated_at', 'timestamp with time zone'],
      ];
      const problems: string[] = [];
      for (const [name, type] of expected) {
        const column = columns.get(name);
        if (column === undefined) problems.push(`${name}: missing`);
        else {
          if (column.type !== type) problems.push(`${name}: type ${column.type}, expected ${type}`);
          if (!column.notnull) problems.push(`${name}: nullable, expected NOT NULL`);
        }
      }
      expect(problems, 'account columns that do not match T-0040').toEqual([]);
    });

    it('has no NIN or BVN column, and neither does contact (D-L13)', async () => {
      const identityColumns = async (tables: readonly string[], client?: PoolClient) => {
        const found: string[] = [];
        for (const table of tables) {
          for (const { column } of await columnsOf(table, client)) {
            if (/(^|_)(nin|bvn)(_|$)/i.test(column)) found.push(`${table}.${column}`);
          }
        }
        return found;
      };

      // The detector, proven on a throwaway table in a rolled-back transaction:
      // it must flag the identifiers and spare words that merely contain "nin".
      const client = await migrator.connect();
      let planted: string[];
      try {
        await client.query('BEGIN');
        await client.query(
          `CREATE TABLE t0040_identity_probe (
             id uuid, nin_token text, bvn_hash bytea, running_total int, opening_balance int)`,
        );
        planted = await identityColumns(['t0040_identity_probe'], client);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(planted).toEqual(['t0040_identity_probe.nin_token', 't0040_identity_probe.bvn_hash']);

      // Without this, the check below holds trivially on a database where
      // account does not exist yet.
      expect((await columnsOf('account')).length, 'table account does not exist').toBeGreaterThan(
        0,
      );
      expect(await identityColumns(['contact', 'account'])).toEqual([]);
    });

    it('references programme through (tenant_id, programme_id)', async () => {
      const fks = await foreignKeysOf('account');
      expect(
        fks.filter((fk) => fk.refTable === 'programme').map((fk) => fk.pairs),
        `account FKs found: ${JSON.stringify(fks)}`,
      ).toContainEqual(['programme_id->id', 'tenant_id->tenant_id']);
    });

    it('is listed in TENANT_SCOPED_TABLES', () => {
      expect([...TENANT_SCOPED_TABLES]).toContain('account');
    });

    it('has RLS enabled and FORCED, every policy scoped on tenant AND programme, WITH CHECK = USING', async () => {
      const security = (await readTableSecurity(appPool)).find((row) => row.table === 'account');
      expect(security, 'account: not reported by readTableSecurity').toBeDefined();
      expect(security?.rlsEnabled, 'account: RLS is not enabled').toBe(true);
      expect(security?.rlsForced, 'account: RLS is not FORCED').toBe(true);

      const policies = await migrator.query<{
        name: string;
        permissive: boolean;
        using: string | null;
        check: string | null;
      }>(
        `SELECT p.polname AS name, p.polpermissive AS permissive,
                pg_get_expr(p.polqual, p.polrelid) AS using,
                pg_get_expr(p.polwithcheck, p.polrelid) AS check
           FROM pg_policy p
          WHERE p.polrelid = to_regclass('public.account')`,
      );
      expect(policies.rows.length, 'account: has no policy').toBeGreaterThan(0);

      // Permissive policies OR together: one tenant-only policy beside a
      // correct one would widen every A1 session to all of tenant A.
      for (const policy of policies.rows.filter((row) => row.permissive)) {
        for (const [clause, expression] of [
          ['USING', policy.using],
          ['WITH CHECK', policy.check],
        ] as const) {
          if (expression === null) continue;
          expect(expression, `account.${policy.name} ${clause}`).toContain('current_tenant_id()');
          expect(expression, `account.${policy.name} ${clause}`).toContain(
            'current_programme_ids()',
          );
        }
      }
      expect(
        policies.rows.filter((row) => row.check !== null && row.check === row.using).length,
        'account: no policy with WITH CHECK identical to USING',
      ).toBeGreaterThan(0);
    });

    it('advances updated_at on an UPDATE that does not name it (T-0011 policy)', async () => {
      const result = await withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
        async (query) => {
          // Back-dated, so a maintained updated_at := now() (the transaction
          // start) lands inside the window below and an unmaintained one does
          // not. Compared in SQL, never as a JS Date (millisecond truncation).
          await query(
            `INSERT INTO account (id, tenant_id, programme_id, name, updated_at)
             VALUES ($1, $2, $3, 'Before', now() - interval '1 minute')`,
            [ACCOUNT_SCRATCH, TENANT_A, PROGRAMME_A1],
          );
          const rows = await query<{ advanced: boolean }>(
            `UPDATE account SET name = 'After' WHERE tenant_id = $1 AND id = $2
             RETURNING updated_at > now() - interval '30 seconds' AS advanced`,
            [TENANT_A, ACCOUNT_SCRATCH],
          );
          return rows[0]?.advanced;
        },
      );
      expect(result, 'account.updated_at did not move on UPDATE').toBe(true);
    });
  });

  // --- 2. account: isolation through the legitimate path ---------------------

  describe('account isolation as kasuwa_app in withTenantTransaction', () => {
    // Committed plants, one per programme, removed by the reseed in afterAll
    // (TRUNCATE tenant CASCADE reaches every table that references it).
    beforeAll(async () => {
      await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          await tx.query(INSERT_ACCOUNT, [ACCOUNT_A1, TENANT_A, PROGRAMME_A1, 'Ikeja Wholesale']);
          await tx.query(INSERT_ACCOUNT, [ACCOUNT_A2, TENANT_A, PROGRAMME_A2, 'Kano Textiles']);
        },
      );
      await withTenantTransaction(
        appPool,
        { tenantId: TENANT_B, userId: USER_B_AGENT_1 },
        async (tx) => {
          await tx.query(INSERT_ACCOUNT, [ACCOUNT_B1, TENANT_B, PROGRAMME_B1, 'Kilimani Traders']);
        },
      );
    });

    afterAll(async () => {
      await reseed(inject('migrationUrl'));
    });

    const PLANTS = [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1];

    /** Which of the planted accounts a session can see, with no WHERE beyond the id list. */
    const visiblePlants = (tenantId: string, userId: string) =>
      withTenantTransaction(appPool, { tenantId, userId }, async (tx) => {
        const rows = await tx.query<{ id: string }>(
          'SELECT id FROM account WHERE id = ANY ($1::uuid[]) ORDER BY id',
          [PLANTS],
        );
        return rows.map((row) => row.id);
      });

    it('a multi-programme supervisor sees both of tenant A’s accounts (the positive control)', async () => {
      expect(await visiblePlants(TENANT_A, USER_A_SUPERVISOR)).toEqual([ACCOUNT_A1, ACCOUNT_A2]);
    });

    it('a session scoped to A1 sees the A1 account and not the A2 one', async () => {
      expect(await visiblePlants(TENANT_A, USER_A_AGENT_1)).toEqual([ACCOUNT_A1]);
    });

    it('tenant B sees none of tenant A’s accounts, only its own', async () => {
      expect(await visiblePlants(TENANT_B, USER_B_AGENT_1)).toEqual([ACCOUNT_B1]);
    });

    it('a user with no programme sees no account at all', async () => {
      const count = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_NO_PROGRAMME },
        async (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM account'),
      );
      expect(count[0]?.n).toBe(0);
    });

    it('a session scoped to A1 can write in A1 but not insert, move or touch anything in A2', async () => {
      const outcomes = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (tx) => ({
        insertInA1: await attemptTx(tx, INSERT_ACCOUNT, [
          ACCOUNT_SCRATCH,
          TENANT_A,
          PROGRAMME_A1,
          'Allowed',
        ]),
        insertInA2: await attemptTx(tx, INSERT_ACCOUNT, [
          '11111111-0000-4000-8000-00000040a0fe',
          TENANT_A,
          PROGRAMME_A2,
          'Smuggled',
        ]),
        moveA1ToA2: await attemptTx(
          tx,
          'UPDATE account SET programme_id = $1 WHERE tenant_id = $2 AND id = $3',
          [PROGRAMME_A2, TENANT_A, ACCOUNT_A1],
        ),
        renameA2: (
          await tx.query(
            `UPDATE account SET name = 'Renamed' WHERE tenant_id = $1 AND id = $2 RETURNING id`,
            [TENANT_A, ACCOUNT_A2],
          )
        ).length,
        deleteA2: (
          await tx.query('DELETE FROM account WHERE tenant_id = $1 AND id = $2 RETURNING id', [
            TENANT_A,
            ACCOUNT_A2,
          ])
        ).length,
      }));
      expect(outcomes).toEqual({
        insertInA1: 'accepted',
        insertInA2: 'rls_or_privilege_violation',
        moveA1ToA2: 'rls_or_privilege_violation',
        renameA2: 0,
        deleteA2: 0,
      });
      // And the A2 account is untouched, seen by someone who may see it.
      const name = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) =>
          tx.query<{ name: string }>('SELECT name FROM account WHERE id = $1', [ACCOUNT_A2]),
      );
      expect(name).toEqual([{ name: 'Kano Textiles' }]);
    });

    it('tenant B cannot insert an account into tenant A', async () => {
      const outcome = await rolledBackTenantTx(appPool, TENANT_B, USER_B_AGENT_1, async (tx) =>
        attemptTx(tx, INSERT_ACCOUNT, [ACCOUNT_SCRATCH, TENANT_A, PROGRAMME_A1, 'Smuggled']),
      );
      expect(outcome).toBe('rls_or_privilege_violation');
    });

    it('forged GUCs naming tenant A with tenant B’s programme see nothing', async () => {
      const ids = await withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_B1] },
        async (query) => query<{ id: string }>('SELECT id FROM account'),
      );
      expect(ids).toEqual([]);
    });
  });

  // --- 4. append-only ----------------------------------------------------------

  describe('the migration is append-only', () => {
    it('the drift check itself catches an edited, a removed and an out-of-order migration', () => {
      const real = loadMigrations();
      const edited = real.map((migration) =>
        migration.id === '0001_tenancy_core'
          ? {
              ...migration,
              checksum: createHash('sha256')
                .update(`${migration.sql}\nALTER TABLE contact ADD COLUMN status text;\n`)
                .digest('hex'),
            }
          : migration,
      );
      const withoutOne = real.filter((migration) => migration.id !== '0010_disposition');
      const outOfOrder = [...real, { id: '0005_contact_fields', checksum: 'x' }];

      expect(migrationDrift(edited, PINNED_MIGRATIONS)).toEqual([
        expect.stringMatching(/^0001_tenancy_core: edited/),
      ]);
      expect(migrationDrift(withoutOne, PINNED_MIGRATIONS)).toEqual([
        '0010_disposition: removed or renamed',
      ]);
      expect(migrationDrift(outOfOrder, PINNED_MIGRATIONS)).toEqual([
        expect.stringMatching(/^0005_contact_fields: new, but sorts before 0017_/),
      ]);
    });

    it('no migration that existed before T-0040 has changed, and new ones sort last', () => {
      // Holds on main by construction — it guards the change, not the start.
      expect(migrationDrift(loadMigrations(), PINNED_MIGRATIONS)).toEqual([]);
    });
  });
});
