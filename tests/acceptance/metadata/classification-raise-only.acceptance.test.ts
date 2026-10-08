import {
  createPool,
  STANDARD_OBJECT_CATALOGUE,
  TENANT_A,
  TENANT_B,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0102: a standard field's classification may be raised, never
 * lowered (Agent 2; D-P25, D-L65).
 *
 * Written from the invariant, before any implementation (D-L23, D-L25).
 *
 * ------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ------------------------------------------------------------------------
 *
 * 1. THE SCALE is `none` < `pii` < `sensitive`. It is not invented here: it is
 *    `classification_rank` in migrations 0025 to 0028 ("weakest first"), and
 *    its values are exactly field_def_classification_check's (0009). The
 *    suite reads the CHECK and fails if it ever admits a value the scale does
 *    not place, so a fourth value cannot arrive without someone deciding
 *    where it ranks. (The three values also sort alphabetically in that
 *    order, so no test here can tell a rank comparison from a text one. Rank
 *    explicitly anyway: the next value will not be so obliging.)
 *
 * 2. THE RULE. An UPDATE of a STANDARD field_def (`is_custom = false`) whose
 *    new classification ranks below its old one is refused, for EVERY role
 *    that can write field_def: kasuwa_app in a real `withTenantTransaction`
 *    (as the tenant admin), kasuwa_migrator and kasuwa_test_admin. The task
 *    says the migrator is exempt only where a migration says so explicitly;
 *    a plain statement is not that, so it is refused like any other. Raising
 *    succeeds; setting the same value is a no-op success (one row, no error).
 *    A CUSTOM field (`is_custom = true`) moves freely in both directions, on
 *    a standard object or a custom one, for every role.
 *
 * 3. THE REFUSAL is SQLSTATE 23514 (check_violation) with the error's
 *    `constraint` field set to `field_def_classification_raise_only`, exactly
 *    as 0026 does for `account_hierarchy` (RAISE ... USING ERRCODE =
 *    'check_violation', CONSTRAINT = '...'). Why that pair:
 *      - a caller (the future admin write) maps it from two machine fields,
 *        never from message text;
 *      - 23001 and 42501 already mean other refusals on this same table
 *        (0025's is_custom, object_id and meaning guards), so a code alone
 *        would not tell a lowering from those;
 *      - 23514 alone would not tell it from field_def_classification_check
 *        (an unknown value); the constraint name does;
 *      - no custom SQLSTATE exists in this codebase, and inventing a class
 *        for one rule is a decision this suite should not make.
 *    The message, detail and hint name no tenant data: no field, object or
 *    tenant id, and not the field's label (labels are tenant-editable, D-P4).
 *
 * 4. ATOMIC. A statement that lowers any standard row changes nothing, even
 *    when it also raises others or touches custom fields.
 *
 * 5. NO BACK DOORS for kasuwa_app: not `SET classification = DEFAULT`, not an
 *    INSERT ... ON CONFLICT DO UPDATE, not a combined is_custom flip, and the
 *    guard cannot be switched off (DISABLE TRIGGER, session_replication_role).
 *
 * 6. RLS STILL APPLIES. A tenant A session touches none of tenant B's
 *    field_def rows, raising or lowering, and a lowering aimed at tenant B's
 *    row looks exactly like one aimed at an id that does not exist (no
 *    refusal: the refusal would be an existence oracle).
 *
 * The standard fields are TABLE-DRIVEN from STANDARD_OBJECT_CATALOGUE
 * (packages/db/src/standard-object-catalogue.ts), so a field or object added
 * there is covered with no edit here.
 *
 * ------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ------------------------------------------------------------------------
 * The migration's number and name (several Phase 2 tasks are racing for the
 * next one); whether the rule extends `app.guard_standard_field_def()` and
 * the `field_def_standard_fixed` WHEN clause (the task's wording) or adds a
 * trigger beside them; the message wording.
 *
 * ------------------------------------------------------------------------
 * NOT TESTED HERE: THE HTTP 400
 * ------------------------------------------------------------------------
 * The task asks that "the admin field-metadata write" map the refusal to a
 * 400 with a stable code. On main no such write exists: nothing outside the
 * migrations UPDATEs field_def (`apps/api/src/admin/field-security` reads
 * definitions and writes field_security_grant only), and the first
 * create-field API is T-0089 (ROADMAP). Pin 3 is what that mapping will key
 * on; the API assertion belongs to whichever task adds the write.
 *
 * Writes: this suite reseeds before each block and when it finishes.
 */

const SCALE = ['none', 'pii', 'sensitive'] as const;
type Classification = (typeof SCALE)[number];
const rank = (value: Classification): number => SCALE.indexOf(value);
const lowerThan = (value: Classification): Classification[] => SCALE.slice(0, rank(value));
const TOP: Classification = 'sensitive';

const RAISE_ONLY = 'field_def_classification_raise_only';
const REFUSED = { outcome: 'refused', code: '23514', constraint: RAISE_ONLY } as const;

/** Unique per run, for the label marker. */
const RUN = Date.now().toString(36);

/** Every standard field, from the catalogue: never a hand list. */
const STANDARD_FIELDS = STANDARD_OBJECT_CATALOGUE.flatMap((object) =>
  object.fields.map((field) => ({
    object: object.apiName,
    field: field.apiName,
    classification: field.classification satisfies Classification,
  })),
);

type Outcome =
  | { outcome: 'refused'; code: string; constraint: string | null; text: string }
  | { outcome: 'no rows' }
  | { outcome: 'applied'; rows: number };

/** Runs one unit of work that commits if it can, and reports what happened. */
async function attempt(run: () => Promise<readonly unknown[]>): Promise<Outcome> {
  try {
    const rows = await run();
    return rows.length === 0 ? { outcome: 'no rows' } : { outcome: 'applied', rows: rows.length };
  } catch (error) {
    const e = error as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      detail?: unknown;
      hint?: unknown;
    };
    return {
      outcome: 'refused',
      code: typeof e.code === 'string' ? e.code : `not a database error: ${String(error)}`,
      constraint: typeof e.constraint === 'string' ? e.constraint : null,
      text: [e.message, e.detail, e.hint].filter((part) => typeof part === 'string').join('\n'),
    };
  }
}

const SET_CLASSIFICATION = 'UPDATE field_def SET classification = $2 WHERE id = $1 RETURNING id';

describe('acceptance: a standard field’s classification is raise-only (T-0102)', () => {
  let observer: Pool; // kasuwa_migrator, BYPASSRLS: reads, plants, and is itself tested
  let appPool: Pool; // kasuwa_app
  let testAdmin: Pool; // kasuwa_test_admin, BYPASSRLS, UPDATE on field_def

  /** One statement as a tenant's user, in a real tenant transaction that commits if it can. */
  const asUser = (tenantId: string, userId: string, sql: string, values: unknown[]) =>
    attempt(() =>
      withTenantTransaction(appPool, { tenantId, userId }, (tx) => tx.query(sql, values)),
    );
  const asAdminA = (sql: string, values: unknown[]) =>
    asUser(TENANT_A, USER_A_SUPERVISOR, sql, values);
  /** One autocommit statement on a pool. */
  const asPool = (pool: Pool, sql: string, values: unknown[]) =>
    attempt(async () => (await pool.query(sql, values)).rows);

  async function fieldId(tenantId: string, objectApi: string, fieldApi: string): Promise<string> {
    const result = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3
          AND NOT o.is_custom AND NOT f.is_custom`,
      [tenantId, objectApi, fieldApi],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error(`T-0102: tenant ${tenantId} has no standard field ${objectApi}.${fieldApi}`);
    }
    return id;
  }

  async function objectId(tenantId: string, objectApi: string): Promise<string> {
    const result = await observer.query<{ id: string }>(
      'SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2',
      [tenantId, objectApi],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`T-0102: tenant ${tenantId} has no object ${objectApi}`);
    return id;
  }

  async function classificationOf(id: string): Promise<string | undefined> {
    const result = await observer.query<{ classification: string }>(
      'SELECT classification FROM field_def WHERE id = $1',
      [id],
    );
    return result.rows[0]?.classification;
  }

  /** Every field_def of a tenant, as committed: `id classification`. */
  async function snapshot(tenantId: string): Promise<string[]> {
    const result = await observer.query<{ row: string }>(
      `SELECT id || ' ' || classification AS row FROM field_def WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    return result.rows.map((row) => row.row);
  }

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
  });

  afterAll(async () => {
    await testAdmin?.end();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  // ---------------------------------------------------------------------------
  // 0. Guards against a vacuous pass. All four hold on main before the work:
  //    they keep the tests below honest, they are not evidence of the work.
  // ---------------------------------------------------------------------------
  describe('what this suite stands on', () => {
    it('field_def_classification_check admits exactly the scale none < pii < sensitive', async () => {
      const result = await observer.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
          WHERE c.conrelid = 'public.field_def'::regclass
            AND c.conname = 'field_def_classification_check'`,
      );
      const def = result.rows[0]?.def;
      expect(def, 'field_def_classification_check is missing').toBeDefined();
      const admitted = [...(def ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);
      expect([...new Set(admitted)].sort()).toEqual([...SCALE].sort());
    });

    it('the catalogue is non-empty, uses only the scale, and is exactly tenant A’s standard fields', async () => {
      expect(STANDARD_OBJECT_CATALOGUE.length).toBeGreaterThanOrEqual(3);
      expect(
        STANDARD_FIELDS.filter((entry) => entry.classification !== 'none').length,
      ).toBeGreaterThan(0);
      for (const entry of STANDARD_FIELDS) expect(SCALE).toContain(entry.classification);

      const inDatabase = await observer.query<{ name: string }>(
        `SELECT o.api_name || '.' || f.api_name AS name
           FROM field_def f
           JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
          WHERE f.tenant_id = $1 AND NOT f.is_custom
          ORDER BY 1`,
        [TENANT_A],
      );
      expect(inDatabase.rows.map((row) => row.name)).toEqual(
        STANDARD_FIELDS.map((entry) => `${entry.object}.${entry.field}`).sort(),
      );
    });

    it('every role that can UPDATE field_def.classification is one this suite tests', async () => {
      // A new writer role must join the "not exempt" table below before it ships.
      // Superusers are outside the model (they can disable any trigger).
      const roles = await observer.query<{ rolname: string }>(
        `SELECT r.rolname FROM pg_roles r
          WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
            AND has_column_privilege(r.oid, 'public.field_def', 'classification', 'UPDATE')
          ORDER BY 1`,
      );
      expect(roles.rows.map((row) => row.rolname)).toEqual([
        'kasuwa_app',
        'kasuwa_migrator',
        'kasuwa_test_admin',
      ]);
    });

    it('adds no SECURITY DEFINER function: the census is still the two CLAUDE.md 2.7 names', async () => {
      const definers = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      );
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Every standard field in the catalogue, as tenant A's admin
  // ---------------------------------------------------------------------------
  describe('every standard field, as kasuwa_app in a tenant transaction', () => {
    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
    });

    it.each(STANDARD_FIELDS.map((entry) => [`${entry.object}.${entry.field}`, entry] as const))(
      '%s: can be raised, never lowered, and set equal',
      async (_name, entry) => {
        const id = await fieldId(TENANT_A, entry.object, entry.field);
        expect(await classificationOf(id)).toBe(entry.classification);

        // Lowering from the catalogue's level (a `none` field has nowhere to go).
        for (const lower of lowerThan(entry.classification)) {
          expect(
            await asAdminA(SET_CLASSIFICATION, [id, lower]),
            `lowering to ${lower}`,
          ).toMatchObject(REFUSED);
          expect(await classificationOf(id)).toBe(entry.classification);
        }

        // Raising to the top succeeds and commits.
        if (entry.classification !== TOP) {
          expect(await asAdminA(SET_CLASSIFICATION, [id, TOP])).toEqual({
            outcome: 'applied',
            rows: 1,
          });
          expect(await classificationOf(id)).toBe(TOP);
        }

        // From the top, every lowering is refused, and nothing changes.
        for (const lower of lowerThan(TOP)) {
          expect(
            await asAdminA(SET_CLASSIFICATION, [id, lower]),
            `lowering ${TOP} to ${lower}`,
          ).toMatchObject(REFUSED);
          expect(await classificationOf(id)).toBe(TOP);
        }

        // Equal is a no-op success.
        expect(await asAdminA(SET_CLASSIFICATION, [id, TOP])).toEqual({
          outcome: 'applied',
          rows: 1,
        });
        expect(await classificationOf(id)).toBe(TOP);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 2. The edges of the rule, as kasuwa_app
  // ---------------------------------------------------------------------------
  describe('the refusal, its edges and its back doors, as kasuwa_app', () => {
    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
    });

    it('setting every standard field to its own value is a success that changes nothing', async () => {
      // A guard that refused any write to the column would fail here.
      const before = await snapshot(TENANT_A);
      expect(
        await asAdminA(
          'UPDATE field_def SET classification = classification WHERE NOT is_custom RETURNING id',
          [],
        ),
      ).toEqual({ outcome: 'applied', rows: STANDARD_FIELDS.length });
      expect(await snapshot(TENANT_A)).toEqual(before);
    });

    it('refuses with 23514 and constraint field_def_classification_raise_only, naming no tenant data', async () => {
      const id = await fieldId(TENANT_A, 'contact', 'emails');
      const contactId = await objectId(TENANT_A, 'contact');
      const marker = `T0102 label ${RUN}`;
      // Labels stay editable (D-P4); plant one so a message that echoes the row shows it.
      expect(
        await asAdminA('UPDATE field_def SET label = $2 WHERE id = $1 RETURNING id', [id, marker]),
      ).toEqual({ outcome: 'applied', rows: 1 });

      const result = await asAdminA(SET_CLASSIFICATION, [id, 'none']);
      expect(result).toMatchObject(REFUSED);
      const text = result.outcome === 'refused' ? result.text : '';
      expect(text.length, 'the refusal carries no message').toBeGreaterThan(0);
      for (const secret of [marker, id, contactId, TENANT_A]) {
        expect(text, 'the refusal echoes tenant data').not.toContain(secret);
      }
      expect(await classificationOf(id)).toBe('pii');
    });

    it('an unknown value is still the CHECK’s refusal, never reported as a lowering', async () => {
      // Passes on main (0009's CHECK). Keeps the two refusals distinguishable.
      const id = await fieldId(TENANT_A, 'contact', 'phones');
      const result = await asAdminA(SET_CLASSIFICATION, [id, 'secret']);
      expect(result).toMatchObject({ outcome: 'refused', code: '23514' });
      expect(result.outcome === 'refused' ? result.constraint : null).not.toBe(RAISE_ONLY);
      expect(await classificationOf(id)).toBe('pii');
    });

    it('lowering by DEFAULT, or through an upsert, is refused the same way', async () => {
      const phones = await fieldId(TENANT_A, 'contact', 'phones');
      const subject = await fieldId(TENANT_A, 'activity', 'subject');

      expect(
        await asAdminA('UPDATE field_def SET classification = DEFAULT WHERE id = $1 RETURNING id', [
          phones,
        ]),
      ).toMatchObject(REFUSED);

      // The proposed row says custom, so the 0025 INSERT policy would admit it;
      // it conflicts with the standard row and takes the UPDATE path instead.
      expect(
        await asAdminA(
          `INSERT INTO field_def
             (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
           SELECT gen_random_uuid(), f.tenant_id, f.object_id, f.api_name, f.label, f.type,
                  'none', f.is_required, true, f.config
             FROM field_def f WHERE f.id = $1
           ON CONFLICT (tenant_id, object_id, api_name)
             DO UPDATE SET classification = EXCLUDED.classification
           RETURNING id`,
          [subject],
        ),
      ).toMatchObject(REFUSED);

      expect(await classificationOf(phones)).toBe('pii');
      expect(await classificationOf(subject)).toBe('pii');
    });

    it('lowering together with an is_custom flip is refused (whichever guard speaks first)', async () => {
      // Passes on main: 0025 refuses the flip. Kept so a rule keyed on
      // NEW.is_custom cannot be combined with a weaker flip guard later.
      const id = await fieldId(TENANT_A, 'account', 'phones');
      const result = await asAdminA(
        `UPDATE field_def SET is_custom = true, classification = 'none' WHERE id = $1 RETURNING id`,
        [id],
      );
      expect(result.outcome).toBe('refused');
      expect(await classificationOf(id)).toBe('pii');
    });

    it('kasuwa_app cannot switch the guard off', async () => {
      // Both hold on main (kasuwa_app owns nothing and is not a superuser):
      // regression guards for the new rule's only bypasses, not evidence of it.
      expect(await asAdminA('ALTER TABLE field_def DISABLE TRIGGER USER', [])).toMatchObject({
        outcome: 'refused',
        code: '42501',
      });
      expect(await asAdminA(`SET LOCAL session_replication_role = 'replica'`, [])).toMatchObject({
        outcome: 'refused',
        code: '42501',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Custom fields stay freely classifiable (holds on main: no over-reach)
  // ---------------------------------------------------------------------------
  describe('custom fields stay freely classifiable', () => {
    const CUSTOM_ON_CONTACT = '11111111-0000-4000-8000-0000010201a1';
    const CUSTOM_OBJECT = '11111111-0000-4000-8000-0000010200a1';
    const CUSTOM_ON_CUSTOM = '11111111-0000-4000-8000-0000010201a2';

    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
      const contactId = await objectId(TENANT_A, 'contact');
      const planted = [
        await asAdminA(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 't0102_site', 'Site', true) RETURNING id`,
          [CUSTOM_OBJECT, TENANT_A],
        ),
        await asAdminA(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
           VALUES ($1, $2, $3, 'loyalty_tier__c', 'Loyalty tier', 'text', 'sensitive', true) RETURNING id`,
          [CUSTOM_ON_CONTACT, TENANT_A, contactId],
        ),
        await asAdminA(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
           VALUES ($1, $2, $3, 'risk_band', 'Risk band', 'text', 'sensitive', true) RETURNING id`,
          [CUSTOM_ON_CUSTOM, TENANT_A, CUSTOM_OBJECT],
        ),
      ];
      expect(planted).toEqual(Array(3).fill({ outcome: 'applied', rows: 1 }));
    });

    it.each([
      ['a custom field on a standard object', CUSTOM_ON_CONTACT],
      ['a custom field on a custom object', CUSTOM_ON_CUSTOM],
    ])('%s moves down and up freely as kasuwa_app', async (_what, id) => {
      for (const next of ['none', 'pii', 'none', 'sensitive', 'pii'] as const) {
        expect(await asAdminA(SET_CLASSIFICATION, [id, next]), `to ${next}`).toEqual({
          outcome: 'applied',
          rows: 1,
        });
        expect(await classificationOf(id)).toBe(next);
      }
    });

    it('a custom field moves down freely as kasuwa_migrator and kasuwa_test_admin too', async () => {
      expect(await asPool(observer, SET_CLASSIFICATION, [CUSTOM_ON_CONTACT, 'sensitive'])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      expect(await asPool(observer, SET_CLASSIFICATION, [CUSTOM_ON_CONTACT, 'none'])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      expect(await asPool(testAdmin, SET_CLASSIFICATION, [CUSTOM_ON_CUSTOM, 'sensitive'])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      expect(await asPool(testAdmin, SET_CLASSIFICATION, [CUSTOM_ON_CUSTOM, 'none'])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      expect(await classificationOf(CUSTOM_ON_CONTACT)).toBe('none');
      expect(await classificationOf(CUSTOM_ON_CUSTOM)).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. No role is exempt
  // ---------------------------------------------------------------------------
  describe('kasuwa_migrator and kasuwa_test_admin are refused too', () => {
    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
    });

    // A field per role, so one role's raise does not decide the other's start.
    it.each([
      ['kasuwa_migrator', 'given_names', () => observer],
      ['kasuwa_test_admin', 'family_name', () => testAdmin],
    ] as const)('%s: may raise and set equal, may not lower', async (_role, field, pool) => {
      const id = await fieldId(TENANT_A, 'contact', field);
      expect(await asPool(pool(), SET_CLASSIFICATION, [id, 'none'])).toMatchObject(REFUSED);
      expect(await classificationOf(id)).toBe('pii');

      expect(await asPool(pool(), SET_CLASSIFICATION, [id, 'pii'])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      expect(await asPool(pool(), SET_CLASSIFICATION, [id, TOP])).toEqual({
        outcome: 'applied',
        rows: 1,
      });
      for (const lower of lowerThan(TOP)) {
        expect(await asPool(pool(), SET_CLASSIFICATION, [id, lower]), `to ${lower}`).toMatchObject(
          REFUSED,
        );
      }
      expect(await classificationOf(id)).toBe(TOP);
    });

    it('kasuwa_migrator lowering every standard field in every tenant at once changes nothing', async () => {
      const before = [await snapshot(TENANT_A), await snapshot(TENANT_B)];
      expect(
        await asPool(
          observer,
          `UPDATE field_def SET classification = 'none' WHERE NOT is_custom RETURNING id`,
          [],
        ),
      ).toMatchObject(REFUSED);
      expect([await snapshot(TENANT_A), await snapshot(TENANT_B)]).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. RLS still applies (holds on main: a guard that the rule adds no oracle)
  // ---------------------------------------------------------------------------
  describe('RLS still applies: one tenant cannot touch another’s field_def', () => {
    const NO_SUCH_FIELD = '00000000-0000-4000-8000-0000010200ff';

    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
    });

    it.each([
      ['tenant A', TENANT_A, USER_A_SUPERVISOR, TENANT_B],
      ['tenant B', TENANT_B, USER_B_AGENT_1, TENANT_A],
    ])(
      '%s raises, lowers and bulk-edits the other tenant’s fields: no rows, no refusal, no change',
      async (_who, tenantId, userId, otherTenant) => {
        const theirs = await fieldId(otherTenant, 'contact', 'phones');
        const theirsNone = await fieldId(otherTenant, 'account', 'name');
        const before = await snapshot(otherTenant);
        const as = (sql: string, values: unknown[]) => asUser(tenantId, userId, sql, values);

        // A lowering aimed at their row must look exactly like one aimed at nothing.
        expect(await as(SET_CLASSIFICATION, [NO_SUCH_FIELD, 'none'])).toEqual({
          outcome: 'no rows',
        });
        expect(await as(SET_CLASSIFICATION, [theirs, 'none'])).toEqual({ outcome: 'no rows' });
        expect(await as(SET_CLASSIFICATION, [theirs, TOP])).toEqual({ outcome: 'no rows' });
        expect(await as(SET_CLASSIFICATION, [theirsNone, 'pii'])).toEqual({ outcome: 'no rows' });
        expect(
          await as(`UPDATE field_def SET classification = $2 WHERE tenant_id = $1 RETURNING id`, [
            otherTenant,
            TOP,
          ]),
        ).toEqual({ outcome: 'no rows' });

        expect(await snapshot(otherTenant)).toEqual(before);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 6. A bulk lowering is refused atomically
  // ---------------------------------------------------------------------------
  describe('a statement that lowers any standard field changes nothing', () => {
    const CUSTOM_A = '11111111-0000-4000-8000-0000010202a1';
    const CUSTOM_B = '11111111-0000-4000-8000-0000010202a2';

    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
      const contactId = await objectId(TENANT_A, 'contact');
      for (const [id, name] of [
        [CUSTOM_A, 'visit_notes__c'],
        [CUSTOM_B, 'credit_band__c'],
      ] as const) {
        expect(
          await asAdminA(
            `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
             VALUES ($1, $2, $3, $4, $4, 'text', 'sensitive', true) RETURNING id`,
            [id, TENANT_A, contactId, name],
          ),
        ).toEqual({ outcome: 'applied', rows: 1 });
      }
    });

    it('lowering every standard field at once is refused, and none moved', async () => {
      const before = await snapshot(TENANT_A);
      expect(
        await asAdminA(
          `UPDATE field_def SET classification = 'none' WHERE NOT is_custom RETURNING id`,
          [],
        ),
      ).toMatchObject(REFUSED);
      expect(await snapshot(TENANT_A)).toEqual(before);
    });

    it('one lowering among many raises is refused, and none of the raises landed', async () => {
      const before = await snapshot(TENANT_A);
      const emails = await fieldId(TENANT_A, 'contact', 'emails');
      expect(
        await asAdminA(
          `UPDATE field_def
              SET classification = CASE WHEN id = $1 THEN 'none'
                                        WHEN classification = 'none' THEN 'pii'
                                        ELSE classification END
            WHERE NOT is_custom
            RETURNING id`,
          [emails],
        ),
      ).toMatchObject(REFUSED);
      expect(await snapshot(TENANT_A)).toEqual(before);
    });

    it('lowering custom fields together with one standard field is refused, and the custom ones kept', async () => {
      const before = await snapshot(TENANT_A);
      const body = await fieldId(TENANT_A, 'activity', 'body');
      expect(
        await asAdminA(
          `UPDATE field_def SET classification = 'none' WHERE id = ANY ($1::uuid[]) RETURNING id`,
          [[CUSTOM_A, CUSTOM_B, body]],
        ),
      ).toMatchObject(REFUSED);
      expect(await snapshot(TENANT_A)).toEqual(before);
      expect(await classificationOf(CUSTOM_A)).toBe('sensitive');
    });
  });
});
