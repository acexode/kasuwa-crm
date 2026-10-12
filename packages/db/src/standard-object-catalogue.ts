import { ensureDefaultPipelines } from './default-pipeline';
import { newId } from './ids';

/**
 * The standard objects every tenant starts with, as metadata rows (T-0053;
 * D-L69 answers M15 Q10: standard objects are `object_def` / `field_def`
 * rows, marked standard by `is_custom = false`).
 *
 * ONE list, read by two writers, exactly as DEFAULT_PERMISSION_SET_CATALOGUE:
 * the seed (`runSeed`) and tenant provisioning (`provisionTenant` in
 * `@kasuwa/domain-core/provisioning`). Tenants that existed before the rows
 * did were backfilled by migration 0025 (contact, account `name`), 0026
 * (T-0054, the account fields after `name`), 0027 (T-0060, activity),
 * 0028 (T-0076, contact `company_name`) and 0034 (T-0082, activity
 * `starts_at` and `ends_at`) and 0036 (T-0106, deal), each carrying a frozen
 * copy of its part of this list; the T-0053, T-0054, T-0060, T-0076 and T-0106 acceptance suites
 * assert that all three sources produce the same catalogue. Never edit any of
 * those migrations.
 *
 * ADDING A STANDARD FIELD (or object):
 *   1. add it here;
 *   2. in a NEW migration, FIRST check for clashes: any tenant that already has
 *      a field of that api_name on that object (a tenant's own custom field)
 *      must stop the migration with a RAISE naming the object, the field and
 *      the number of tenants affected, before anything is inserted. A custom
 *      field cannot silently become standard (0025's trigger refuses it), and
 *      which one wins is a human decision, not a migration's;
 *   3. then INSERT the new rows for every tenant, `is_custom = false`, as the
 *      migrator (kasuwa_app may insert custom definitions only, 0025);
 *   4. end with a check that every tenant has every catalogue entry, and that
 *      nothing standard falls outside the catalogue, as 0025's does.
 *
 * DEPLOY WINDOW. A tenant provisioned by the previous release between `pnpm
 * db:migrate` and the new release's rollout gets no standard rows. Either do
 * not provision in that window, or call `ensureStandardObjectDefs` for every
 * tenant after rollout; it is idempotent.
 *
 * Field api_names are the snake_case of the records contract's wire names
 * (`givenNames` -> `given_names`, S3). `contact` carries the properties field
 * security may withhold (WITHHOLDABLE_CONTACT_FIELDS in @kasuwa/domain-core,
 * whose unit test pins the two lists together); the never-withheld ones would
 * be matrix rows that do nothing. `account` carries its business columns.
 *
 * Types: the closest P0 type that needs no per-type configuration, except
 * `account_id` and `parent_account_id`, real lookups to `account`. Enumerated
 * values (status, source, channel, consent, account tier) are `text` rather
 * than `picklist`: their values live in the contract and the column CHECKs,
 * and copying them into `config` would be a third list to drift.
 * `owner_user_id` is `text` because there is no `user` object definition to
 * look up (and `user` is a reserved api_name).
 *
 * Metadata is tenant-scoped, NOT programme-scoped (0002 header): nothing here
 * carries a programme.
 */

/** The subset of metadata-engine's FIELD_TYPES the standard catalogue uses. */
export type StandardFieldType =
  'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'phone' | 'email' | 'boolean' | 'lookup';
export type StandardFieldClassification = 'none' | 'pii' | 'sensitive';

export interface StandardFieldDef {
  readonly apiName: string;
  readonly label: string;
  readonly type: StandardFieldType;
  readonly classification: StandardFieldClassification;
  readonly isRequired: boolean;
  readonly config: Readonly<Record<string, string>>;
}

export interface StandardObjectDef {
  readonly apiName: string;
  readonly label: string;
  readonly pluralLabel: string;
  readonly fields: readonly StandardFieldDef[];
}

const field = (
  apiName: string,
  label: string,
  type: StandardFieldType,
  options: {
    classification?: StandardFieldClassification;
    isRequired?: boolean;
    config?: Record<string, string>;
  } = {},
): StandardFieldDef => ({
  apiName,
  label,
  type,
  classification: options.classification ?? 'none',
  isRequired: options.isRequired ?? false,
  config: options.config ?? {},
});

export const STANDARD_OBJECT_CATALOGUE: readonly StandardObjectDef[] = [
  {
    apiName: 'contact',
    label: 'Contact',
    pluralLabel: 'Contacts',
    fields: [
      field('given_names', 'Given names', 'text', { classification: 'pii' }),
      field('family_name', 'Family name', 'text', { classification: 'pii' }),
      // Migration 0028 (T-0076, D-P17). Free text that is often a person's
      // name (a sole trader's business), so pii (D-L82).
      field('company_name', 'Company', 'text', { classification: 'pii' }),
      field('phones', 'Phones', 'phone', { classification: 'pii' }),
      field('emails', 'Emails', 'email', { classification: 'pii' }),
      field('account_id', 'Account', 'lookup', { config: { targetObjectApiName: 'account' } }),
      field('owner_user_id', 'Owner', 'text'),
      field('status', 'Status', 'text'),
      field('source', 'Source', 'text'),
      field('tags', 'Tags', 'text'),
      field('preferred_language', 'Preferred language', 'text'),
      field('preferred_channel', 'Preferred channel', 'text'),
      field('state', 'State', 'text'),
      field('lga', 'LGA', 'text'),
      field('dnd', 'Do not disturb', 'boolean'),
      field('whatsapp_opt_in', 'WhatsApp opt-in', 'boolean'),
      field('consent_state', 'Consent', 'text'),
      field('phone_network', 'Phone network', 'text'),
    ],
  },
  {
    apiName: 'account',
    label: 'Account',
    pluralLabel: 'Accounts',
    fields: [
      field('name', 'Name', 'text', { isRequired: true }),
      // Migration 0026 (T-0054): the T-0052 `Account` contract's columns.
      // `owner` is derived from owner_user_id and gets no field (D-L73).
      field('owner_user_id', 'Owner', 'text'),
      field('industry', 'Industry', 'text'),
      field('tier', 'Tier', 'text'),
      field('tags', 'Tags', 'text'),
      // A sole trader's number is personal data (D-L74).
      field('phones', 'Phones', 'phone', { classification: 'pii' }),
      field('state', 'State', 'text'),
      field('lga', 'LGA', 'text'),
      field('parent_account_id', 'Parent account', 'lookup', {
        config: { targetObjectApiName: 'account' },
      }),
    ],
  },
  {
    // Migration 0027 (T-0060). Notes, tasks and logged calls. subject and body
    // are free text that holds names in practice ("Call back Mrs X"), so both
    // are pii (D-L77). Timestamps are `datetime`, the body `textarea`; the
    // targets are real lookups; the owner is `text`, as on contact.
    apiName: 'activity',
    label: 'Activity',
    pluralLabel: 'Activities',
    fields: [
      field('type', 'Type', 'text', { isRequired: true }),
      field('subject', 'Subject', 'text', { classification: 'pii' }),
      field('body', 'Body', 'textarea', { classification: 'pii' }),
      field('due_at', 'Due', 'datetime'),
      field('completed_at', 'Completed', 'datetime'),
      // Migration 0034 (T-0082): a meeting's times.
      field('starts_at', 'Starts', 'datetime'),
      field('ends_at', 'Ends', 'datetime'),
      field('owner_user_id', 'Owner', 'text'),
      field('contact_id', 'Contact', 'lookup', { config: { targetObjectApiName: 'contact' } }),
      field('account_id', 'Account', 'lookup', { config: { targetObjectApiName: 'account' } }),
    ],
  },
  {
    // Migration 0036 (T-0106, R13). One field per business column the deal
    // contract may withhold. `amount` is the withholdable wire field (minor
    // units plus currency), `number` because a per-deal currency rules out the
    // `currency` type's fixed code; amount_minor and currency get none. name
    // and next_step are free text that holds names in practice: pii (D-L115).
    // The contact and account are real lookups, the owner `text`, as on
    // activity. Keys, version and timestamps get none.
    apiName: 'deal',
    label: 'Deal',
    pluralLabel: 'Deals',
    fields: [
      field('name', 'Name', 'text', { classification: 'pii', isRequired: true }),
      field('amount', 'Amount', 'number'),
      field('expected_close_date', 'Expected close date', 'date'),
      field('owner_user_id', 'Owner', 'text'),
      field('primary_contact_id', 'Primary contact', 'lookup', {
        config: { targetObjectApiName: 'contact' },
      }),
      field('account_id', 'Account', 'lookup', { config: { targetObjectApiName: 'account' } }),
      field('next_step', 'Next step', 'text', { classification: 'pii' }),
    ],
  },
];

/**
 * Anything that runs one parameterised statement and returns its rows: a
 * `TenantTx`, or a seed client wrapped as `.then((result) => result.rows)`.
 */
export type StandardCatalogueQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Makes ONE tenant's standard catalogue complete, in the caller's
 * transaction, in three statements whatever the catalogue's size. Fresh ids
 * (D-L08) for every row it writes, never shared between tenants.
 *
 * IDEMPOTENT: `ON CONFLICT DO NOTHING`, so it is safe to call again - on a
 * new tenant (seed, provisioning) it writes everything; on a tenant that
 * already has the rows it writes nothing and changes nothing (an existing
 * row keeps its id, label and field-security decisions). That is what makes
 * the deploy-window repair in the header a single call per tenant. Fields
 * attach to the tenant's STANDARD object of that name, never a custom one.
 *
 * VERIFIED: a third statement checks every catalogue entry per name, and it
 * throws `StandardCatalogueIncompleteError` (rolling the caller back) when
 * something in the tenant prevented a row from being written.
 *
 * PIPELINES (T-0106, R10): it also gives every programme of the tenant that
 * has none the default pipeline (`ensureDefaultPipelines`), so the same one
 * call repairs a programme created in the deploy window. As kasuwa_app it
 * reaches only the programmes the session's policies admit.
 *
 * tenancy-reviewed: `tenantId` is the only tenant named, in every statement
 * and in the join; provisioning passes `tx.session.tenantId` and the seed its
 * fixture tenant. Every value is a bound parameter; no identifier is built
 * from data.
 */
export async function ensureStandardObjectDefs(
  query: StandardCatalogueQuery,
  tenantId: string,
): Promise<void> {
  const fields = STANDARD_OBJECT_CATALOGUE.flatMap((object) =>
    object.fields.map((definition) => ({ objectApiName: object.apiName, ...definition })),
  );

  await query(
    `INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, is_custom)
     SELECT o.id, $1::uuid, o.api_name, o.label, o.plural_label, false
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[])
            AS o (id, api_name, label, plural_label)
     ON CONFLICT (tenant_id, api_name) DO NOTHING`,
    [
      tenantId,
      STANDARD_OBJECT_CATALOGUE.map(() => newId()),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.apiName),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.label),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.pluralLabel),
    ],
  );
  await query(
    `INSERT INTO field_def
       (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
     SELECT f.id, $1::uuid, o.id, f.api_name, f.label, f.type, f.classification,
            f.is_required, false, f.config
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                   $8::boolean[], $9::jsonb[])
            AS f (id, object_api_name, api_name, label, type, classification, is_required, config)
       JOIN object_def o
         ON o.tenant_id = $1::uuid AND o.api_name = f.object_api_name AND NOT o.is_custom
     ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING`,
    [
      tenantId,
      fields.map(() => newId()),
      fields.map((definition) => definition.objectApiName),
      fields.map((definition) => definition.apiName),
      fields.map((definition) => definition.label),
      fields.map((definition) => definition.type),
      fields.map((definition) => definition.classification),
      fields.map((definition) => definition.isRequired),
      fields.map((definition) => JSON.stringify(definition.config)),
    ],
  );

  // ON CONFLICT DO NOTHING cannot tell "already there" from "something else
  // is in the way" (a custom object called `contact`, a custom field of a
  // catalogue name, a mis-typed adopted row). So check the result, per name,
  // as 0025's backfill proof does, and refuse to report success on a tenant
  // whose catalogue is still incomplete. Classification is not compared: a
  // tenant may have raised it (D-P25; migration 0029 refuses a lowering).
  const missing = await query(
    `SELECT c.object_api_name AS entry
       FROM unnest($2::text[]) AS c (object_api_name)
      WHERE NOT EXISTS (
              SELECT 1 FROM object_def o
               WHERE o.tenant_id = $1::uuid AND o.api_name = c.object_api_name
                 AND NOT o.is_custom)
     UNION ALL
     SELECT c.object_api_name || '.' || c.api_name
       FROM unnest($3::text[], $4::text[], $5::text[], $6::boolean[], $7::jsonb[])
            AS c (object_api_name, api_name, type, is_required, config)
      WHERE NOT EXISTS (
              SELECT 1
                FROM field_def f
                JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
               WHERE f.tenant_id = $1::uuid
                 AND o.api_name = c.object_api_name AND NOT o.is_custom
                 AND f.api_name = c.api_name AND NOT f.is_custom
                 AND f.type = c.type
                 AND f.is_required = c.is_required
                 AND f.config = c.config)
      ORDER BY 1`,
    [
      tenantId,
      STANDARD_OBJECT_CATALOGUE.map((object) => object.apiName),
      fields.map((definition) => definition.objectApiName),
      fields.map((definition) => definition.apiName),
      fields.map((definition) => definition.type),
      fields.map((definition) => definition.isRequired),
      fields.map((definition) => JSON.stringify(definition.config)),
    ],
  );
  if (missing.length > 0) {
    throw new StandardCatalogueIncompleteError(missing.map((row) => String(row.entry)));
  }

  // Every programme of the tenant has its default pipeline (T-0106, R10): the
  // seed's programmes, and the deploy-window repair for a programme created
  // by the previous release after the migrate. Idempotent: a programme that
  // has a pipeline is left alone.
  await ensureDefaultPipelines(query, tenantId);
}

/**
 * `ensureStandardObjectDefs` could not make a tenant's catalogue complete,
 * because something already in the tenant is in the way. Names catalogue
 * entries only (never tenant data); which row wins is a human decision.
 */
export class StandardCatalogueIncompleteError extends Error {
  readonly entries: readonly string[];
  constructor(entries: readonly string[]) {
    super(
      `The standard catalogue is incomplete for this tenant; missing or mis-typed: ` +
        `${entries.join(', ')}. Something already in the tenant is in the way.`,
    );
    this.name = 'StandardCatalogueIncompleteError';
    this.entries = entries;
  }
}
