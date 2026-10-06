import { newId } from './ids';

/**
 * The standard objects every tenant starts with, as metadata rows (T-0053;
 * D-L69 answers M15 Q10: standard objects are `object_def` / `field_def`
 * rows, marked standard by `is_custom = false`).
 *
 * ONE list, read by two writers, exactly as DEFAULT_PERMISSION_SET_CATALOGUE:
 * the seed (`runSeed`) and tenant provisioning (`provisionTenant` in
 * `@kasuwa/domain-core/provisioning`). Tenants that existed before the rows
 * did were backfilled by migration 0025, which carries a frozen copy of this
 * list; the T-0053 acceptance suite asserts that all three produce the same
 * catalogue. Adding a standard field therefore means: add it here AND
 * backfill it in a new migration. Never edit 0025.
 *
 * Field api_names are the snake_case of the records contract's wire names
 * (`givenNames` -> `given_names`, S3). `contact` carries the properties field
 * security may withhold (WITHHOLDABLE_CONTACT_FIELDS in @kasuwa/domain-core,
 * whose unit test pins the two lists together); the never-withheld ones would
 * be matrix rows that do nothing. `account` carries its business columns.
 *
 * Types: the closest P0 type that needs no per-type configuration, except
 * `account_id`, a real lookup to `account`. Enumerated values (status, source,
 * channel, consent) are `text` rather than `picklist`: their values live in
 * the contract and the column CHECKs, and copying them into `config` would be
 * a third list to drift. `owner_user_id` is `text` because there is no `user`
 * object definition to look up (and `user` is a reserved api_name).
 *
 * Metadata is tenant-scoped, NOT programme-scoped (0002 header): nothing here
 * carries a programme.
 */

/** The subset of metadata-engine's FIELD_TYPES the standard catalogue uses. */
export type StandardFieldType = 'text' | 'phone' | 'email' | 'boolean' | 'lookup';
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
    fields: [field('name', 'Name', 'text', { isRequired: true })],
  },
];

/** Anything that runs one parameterised statement: a `TenantTx`, or a seed client. */
export type StandardCatalogueQuery = (text: string, values: readonly unknown[]) => Promise<unknown>;

/**
 * Writes the standard catalogue for ONE tenant, in the caller's transaction,
 * in two statements whatever the catalogue's size. Fresh ids (D-L08) for every
 * row, never shared between tenants.
 *
 * For a NEW tenant only: a plain INSERT, so a tenant that somehow already has
 * a `contact` definition fails loudly instead of being half-merged.
 *
 * tenancy-reviewed: `tenantId` is the only tenant named; provisioning passes
 * `tx.session.tenantId` and the seed its fixture tenant. Every value is a
 * bound parameter; no identifier is built from data.
 */
export async function insertStandardObjectDefs(
  query: StandardCatalogueQuery,
  tenantId: string,
): Promise<{ objects: number; fields: number }> {
  const objectIds = new Map(STANDARD_OBJECT_CATALOGUE.map((object) => [object.apiName, newId()]));
  const objectId = (apiName: string): string => {
    const id = objectIds.get(apiName);
    if (id === undefined) throw new Error(`standard object ${apiName} has no id`);
    return id;
  };
  const fields = STANDARD_OBJECT_CATALOGUE.flatMap((object) =>
    object.fields.map((definition) => ({ objectId: objectId(object.apiName), ...definition })),
  );

  await query(
    `INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, is_custom)
     SELECT o.id, $1::uuid, o.api_name, o.label, o.plural_label, false
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[])
            AS o (id, api_name, label, plural_label)`,
    [
      tenantId,
      STANDARD_OBJECT_CATALOGUE.map((object) => objectId(object.apiName)),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.apiName),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.label),
      STANDARD_OBJECT_CATALOGUE.map((object) => object.pluralLabel),
    ],
  );
  await query(
    `INSERT INTO field_def
       (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
     SELECT f.id, $1::uuid, f.object_id, f.api_name, f.label, f.type, f.classification,
            f.is_required, false, f.config
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[],
                   $8::boolean[], $9::jsonb[])
            AS f (id, object_id, api_name, label, type, classification, is_required, config)`,
    [
      tenantId,
      fields.map(() => newId()),
      fields.map((definition) => definition.objectId),
      fields.map((definition) => definition.apiName),
      fields.map((definition) => definition.label),
      fields.map((definition) => definition.type),
      fields.map((definition) => definition.classification),
      fields.map((definition) => definition.isRequired),
      fields.map((definition) => JSON.stringify(definition.config)),
    ],
  );
  return { objects: STANDARD_OBJECT_CATALOGUE.length, fields: fields.length };
}
