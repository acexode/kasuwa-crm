import type { TenantTx } from '@kasuwa/db';
import { contactFieldApiName, isWithholdableContactField } from '@kasuwa/domain-core';
import {
  fieldLevel,
  loadFieldAccess,
  UnknownObjectDefError,
  type FieldAccess,
} from '@kasuwa/metadata-engine';
import { CONTACT_AUDIT_VALUE_FIELDS } from '../../contacts/contact-audit';
import { redactedChange, type AuditChange, type AuditObjectType } from './audit-writer';

/**
 * Field security on audit change values, for the READER (T-0078; D-L63,
 * D-L72, D-L81, D-L83).
 *
 * Since T-0061 a contact event stores `before`/`after` for D-L72's value
 * fields. The record APIs withhold a field the reader's matrix makes `none`
 * in the record's programme; the audit log must not be the way round that.
 * So, per event and per change, at READ time (the matrix of now decides; the
 * stored values stay recoverable for whoever may read them later):
 *
 *   - an event of a FIELD-SECURED object (contact, account, activity) shows a
 *     change's values only when BOTH hold:
 *       1. the field is on that object's VALUE ALLOW-LIST: for a contact,
 *          D-L72's value fields (`CONTACT_AUDIT_VALUE_FIELDS`, each also one
 *          the contact matrix governs); for an account or an activity, NONE
 *          until a decision says otherwise (D-L78 records them by name only).
 *          So a stored value on a name part, a phone, an email, a subject or
 *          a body is never shown, whatever the reader's level;
 *       2. the reader's level for it, in the EVENT's programme, is `read` or
 *          `edit`.
 *     Anything else is `{ field, redacted: true }`: the change and the event
 *     are kept, only the values go;
 *   - judged by `loadFieldAccess(tx, object)` + `fieldLevel`, so the set the
 *     reader holds in that programme counts (D-P9), the locked admin set is
 *     `edit`, a membership with no set gets the weakest unlocked level, and
 *     the TENANT-ADMIN FLAG IS NOT READ (D-L63);
 *   - an event with NO programme has nowhere to judge the matrix: every value
 *     is redacted, for every reader (F4, fail closed);
 *   - an object type this file does not know has every value redacted;
 *   - a change already stored redacted stays redacted (`toChanges`).
 *
 * Configuration objects (roles, programmes, matrix cells, policies,
 * dispositions, portal users, exports) carry Kasuwa configuration values, not
 * record data, and no field security applies to them: they pass unchanged.
 * `AUDIT_VALUE_POLICY` is a `Record` over `AuditObjectType`, so a new audited
 * object type does not compile until somebody decides which it is.
 *
 * COST, AND NO ORACLE: an object's access is loaded ONCE per request (one
 * round trip, covering every programme the session reaches) whenever the page
 * holds an event of that object with a programme and the object has a value
 * allow-list at all. Whether it is loaded never depends on what a stored
 * change holds, so neither the timing nor a load failure tells the reader
 * whether a withheld change carried a value.
 */

/** The objects whose fields the T-0026 matrix governs. */
export type FieldSecuredObject = 'contact' | 'account' | 'activity';

type ValuePolicy =
  | { kind: 'configuration' }
  | { kind: 'unknown' }
  | {
      kind: 'field_secured';
      object: FieldSecuredObject;
      /**
       * The fields that may carry a value: wire name -> the matrix's
       * `field_def.api_name`. Empty: no value of this object is ever shown.
       */
      valueFields: ReadonlyMap<string, string>;
    };

const CONFIGURATION: ValuePolicy = { kind: 'configuration' };

/** D-L72's value fields, each judged by its contact `field_def`. Both lists must agree on a field. */
const CONTACT_VALUE_FIELDS: ReadonlyMap<string, string> = new Map(
  CONTACT_AUDIT_VALUE_FIELDS.filter(isWithholdableContactField).map((field) => [
    field,
    contactFieldApiName(field),
  ]),
);

const NO_VALUE_FIELDS: ReadonlyMap<string, string> = new Map();

export const AUDIT_VALUE_POLICY: Readonly<Record<AuditObjectType, ValuePolicy>> = {
  role: CONFIGURATION,
  programme: CONFIGURATION,
  field_security: CONFIGURATION,
  audit_export: CONFIGURATION,
  sla_policy: CONFIGURATION,
  retention_policy: CONFIGURATION,
  disposition: CONFIGURATION,
  portal_user: CONFIGURATION,
  contact: { kind: 'field_secured', object: 'contact', valueFields: CONTACT_VALUE_FIELDS },
  // Names only (D-L78, D-L77) until a decision allows a value field.
  account: { kind: 'field_secured', object: 'account', valueFields: NO_VALUE_FIELDS },
  activity: { kind: 'field_secured', object: 'activity', valueFields: NO_VALUE_FIELDS },
  // T-0113: a script is programme configuration. Its events carry draft part
  // and locale names (redacted) and, on publish, a version number and
  // compliance node ids, never wording; no field security applies.
  script: CONFIGURATION,
  // T-0114: a run's events carry an outcome, a stop reason and configuration
  // ids only (x-kasuwa-audit-names); never an answer, a note or a node id.
  script_run: CONFIGURATION,
};

/** An object type outside the closed list: nothing in it is readable. */
const UNKNOWN_OBJECT: ValuePolicy = { kind: 'unknown' };

function policyOf(objectType: string): ValuePolicy {
  return Object.prototype.hasOwnProperty.call(AUDIT_VALUE_POLICY, objectType)
    ? AUDIT_VALUE_POLICY[objectType as AuditObjectType]
    : UNKNOWN_OBJECT;
}

/** The part of an audit entry this file judges. */
export interface AuditValueSubject {
  objectType: string;
  programmeId: string | null;
  changes: AuditChange[];
}

/** The reader's field access per field-secured object, as far as this request loaded it. */
export type ReaderFieldAccess = ReadonlyMap<FieldSecuredObject, FieldAccess>;

/**
 * Which objects' access a page needs: every field-secured object with a value
 * allow-list that has an event WITH A PROGRAMME on the page. Deliberately
 * blind to the changes themselves (see COST, AND NO ORACLE above). An event
 * with no programme is redacted without asking the matrix.
 */
export function objectsToLoad(entries: readonly AuditValueSubject[]): FieldSecuredObject[] {
  const needed = new Set<FieldSecuredObject>();
  for (const entry of entries) {
    const policy = policyOf(entry.objectType);
    if (policy.kind !== 'field_secured' || policy.valueFields.size === 0) continue;
    if (entry.programmeId !== null) needed.add(policy.object);
  }
  return [...needed];
}

/**
 * One entry's changes as the reader may see them. Pure. An object whose
 * access is missing from `access` judges every field `none`: fail closed.
 */
export function redactForReader<T extends AuditValueSubject>(
  entry: T,
  access: ReaderFieldAccess,
): T {
  const policy = policyOf(entry.objectType);
  if (policy.kind === 'configuration') return entry;
  if (policy.kind === 'unknown') {
    return { ...entry, changes: entry.changes.map((change) => redactedChange(change.field)) };
  }
  const { programmeId } = entry;
  const objectAccess: FieldAccess = access.get(policy.object) ?? new Map();
  const changes = entry.changes.map((change) => {
    if (change.redacted) return redactedChange(change.field);
    if (programmeId === null) return redactedChange(change.field);
    const apiName = policy.valueFields.get(change.field);
    if (apiName === undefined) return redactedChange(change.field);
    return fieldLevel(objectAccess, programmeId, apiName) === 'none'
      ? redactedChange(change.field)
      : change;
  });
  return { ...entry, changes };
}

/** Loads one object's access. */
export type FieldAccessLoader = (object: FieldSecuredObject) => Promise<FieldAccess>;

/**
 * The SESSION's own field access for one object, failing closed on a missing
 * catalogue: a tenant with no definition for the object reads as "nothing
 * readable", never as an error page and never as the D-L45 default.
 */
export function loaderFor(tx: TenantTx): FieldAccessLoader {
  return async (object) => {
    if (tx.session.programmeIds.length === 0) return new Map();
    try {
      return await loadFieldAccess(tx, object);
    } catch (error) {
      if (error instanceof UnknownObjectDefError) return new Map();
      throw error;
    }
  };
}

/**
 * A page of entries as the reader of `tx` may see them: each needed object's
 * access loaded once (sequentially, on the request's one connection) from
 * THAT SESSION's own matrix, then every entry judged in its own programme.
 *
 * It takes the transaction, never a loader or an access map: no caller (the
 * future export worker included) can hand it a forged, cached or someone
 * else's matrix. Whoever calls it must already be inside a tenant transaction
 * opened as the reader whose view this is.
 */
export async function applyAuditFieldSecurity<T extends AuditValueSubject>(
  entries: readonly T[],
  tx: TenantTx,
): Promise<T[]> {
  const load = loaderFor(tx);
  const access = new Map<FieldSecuredObject, FieldAccess>();
  for (const object of objectsToLoad(entries)) {
    access.set(object, await load(object));
  }
  return entries.map((entry) => redactForReader(entry, access));
}
