import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  COMPLIANCE_FIELDS,
  changedCustomKeys,
  changedMergeFields,
  complianceOf,
  contactFieldLevel,
  decodeDuplicateCursor,
  decodeIdCursor,
  defaultSide,
  encodeDuplicateCursor,
  encodeIdCursor,
  findContactById,
  findContactMerge,
  findContactsForMerge,
  insertContactMerge,
  listContactMerges,
  listDuplicateSets,
  loadContactFieldAccess,
  lockOpenMergeSnapshot,
  markContactMergeUndone,
  MERGE_FIELDS,
  moveContactChildren,
  programmeAccountExists,
  programmeMemberExists,
  restoreContact,
  softDeleteContact,
  strictestCompliance,
  writeMergedValues,
  type ComplianceValues,
  type Contact,
  type ContactFieldAccess,
  type ContactMergeRecord,
  type MergeColumnField,
  type MergeContact,
  type MergeField,
  type MergeSide,
  type MergeValues,
} from '@kasuwa/domain-core';
import { fieldLevel } from '@kasuwa/metadata-engine';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { z } from 'zod';
import {
  AUDIT_EVENT_MAX_CHANGES,
  recordAuditEvent,
  redactedChange,
  type AuditChange,
} from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import { toContactWire, type ContactWire } from '../contacts/contact-wire';
import {
  customBackstopAs400,
  customWiresFor,
  EMPTY_CUSTOM_WIRE,
  loadCustom,
  type CustomFieldAccess,
} from '../custom-fields/custom-values';
import {
  ContactIdParam,
  CreateContactMergeBody,
  customChoiceKey,
  isComplianceKey,
  isMergeFieldKey,
  MergeIdParam,
  MergePreviewQuery,
  PageQuery,
  ProgrammeIdParam,
} from './merges.schemas';

/**
 * Duplicates, merge and undo (T-0095): listDuplicates,
 * getContactMergePreview, createContactMerge, listContactMerges and
 * undoContactMerge of records.openapi.yaml, on migration 0040.
 *
 * ORDER (D-L53, M15): 404, then 403, then 400, then 409. A contact the caller
 * cannot read is the invented id's 404 whatever the rights; a caller without
 * `contact.write` is 403 whatever the body; only a permitted caller sees a
 * 400; the conflicts come last.
 *
 * FIELD SECURITY (D-L63, D-L151). A field the caller may not edit in the
 * programme is never taken from the merged side (the survivor keeps its own
 * value) and choosing it is 403 `field_not_editable`. A withheld value is
 * never served. Compliance (D-P28) is never chosen: always the most
 * restrictive of the two, and undo never loosens it on either contact.
 *
 * NOTHING HERE LOGS, and no error carries a value or an identifier the
 * caller did not send. The snapshot is written and read back only to undo.
 */

const WRITE = 'contact.write' as const;

// --- shared ------------------------------------------------------------------------

function fieldNotEditable(paths: readonly string[]): AdminError {
  return new AdminError(
    HttpStatus.FORBIDDEN,
    'not_permitted',
    'You do not have permission to do that.',
    {
      details: paths.map((path) => ({ path, code: 'field_not_editable' })),
    },
  );
}

const alreadyMerged = (): AdminError =>
  new AdminError(HttpStatus.CONFLICT, 'already_merged', 'That contact has already been merged.');

const undoExpired = (): AdminError =>
  new AdminError(HttpStatus.GONE, 'undo_expired', 'The time to undo this merge has passed.');

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && z.string().uuid().safeParse(value).success;

/** What the caller may do with each choosable field in one programme. */
interface MergeAccess {
  contact: ContactFieldAccess;
  custom: CustomFieldAccess;
  programmeId: string;
}

/** `displayName` is in no matrix row: whoever may write contacts may write it. */
function standardLevel(access: MergeAccess, field: MergeColumnField): 'none' | 'read' | 'edit' {
  if (field === 'displayName') return 'edit';
  return contactFieldLevel(access.contact, access.programmeId, field);
}

function customLevel(access: MergeAccess, key: string): 'none' | 'read' | 'edit' {
  return fieldLevel(access.custom.access, access.programmeId, key);
}

/** Live custom keys the caller may edit in the programme, in a fixed order. */
function editableCustomKeys(access: MergeAccess): string[] {
  return [...access.custom.defs.keys()].filter((key) => customLevel(access, key) === 'edit').sort();
}

/** Membership of each distinct non-null owner of the two contacts (D-L67, D-P23). */
async function ownerMembership(
  tx: TenantTx,
  programmeId: string,
  owners: readonly unknown[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (const owner of owners) {
    if (typeof owner !== 'string' || result.has(owner)) continue;
    result.set(owner, await programmeMemberExists(tx, programmeId, owner));
  }
  return result;
}

/**
 * The default side of every choosable field the caller may edit (M16, M4):
 * standard fields by wire name, custom keys as `custom.<key>`. An owner who
 * is not a member of the programme is never a default; when no side offers a
 * member the owner has no entry and the merge leaves the survivor unassigned.
 */
function mergeDefaults(
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

// --- listDuplicates ---------------------------------------------------------------

export interface DuplicatePageWire {
  data: {
    matchOn: 'phone' | 'email';
    contacts: { id: string; displayName: string | null; updatedAt: string }[];
  }[];
  nextCursor: string | null;
}

export async function listDuplicatesFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<DuplicatePageWire> {
  const { programmeId: requested } = ProgrammeIdParam.parse(params); // 400
  const programmeId = requested.toLowerCase();
  // Another tenant's programme, a sibling and an invented id: one 404.
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  const page = PageQuery.parse(query); // 400
  const after = page.cursor === undefined ? null : decodeDuplicateCursor(page.cursor); // 400

  // A match on a withheld field is itself a fact about the value: no sets.
  const access = await loadContactFieldAccess(tx);
  const rows = await listDuplicateSets(tx, programmeId, {
    phones: contactFieldLevel(access, programmeId, 'phones') !== 'none',
    emails: contactFieldLevel(access, programmeId, 'emails') !== 'none',
    after,
    limit: page.limit + 1,
  });
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    data: shown
      .filter((set) => set.contacts.length >= 2)
      .map((set) => ({
        matchOn: set.matchOn,
        contacts: set.contacts.map((contact) => ({
          id: contact.id,
          displayName: contact.displayName,
          updatedAt: contact.updatedAt.toISOString(),
        })),
      })),
    nextCursor: rows.length > page.limit && last !== undefined ? encodeDuplicateCursor(last) : null,
  };
}

// --- getContactMergePreview ---------------------------------------------------------

export interface MergePreviewWire {
  survivor: ContactWire;
  merged: ContactWire;
  defaults: Record<string, MergeSide>;
  compliance: Partial<ComplianceValues> & { withheldFields: string[] };
}

/** Both contacts readable, live and in one programme, or the contract's 404 and 400s. */
async function previewPair(
  tx: TenantTx,
  survivorId: string,
  withId: string,
): Promise<{ survivor: Contact; merged: Contact }> {
  const survivor = await findContactById(tx, survivorId);
  if (survivor === null) throw notFound(); // 404
  if (withId === survivorId) throw validationFailed([{ path: 'with', code: 'same_contact' }]);
  const merged = await findContactById(tx, withId);
  if (merged === null) throw notFound(); // 404
  if (merged.programmeId !== survivor.programmeId) {
    throw validationFailed([{ path: 'with', code: 'cross_programme' }]);
  }
  return { survivor, merged };
}

export async function getContactMergePreviewFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<MergePreviewWire> {
  const survivorId = ContactIdParam.parse(params).id.toLowerCase(); // 400
  const withId = MergePreviewQuery.parse(query).with.toLowerCase(); // 400
  const { survivor, merged } = await previewPair(tx, survivorId, withId);
  const programmeId = survivor.programmeId;

  const rows = await findContactsForMerge(tx, [survivor.id, merged.id]);
  const survivorRow = rows.find((row) => row.id === survivor.id);
  const mergedRow = rows.find((row) => row.id === merged.id);
  if (survivorRow === undefined || mergedRow === undefined) throw notFound();

  const contactAccess = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');
  const access: MergeAccess = { contact: contactAccess, custom, programmeId };
  const members = await ownerMembership(tx, programmeId, [
    survivorRow.values.ownerUserId,
    mergedRow.values.ownerUserId,
  ]);
  const outcome = strictestCompliance(
    complianceOf(survivorRow.values),
    complianceOf(mergedRow.values),
  );
  const compliance: MergePreviewWire['compliance'] = { withheldFields: [] };
  for (const field of COMPLIANCE_FIELDS) {
    if (contactFieldLevel(contactAccess, programmeId, field) === 'none') {
      compliance.withheldFields.push(field);
    } else {
      (compliance as Record<string, unknown>)[field] = outcome[field];
    }
  }
  const wires = await customWiresFor(tx, custom, [survivor, merged]);
  return {
    survivor: toContactWire(survivor, contactAccess, wires.get(survivor.id) ?? EMPTY_CUSTOM_WIRE),
    merged: toContactWire(merged, contactAccess, wires.get(merged.id) ?? EMPTY_CUSTOM_WIRE),
    defaults: mergeDefaults(survivorRow, mergedRow, access, members),
    compliance,
  };
}

// --- the ContactMerge wire --------------------------------------------------------

export interface ContactMergeWire {
  id: string;
  programmeId: string;
  survivor: { id: string; displayName: string | null };
  merged: { id: string; displayName: string | null };
  mergedByUserId: string;
  mergedAt: string;
  undoUntil: string;
  undoneAt: string | null;
  undoneByUserId: string | null;
  survivorReverted: boolean | null;
}

/** Never the snapshot. A contact's displayName is never withheld (it is in no matrix row). */
export function toContactMergeWire(record: ContactMergeRecord): ContactMergeWire {
  return {
    id: record.id,
    programmeId: record.programmeId,
    survivor: { id: record.survivorId, displayName: record.survivorDisplayName },
    merged: { id: record.mergedId, displayName: record.mergedDisplayName },
    mergedByUserId: record.mergedByUserId,
    mergedAt: record.mergedAt.toISOString(),
    undoUntil: record.undoUntil.toISOString(),
    undoneAt: record.undoneAt?.toISOString() ?? null,
    undoneByUserId: record.undoneByUserId,
    survivorReverted: record.survivorReverted,
  };
}

// --- createContactMerge ---------------------------------------------------------------

/** What undo restores (PII; never served, never logged). Versioned so a later reader can refuse. */
const Snapshot = z.object({
  v: z.literal(1),
  merged: z.object({ values: z.record(z.unknown()), custom: z.record(z.unknown()) }),
  survivor: z.object({
    values: z.record(z.unknown()),
    custom: z.record(z.unknown()),
    versionAfter: z.number().int(),
  }),
  moved: z.object({ activities: z.array(z.string()), deals: z.array(z.string()) }),
});
type Snapshot = z.infer<typeof Snapshot>;

/** Audit changes, field names only (D-L83), within the writer's cap: one event per merge (M3). */
function nameOnlyChanges(fields: readonly string[]): AuditChange[] {
  return fields.slice(0, AUDIT_EVENT_MAX_CHANGES).map((field) => redactedChange(field));
}

export async function createContactMergeFor(
  tx: TenantTx,
  body: unknown,
): Promise<ContactMergeWire> {
  const raw = plainObject(body);
  if (raw === null) throw validationFailed([{ path: '', code: 'invalid_type' }]);
  // Without two well-formed ids there is nothing to look up: the body's 400.
  if (!isUuid(raw.survivorId) || !isUuid(raw.mergedId)) CreateContactMergeBody.parse(body);
  const survivorId = String(raw.survivorId).toLowerCase();
  const mergedId = String(raw.mergedId).toLowerCase();

  // 404: either side unreadable (merged-away rows the caller reaches are found
  // here, so that the 409 below can tell them apart from invented ids).
  const found = await findContactsForMerge(tx, [survivorId, mergedId]);
  const survivorSeen = found.find((row) => row.id === survivorId);
  const mergedSeen = found.find((row) => row.id === mergedId);
  if (survivorSeen === undefined || mergedSeen === undefined) throw notFound();

  // 403: contact.write on both sides' programmes. Claim rights never merge (D-L151).
  const grants = await loadGrants(tx);
  if (
    !canProgramme(grants, WRITE, survivorSeen.programmeId) ||
    !canProgramme(grants, WRITE, mergedSeen.programmeId)
  ) {
    throw notPermitted();
  }
  const programmeId = survivorSeen.programmeId;
  const contactAccess = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');
  const access: MergeAccess = { contact: contactAccess, custom, programmeId };

  // 403: a chosen field the caller may not edit (judged on the raw choices).
  const rawChoices = plainObject(raw.choices) ?? {};
  const locked: string[] = [];
  for (const key of Object.keys(rawChoices)) {
    if (isMergeFieldKey(key) && standardLevel(access, key) !== 'edit')
      locked.push(`choices.${key}`);
    const customKey = customChoiceKey(key);
    if (
      customKey !== null &&
      custom.defs.has(customKey) &&
      customLevel(access, customKey) !== 'edit'
    ) {
      locked.push(`choices.${key}`);
    }
  }
  if (locked.length > 0) throw fieldNotEditable(locked);

  // 400s.
  const notChoosable = Object.keys(rawChoices)
    .filter(isComplianceKey)
    .map((key): AdminErrorDetail => ({ path: `choices.${key}`, code: 'compliance_not_choosable' }));
  if (notChoosable.length > 0) throw validationFailed(notChoosable);
  const parsed = CreateContactMergeBody.parse(body);
  const choices = parsed.choices ?? {};
  const unknownCustom = Object.keys(choices)
    .filter((key) => {
      const customKey = customChoiceKey(key);
      return customKey !== null && !custom.defs.has(customKey);
    })
    .map((key): AdminErrorDetail => ({ path: `choices.${key}`, code: 'unknown_field' }));
  if (unknownCustom.length > 0) throw validationFailed(unknownCustom);
  if (survivorId === mergedId) throw validationFailed([{ path: 'mergedId', code: 'same_contact' }]);
  if (mergedSeen.programmeId !== programmeId) {
    throw validationFailed([{ path: 'mergedId', code: 'cross_programme' }]);
  }

  // Lock both, in id order, and judge the rest on what is current.
  const locked2 = await findContactsForMerge(tx, [survivorId, mergedId], true);
  const survivor = locked2.find((row) => row.id === survivorId);
  const merged = locked2.find((row) => row.id === mergedId);
  if (survivor === undefined || merged === undefined) throw notFound();

  const members = await ownerMembership(tx, programmeId, [
    survivor.values.ownerUserId,
    merged.values.ownerUserId,
  ]);
  const chosenOwner = choices.ownerUserId;
  if (chosenOwner !== undefined && standardLevel(access, 'ownerUserId') === 'edit') {
    const owner = (chosenOwner === 'survivor' ? survivor : merged).values.ownerUserId;
    if (typeof owner === 'string' && members.get(owner) !== true) {
      throw validationFailed([{ path: 'choices.ownerUserId', code: 'unknown_reference' }]);
    }
  }

  // 409s.
  if (survivor.deletedAt !== null || merged.deletedAt !== null) throw alreadyMerged();
  if (survivor.version !== parsed.survivorVersion || merged.version !== parsed.mergedVersion) {
    throw staleWrite();
  }

  // The survivor's new values.
  const defaults = mergeDefaults(survivor, merged, access, members);
  const values: MergeValues = {};
  for (const field of MERGE_FIELDS) {
    if (standardLevel(access, field) !== 'edit') continue; // the survivor keeps its own
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

  const customOut: Record<string, unknown> = { ...survivor.custom };
  for (const key of editableCustomKeys(access)) {
    const side = choices[`custom.${key}`] ?? defaults[`custom.${key}`];
    if (side !== 'merged') continue;
    if (key in merged.custom) customOut[key] = merged.custom[key];
    else delete customOut[key];
  }
  for (const key of custom.retired) delete customOut[key]; // every custom write drops them (D-L142)

  const changed = [
    ...changedMergeFields(survivor.values, values, [...MERGE_FIELDS, ...COMPLIANCE_FIELDS]),
    ...changedCustomKeys(survivor.custom, customOut).map((key) => `custom.${key}`),
  ];

  const versionAfter = await customBackstopAs400(() =>
    writeMergedValues(
      tx,
      { id: survivor.id, programmeId, version: survivor.version },
      values,
      customOut,
    ),
  );
  if (versionAfter === null) throw staleWrite();
  if (!(await softDeleteContact(tx, { id: merged.id, programmeId, version: merged.version }))) {
    throw staleWrite();
  }
  const moved = await moveContactChildren(tx, programmeId, merged.id, survivor.id);
  const snapshot: Snapshot = {
    v: 1,
    merged: { values: merged.values, custom: merged.custom },
    survivor: { values: survivor.values, custom: survivor.custom, versionAfter },
    moved,
  };
  const record = await insertContactMerge(tx, {
    programmeId,
    survivorId: survivor.id,
    mergedId: merged.id,
    snapshot,
  });
  await recordAuditEvent(tx, {
    action: 'merged',
    objectType: 'contact',
    objectId: survivor.id,
    objectLabel: survivor.id,
    programmeId,
    changes: nameOnlyChanges(changed),
  });
  return toContactMergeWire(record);
}

// --- undoContactMerge ---------------------------------------------------------------

/** The stored values of `fields` from a snapshot's record, by wire name. */
function snapshotValues(
  stored: Record<string, unknown>,
  fields: readonly MergeColumnField[],
): MergeValues {
  const values: MergeValues = {};
  for (const field of fields) values[field] = stored[field] ?? null;
  return values;
}

/**
 * Every writer of `owner_user_id` checks membership (D-L67, D-P23): an owner
 * who has left the programme since the merge is restored as unassigned. An
 * account that no longer exists is restored as none (never a 23503).
 */
async function settleReferences(
  tx: TenantTx,
  programmeId: string,
  values: MergeValues,
): Promise<void> {
  const owner = values.ownerUserId;
  if (typeof owner === 'string' && !(await programmeMemberExists(tx, programmeId, owner))) {
    values.ownerUserId = null;
  }
  const account = values.accountId;
  if (typeof account === 'string' && !(await programmeAccountExists(tx, programmeId, account))) {
    values.accountId = null;
  }
}

export async function undoContactMergeFor(
  tx: TenantTx,
  params: unknown,
): Promise<ContactMergeWire> {
  const mergeId = MergeIdParam.parse(params).mergeId.toLowerCase(); // 400
  const record = await findContactMerge(tx, mergeId);
  if (record === null) throw notFound(); // 404
  const programmeId = record.programmeId;

  // 403 (D-L151): the merging user holding contact.write now, or a tenant admin.
  const grants = await loadGrants(tx);
  const mayUndo =
    (grants.isTenantAdmin && canProgramme(grants, WRITE, programmeId)) ||
    (record.mergedByUserId === tx.session.userId && canProgramme(grants, WRITE, programmeId));
  if (!mayUndo) throw notPermitted();

  if (record.undoneAt !== null) return toContactMergeWire(record); // M13: a repeat changes nothing
  if (!record.undoOpen) throw undoExpired(); // 410

  const rawSnapshot = await lockOpenMergeSnapshot(tx, mergeId);
  if (rawSnapshot === null) {
    // Undone by a concurrent request meanwhile: the repeat's answer.
    const now = await findContactMerge(tx, mergeId);
    if (now === null) throw notFound();
    return toContactMergeWire(now);
  }
  const snapshot = Snapshot.parse(rawSnapshot);

  const rows = await findContactsForMerge(tx, [record.survivorId, record.mergedId], true);
  const survivor = rows.find((row) => row.id === record.survivorId);
  const merged = rows.find((row) => row.id === record.mergedId);
  if (survivor === undefined || merged === undefined) throw notFound();
  if (survivor.deletedAt !== null) throw alreadyMerged(); // undo the later merge first

  const contactAccess = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');
  const access: MergeAccess = { contact: contactAccess, custom, programmeId };

  // The survivor is put back only if nobody has edited it since (its version).
  const reverted = survivor.version === snapshot.survivor.versionAfter;
  const revert: MergeValues = {};
  let revertCustom: Record<string, unknown> = survivor.custom;
  const restoredOnSurvivor: string[] = [];
  if (reverted) {
    const before = snapshotValues(snapshot.survivor.values, MERGE_FIELDS);
    for (const field of changedMergeFields(survivor.values, before, MERGE_FIELDS)) {
      revert[field] = before[field];
    }
    revertCustom = { ...snapshot.survivor.custom };
    for (const key of custom.retired) delete revertCustom[key];
    const customChanged = changedCustomKeys(survivor.custom, revertCustom);
    // M12: all or nothing under the undoer's CURRENT field security.
    const lockedFields = [
      ...(Object.keys(revert) as MergeField[]).filter(
        (field) => standardLevel(access, field) !== 'edit',
      ),
      ...customChanged
        .filter((key) => custom.defs.has(key) && customLevel(access, key) !== 'edit')
        .map((key) => `custom.${key}`),
    ];
    if (lockedFields.length > 0) throw fieldNotEditable(lockedFields);
    restoredOnSurvivor.push(...Object.keys(revert), ...customChanged.map((key) => `custom.${key}`));
  }

  // The merged contact comes back as it was, except that each compliance
  // field takes the stricter of its own and the survivor's current value.
  const restore = snapshotValues(snapshot.merged.values, MERGE_FIELDS);
  const compliance = strictestCompliance(
    complianceOf(snapshot.merged.values as MergeValues),
    complianceOf(survivor.values),
  );
  restore.dnd = compliance.dnd;
  restore.whatsappOptIn = compliance.whatsappOptIn;
  restore.consentState = compliance.consentState;
  await settleReferences(tx, programmeId, restore);
  const restoredCustom = { ...snapshot.merged.custom };
  for (const key of custom.retired) delete restoredCustom[key];

  if (!(await restoreContact(tx, { id: merged.id, programmeId }, restore, restoredCustom))) {
    throw alreadyMerged();
  }
  if (reverted) {
    await settleReferences(tx, programmeId, revert);
    const applied = await customBackstopAs400(() =>
      writeMergedValues(
        tx,
        { id: survivor.id, programmeId, version: survivor.version },
        revert,
        revertCustom,
      ),
    );
    if (applied === null) throw staleWrite();
  }
  // Only what the merge moved, and only if it still points at the survivor (M11).
  await moveContactChildren(tx, programmeId, survivor.id, merged.id, snapshot.moved);
  if (!(await markContactMergeUndone(tx, mergeId, reverted))) throw staleWrite();
  await recordAuditEvent(tx, {
    action: 'restored',
    objectType: 'contact',
    objectId: merged.id,
    objectLabel: merged.id,
    programmeId,
    changes: nameOnlyChanges(restoredOnSurvivor),
  });
  const done = await findContactMerge(tx, mergeId);
  if (done === null) throw notFound();
  return toContactMergeWire(done);
}

// --- listContactMerges ----------------------------------------------------------------

export async function listContactMergesFor(
  tx: TenantTx,
  query: unknown,
): Promise<{ data: ContactMergeWire[]; nextCursor: string | null }> {
  const page = PageQuery.parse(query); // 400
  const after = page.cursor === undefined ? null : decodeIdCursor(page.cursor); // 400
  // D-L151: contact.write in the programme (the tenant-admin flag included); others see none.
  const grants = await loadGrants(tx);
  const programmes = tx.session.programmeIds.filter((id) => canProgramme(grants, WRITE, id));
  const rows = await listContactMerges(tx, programmes, page.limit, after);
  return {
    data: rows.data.map(toContactMergeWire),
    nextCursor: rows.nextId === null ? null : encodeIdCursor(rows.nextId),
  };
}
