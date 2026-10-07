import type { TenantTx } from '@kasuwa/db';
import {
  accountFieldApiName,
  activityFieldApiName,
  contactFieldApiName,
  isSecuredActivityField,
  isWithholdableAccountField,
  isWithholdableContactField,
} from '@kasuwa/domain-core';
import {
  fieldLevel,
  loadFieldAccess,
  UnknownObjectDefError,
  type FieldAccess,
} from '@kasuwa/metadata-engine';
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
 *     change's values only when the field is one that object's field
 *     security governs AND the reader's level for it, in the EVENT's
 *     programme, is `read` or `edit`. Anything else is `{ field, redacted:
 *     true }`: the change and the event are kept, only the values go;
 *   - judged by `loadFieldAccess(tx, object)` + `fieldLevel`, so the set the
 *     reader holds in that programme counts (D-P9), the locked admin set is
 *     `edit`, a membership with no set gets the weakest unlocked level, and
 *     the TENANT-ADMIN FLAG IS NOT READ (D-L63);
 *   - an event with NO programme has nowhere to judge the matrix: every value
 *     is redacted, for every reader (F4, fail closed);
 *   - a field the object does not secure (an unknown name, or one the record
 *     API never withholds such as a contact's `displayName`) is redacted: the
 *     allow-list is the object's secured fields, never "not known to be
 *     withheld";
 *   - an object type this file does not know is treated as field-secured
 *     with nothing readable: every value redacted;
 *   - a change already stored redacted stays redacted (`toChanges`).
 *
 * Configuration objects (roles, programmes, matrix cells, policies,
 * dispositions, portal users, exports) carry Kasuwa configuration values, not
 * record data, and no field security applies to them: they pass unchanged.
 * `AUDIT_VALUE_POLICY` is a `Record` over `AuditObjectType`, so a new audited
 * object type does not compile until somebody decides which it is.
 *
 * COST: each field-secured object's access is loaded ONCE per request (one
 * round trip, covering every programme the session reaches), and only when a
 * page actually holds a value that needs judging.
 */

/** The objects whose fields the T-0026 matrix governs. */
export type FieldSecuredObject = 'contact' | 'account' | 'activity';

type ValuePolicy =
  | { kind: 'configuration' }
  | { kind: 'unknown' }
  | {
      kind: 'field_secured';
      object: FieldSecuredObject;
      /** The matrix's `field_def.api_name` for a wire field, or null when the object does not secure it. */
      apiNameOf: (field: string) => string | null;
    };

const CONFIGURATION: ValuePolicy = { kind: 'configuration' };

export const AUDIT_VALUE_POLICY: Readonly<Record<AuditObjectType, ValuePolicy>> = {
  role: CONFIGURATION,
  programme: CONFIGURATION,
  field_security: CONFIGURATION,
  audit_export: CONFIGURATION,
  sla_policy: CONFIGURATION,
  retention_policy: CONFIGURATION,
  disposition: CONFIGURATION,
  portal_user: CONFIGURATION,
  contact: {
    kind: 'field_secured',
    object: 'contact',
    apiNameOf: (field) => (isWithholdableContactField(field) ? contactFieldApiName(field) : null),
  },
  account: {
    kind: 'field_secured',
    object: 'account',
    apiNameOf: (field) => (isWithholdableAccountField(field) ? accountFieldApiName(field) : null),
  },
  activity: {
    kind: 'field_secured',
    object: 'activity',
    apiNameOf: (field) => (isSecuredActivityField(field) ? activityFieldApiName(field) : null),
  },
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
 * Which objects' access a page needs: only events with a programme and at
 * least one change not already redacted. An event with no programme is
 * redacted without asking the matrix, and an unknown object never needs one.
 * (Every unredacted change is judged, a valueless one included, so a change's
 * shape never depends on what else shares its page.)
 */
export function objectsToLoad(entries: readonly AuditValueSubject[]): FieldSecuredObject[] {
  const needed = new Set<FieldSecuredObject>();
  for (const entry of entries) {
    const policy = policyOf(entry.objectType);
    if (policy.kind !== 'field_secured') continue;
    if (entry.programmeId === null) continue;
    if (entry.changes.some((change) => !change.redacted)) needed.add(policy.object);
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
    const apiName = policy.apiNameOf(change.field);
    if (apiName === null) return redactedChange(change.field);
    return fieldLevel(objectAccess, programmeId, apiName) === 'none'
      ? redactedChange(change.field)
      : change;
  });
  return { ...entry, changes };
}

/** Loads one object's access. Injectable so the per-request cost is unit-tested. */
export type FieldAccessLoader = (object: FieldSecuredObject) => Promise<FieldAccess>;

/**
 * The reader's field access for one object, failing closed on a missing
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
 * A page of entries as the reader may see them: each needed object's access
 * loaded once (sequentially, on the request's one connection), then every
 * entry judged in its own programme.
 */
export async function applyAuditFieldSecurity<T extends AuditValueSubject>(
  entries: readonly T[],
  load: FieldAccessLoader,
): Promise<T[]> {
  const access = new Map<FieldSecuredObject, FieldAccess>();
  for (const object of objectsToLoad(entries)) {
    access.set(object, await load(object));
  }
  return entries.map((entry) => redactForReader(entry, access));
}
