import {
  COMPLIANCE_FIELDS,
  changedCustomKeys,
  changedMergeFields,
  complianceOf,
  contactFieldLevel,
  defaultSide,
  MERGE_FIELDS,
  strictestCompliance,
  type ContactFieldAccess,
  type MergeColumnField,
  type MergeContact,
  type MergeField,
  type MergeSide,
  type MergeValues,
} from '@kasuwa/domain-core';
import { fieldLevel, type CustomFieldAccess } from '@kasuwa/metadata-engine';
import { canProgramme, type Grants } from '@kasuwa/permissions';
import {
  AUDIT_EVENT_MAX_CHANGES,
  redactedChange,
  type AuditChange,
} from '../admin/audit/audit-writer';
import {
  customChoiceKey,
  isComplianceKey,
  isMergeFieldKey,
  type MergeChoices,
} from './merges.schemas';

/**
 * The decisions of createContactMerge and undoContactMerge (T-0095), as pure
 * functions over what the service has read (D-L163: unit-tested here, the
 * service only reads, writes and throws). No I/O, no clock.
 */

const WRITE = 'contact.write' as const;

/** What the caller may do with each choosable field in one programme. */
export interface MergeAccess {
  contact: ContactFieldAccess;
  custom: CustomFieldAccess;
  programmeId: string;
}

/** `displayName` is in no matrix row: whoever may write contacts may write it. */
export function standardLevel(
  access: MergeAccess,
  field: MergeColumnField,
): 'none' | 'read' | 'edit' {
  if (field === 'displayName') return 'edit';
  return contactFieldLevel(access.contact, access.programmeId, field);
}

export function customLevel(access: MergeAccess, key: string): 'none' | 'read' | 'edit' {
  return fieldLevel(access.custom.access, access.programmeId, key);
}

/** Live custom keys the caller may edit in the programme, in a fixed order. */
export function editableCustomKeys(access: MergeAccess): string[] {
  return [...access.custom.defs.keys()].filter((key) => customLevel(access, key) === 'edit').sort();
}

export type Refusal = 'not_found' | 'not_permitted' | null;

/**
 * Who may merge (D-L53, D-P14, D-L151, D-L163): `contact.write` in both
 * contacts' programmes, the tenant-admin flag included and the claim right
 * never. Without it a merged-away contact is the invented id's 404, so the
 * answer never says it existed; otherwise 403.
 */
export function mergeRefusal(
  grants: Grants,
  survivor: Pick<MergeContact, 'programmeId' | 'deletedAt'> | undefined,
  merged: Pick<MergeContact, 'programmeId' | 'deletedAt'> | undefined,
): Refusal {
  if (survivor === undefined || merged === undefined) return 'not_found';
  const mayWrite =
    canProgramme(grants, WRITE, survivor.programmeId) &&
    canProgramme(grants, WRITE, merged.programmeId);
  if (mayWrite) return null;
  return survivor.deletedAt !== null || merged.deletedAt !== null ? 'not_found' : 'not_permitted';
}

/**
 * Who may undo (D-L151, D-L163): without `contact.write` in the merge's
 * programme, 404 (the merge is not shown to them as an action); with it, the
 * merging user or a tenant admin, else 403.
 */
export function undoRefusal(
  grants: Grants,
  merge: { programmeId: string; mergedByUserId: string },
  sessionUserId: string,
): Refusal {
  if (!canProgramme(grants, WRITE, merge.programmeId)) return 'not_found';
  if (grants.isTenantAdmin || merge.mergedByUserId === sessionUserId) return null;
  return 'not_permitted';
}

/** 403 paths: chosen fields (standard or live custom) the caller may not edit. Judged on the raw choices. */
export function lockedChoicePaths(
  rawChoices: Record<string, unknown>,
  access: MergeAccess,
): string[] {
  const locked: string[] = [];
  for (const key of Object.keys(rawChoices)) {
    if (isMergeFieldKey(key) && standardLevel(access, key) !== 'edit')
      locked.push(`choices.${key}`);
    const customKey = customChoiceKey(key);
    if (
      customKey !== null &&
      access.custom.defs.has(customKey) &&
      customLevel(access, customKey) !== 'edit'
    ) {
      locked.push(`choices.${key}`);
    }
  }
  return locked;
}

/** 400 details for compliance fields in the raw choices (D-P28: never choosable). */
export function complianceChoicePaths(rawChoices: Record<string, unknown>): string[] {
  return Object.keys(rawChoices)
    .filter(isComplianceKey)
    .map((key) => `choices.${key}`);
}

/**
 * The default side of every choosable field the caller may edit (M16, M4):
 * standard fields by wire name, custom keys as `custom.<key>`. An owner who
 * is not a member of the programme is never a default; when no side offers a
 * member the owner has no entry and the merge leaves the survivor unassigned.
 */
export function mergeDefaults(
  survivor: MergeContact,
  merged: MergeContact,
  access: MergeAccess,
  members: ReadonlyMap<string, boolean>,
): Record<string, MergeSide> {
  const mergedIsNewer = merged.updatedAt.getTime() > survivor.updatedAt.getTime();
  const defaults: Record<string, MergeSide> = {};
  for (const field of MERGE_FIELDS) {
    if (standardLevel(access, field) !== 'edit') continue;
    const acceptable =
      field === 'ownerUserId'
        ? (side: MergeSide) => {
            const owner = (side === 'survivor' ? survivor : merged).values.ownerUserId;
            return typeof owner !== 'string' || members.get(owner) === true;
          }
        : undefined;
    const side = defaultSide(
      survivor.values[field],
      merged.values[field],
      mergedIsNewer,
      acceptable,
    );
    if (side !== null) defaults[field] = side;
  }
  for (const key of editableCustomKeys(access)) {
    const side = defaultSide(survivor.custom[key], merged.custom[key], mergedIsNewer);
    if (side !== null) defaults[`custom.${key}`] = side;
  }
  return defaults;
}

/** True when the CHOSEN owner side names an owner who is not a member (M4: 400 unknown_reference). */
export function chosenOwnerIsNotMember(
  choices: MergeChoices,
  survivor: MergeContact,
  merged: MergeContact,
  access: MergeAccess,
  members: ReadonlyMap<string, boolean>,
): boolean {
  const chosen = choices.ownerUserId;
  if (chosen === undefined || standardLevel(access, 'ownerUserId') !== 'edit') return false;
  const owner = (chosen === 'survivor' ? survivor : merged).values.ownerUserId;
  return typeof owner === 'string' && members.get(owner) !== true;
}

export interface MergePlan {
  /** The survivor's new standard and compliance values. */
  values: MergeValues;
  /** The survivor's whole new custom object. */
  custom: Record<string, unknown>;
  /**
   * The audit's field names (M3, D-L83): standard and compliance fields by
   * wire name, custom fields by their BARE key, as recordAuditWithCustom
   * records them (a `custom.` prefix would pass the writer's 64-character
   * field limit for a 63-character key).
   */
  auditFields: string[];
}

/**
 * What the survivor becomes. A field the caller may not edit keeps the
 * survivor's value; compliance is the most restrictive (D-P28); custom keys
 * follow their choice or default, and retired keys are dropped (D-L142).
 */
export function planMerge(
  survivor: MergeContact,
  merged: MergeContact,
  access: MergeAccess,
  members: ReadonlyMap<string, boolean>,
  choices: MergeChoices,
): MergePlan {
  const defaults = mergeDefaults(survivor, merged, access, members);
  const values: MergeValues = {};
  for (const field of MERGE_FIELDS) {
    if (standardLevel(access, field) !== 'edit') continue;
    const side = choices[field] ?? defaults[field];
    if (side === undefined) {
      // Only the owner can lack a default (no member on either side, M4).
      if (field === 'ownerUserId') values.ownerUserId = null;
      continue;
    }
    values[field] = (side === 'merged' ? merged : survivor).values[field];
  }
  const compliance = strictestCompliance(
    complianceOf(survivor.values),
    complianceOf(merged.values),
  );
  values.dnd = compliance.dnd;
  values.whatsappOptIn = compliance.whatsappOptIn;
  values.consentState = compliance.consentState;

  const custom: Record<string, unknown> = { ...survivor.custom };
  for (const key of editableCustomKeys(access)) {
    const side = choices[`custom.${key}`] ?? defaults[`custom.${key}`];
    if (side !== 'merged') continue;
    if (key in merged.custom) custom[key] = merged.custom[key];
    else delete custom[key];
  }
  for (const key of access.custom.retired) delete custom[key];

  return {
    values,
    custom,
    auditFields: [
      ...changedMergeFields(survivor.values, values, [...MERGE_FIELDS, ...COMPLIANCE_FIELDS]),
      ...changedCustomKeys(survivor.custom, custom),
    ],
  };
}

/** The part of a merge snapshot undo needs (the service parses it with Zod). */
export interface UndoSnapshot {
  merged: { values: Record<string, unknown>; custom: Record<string, unknown> };
  survivor: {
    values: Record<string, unknown>;
    custom: Record<string, unknown>;
    versionAfter: number;
  };
}

export interface UndoPlan {
  /** True when the survivor is unedited since the merge, so it is put back. */
  reverted: boolean;
  /** The survivor's standard values to put back (compliance never). Empty unless reverted. */
  revert: MergeValues;
  /** The survivor's whole custom object after the undo. */
  revertCustom: Record<string, unknown>;
  /** M12: fields the revert would change that the undoer may not edit (403 paths). */
  lockedFields: string[];
  /** The merged contact's values: as it was, compliance the stricter of it and the survivor now. */
  restore: MergeValues;
  restoreCustom: Record<string, unknown>;
  /** Audit field names (bare custom keys, as planMerge). */
  auditFields: string[];
}

function storedValues(
  stored: Record<string, unknown>,
  fields: readonly MergeColumnField[],
): MergeValues {
  const values: MergeValues = {};
  for (const field of fields) values[field] = stored[field] ?? null;
  return values;
}

/**
 * What undo writes, judged under the undoer's CURRENT field security
 * (D-L151, M12): all or nothing. It never loosens compliance: the survivor
 * keeps its current values, and the restored contact takes the stricter of
 * its snapshot and the survivor's current value (D-P28).
 */
export function planUndo(
  snapshot: UndoSnapshot,
  survivor: MergeContact,
  access: MergeAccess,
): UndoPlan {
  const reverted = survivor.version === snapshot.survivor.versionAfter;
  const revert: MergeValues = {};
  let revertCustom: Record<string, unknown> = survivor.custom;
  const lockedFields: string[] = [];
  const auditFields: string[] = [];
  if (reverted) {
    const before = storedValues(snapshot.survivor.values, MERGE_FIELDS);
    for (const field of changedMergeFields(survivor.values, before, MERGE_FIELDS)) {
      revert[field] = before[field];
    }
    revertCustom = { ...snapshot.survivor.custom };
    for (const key of access.custom.retired) delete revertCustom[key];
    const customChanged = changedCustomKeys(survivor.custom, revertCustom);
    lockedFields.push(
      ...(Object.keys(revert) as MergeField[]).filter(
        (field) => standardLevel(access, field) !== 'edit',
      ),
      ...customChanged
        .filter((key) => access.custom.defs.has(key) && customLevel(access, key) !== 'edit')
        .map((key) => `custom.${key}`),
    );
    auditFields.push(...Object.keys(revert), ...customChanged);
  }

  const restore = storedValues(snapshot.merged.values, MERGE_FIELDS);
  const compliance = strictestCompliance(
    complianceOf(snapshot.merged.values as MergeValues),
    complianceOf(survivor.values),
  );
  restore.dnd = compliance.dnd;
  restore.whatsappOptIn = compliance.whatsappOptIn;
  restore.consentState = compliance.consentState;
  const restoreCustom = { ...snapshot.merged.custom };
  for (const key of access.custom.retired) delete restoreCustom[key];

  return { reverted, revert, revertCustom, lockedFields, restore, restoreCustom, auditFields };
}

/**
 * Audit changes, field names only (D-L83), within the writer's cap of 64:
 * one event per merge or undo (M3), so names past the cap are dropped
 * rather than split into a second event (D-L162).
 */
export function nameOnlyChanges(fields: readonly string[]): AuditChange[] {
  return fields.slice(0, AUDIT_EVENT_MAX_CHANGES).map((field) => redactedChange(field));
}
