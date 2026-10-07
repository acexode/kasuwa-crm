import {
  activityFieldLevel,
  contactFieldLevel,
  findActivityTargetProgramme,
  isActivityType,
  isWithholdableContactField,
  listContactTimeline,
  loadActivityFieldAccess,
  loadContactFieldAccess,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type ActivityFieldAccess,
  type ContactFieldAccess,
  type TimelineActivityRow,
  type TimelineActorRow,
  type TimelineChangeRow,
  type TimelineRow,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { notFound } from '../admin/common/admin-errors';
import { CONSENT_STATES } from './contacts.schemas';

/**
 * listContactTimeline (T-0061; the T-0059 contract in records.openapi.yaml;
 * D-L72, D-L73, D-L81).
 *
 * 1. SCOPE FIRST. The contact must be one the session reaches; anything else
 *    is the one 404 body, and nothing about its history is read before that.
 *    A cursor is decoded only after, so a cursor never opens a contact.
 * 2. FIELD SECURITY, BEFORE PAGING. Judged today, in the contact's
 *    programme, by the set the caller holds there. The repository is handed
 *    the allow-list of change fields the caller may see, so withheld items
 *    never reach the LIMIT. `consent_changed` follows `consentState`; owner
 *    and account items follow theirs; `displayName` is never withheld.
 *    Activity items follow the ACTIVITY object's field security: a withheld
 *    subject, body, due or completed time is omitted from the item, and when
 *    `contact_id` is withheld no activity item is shown at all (the item
 *    itself would disclose the link).
 * 3. VALUES (D-L72). Only for the value fields, only when the event recorded
 *    them (T-0061 onward), decoded back into the Contact property's wire
 *    type. The redacted fields NEVER carry a value, whatever a row holds.
 *
 * NOTHING HERE LOGS: subjects and bodies hold names in practice.
 */

/** FieldChangeWithValues' `field` enum: values for these, from T-0061 on. */
export const TIMELINE_VALUE_FIELDS = [
  'status',
  'source',
  'preferredChannel',
  'preferredLanguage',
  'whatsappOptIn',
  'state',
  'lga',
  'tags',
] as const;

/** FieldChangeRedacted's `field` enum: never a value. */
export const TIMELINE_REDACTED_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'phones',
  'emails',
  'ownerUserId',
  'accountId',
] as const;

/** A change to this field is a `consent_changed` item. */
const CONSENT_FIELD = 'consentState';

const VALUE_FIELDS = new Set<string>(TIMELINE_VALUE_FIELDS);
const REDACTED_FIELDS = new Set<string>(TIMELINE_REDACTED_FIELDS);

export const TimelineQuery = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

// --- the wire ------------------------------------------------------------------

interface ItemBase {
  id: string;
  occurredAt: string;
  actor: TimelineActorRow | null;
}

type WireValue = string | boolean | string[] | null;

export type TimelineItemWire =
  | (ItemBase & { type: 'field_changed'; field: string; before?: WireValue; after?: WireValue })
  | (ItemBase & { type: 'field_changed'; field: string; redacted: true })
  | (ItemBase & { type: 'consent_changed'; before?: string; after?: string })
  | (ItemBase & {
      type: 'activity';
      activityId: string;
      activityType: string;
      subject?: string | null;
      body?: string | null;
      dueAt?: string | null;
      completedAt?: string | null;
    });

export interface TimelinePageWire {
  data: TimelineItemWire[];
  nextCursor: string | null;
}

// --- field security --------------------------------------------------------------

/**
 * The audit change fields the caller may see on this contact: every timeline
 * field whose Contact property is readable in `programmeId`. `displayName` is
 * never withheld. A field outside the closed union (a property a later slice
 * adds) is never shown until the contract names it.
 */
export function visibleChangeFields(access: ContactFieldAccess, programmeId: string): string[] {
  return [...TIMELINE_VALUE_FIELDS, ...TIMELINE_REDACTED_FIELDS, CONSENT_FIELD].filter(
    (field) =>
      field === 'displayName' ||
      (isWithholdableContactField(field) &&
        contactFieldLevel(access, programmeId, field) !== 'none'),
  );
}

// --- values ------------------------------------------------------------------------

const NO_VALUE = Symbol('no value');

/** One recorded value back in its wire type, or NO_VALUE when it does not decode. */
function decodeValue(field: string, value: string | null): WireValue | typeof NO_VALUE {
  if (value === null) return null;
  if (field === 'whatsappOptIn') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return NO_VALUE;
  }
  if (field === 'tags') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return NO_VALUE;
    }
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')
      ? (parsed as string[])
      : NO_VALUE;
  }
  return value;
}

const CONSENT = new Set<string>(CONSENT_STATES);

function changeItem(row: TimelineChangeRow): TimelineItemWire | null {
  const base: ItemBase = { id: row.itemId, occurredAt: row.occurredAt, actor: row.actor };
  if (row.field === CONSENT_FIELD) {
    // Consent values are ConsentState codes, never null: anything else is shown without values.
    if (
      !row.redacted &&
      row.before !== null &&
      row.after !== null &&
      CONSENT.has(row.before) &&
      CONSENT.has(row.after)
    ) {
      return { ...base, type: 'consent_changed', before: row.before, after: row.after };
    }
    return { ...base, type: 'consent_changed' };
  }
  if (REDACTED_FIELDS.has(row.field)) {
    return { ...base, type: 'field_changed', field: row.field, redacted: true };
  }
  if (VALUE_FIELDS.has(row.field)) {
    if (!row.redacted) {
      const before = decodeValue(row.field, row.before);
      const after = decodeValue(row.field, row.after);
      if (before !== NO_VALUE && after !== NO_VALUE) {
        return { ...base, type: 'field_changed', field: row.field, before, after };
      }
    }
    // Recorded before T-0061 (by name only), or not decodable: no values.
    return { ...base, type: 'field_changed', field: row.field };
  }
  // The repository only returns allow-listed fields; anything else is dropped.
  return null;
}

/** An activity row carries a type outside the contract. 0027's CHECK makes this impossible. */
class TimelineActivityTypeError extends Error {
  constructor() {
    super('A timeline activity carries an unknown type');
    this.name = 'TimelineActivityTypeError';
  }
}

function activityItem(
  row: TimelineActivityRow,
  access: ActivityFieldAccess,
  programmeId: string,
): TimelineItemWire {
  if (!isActivityType(row.activityType)) throw new TimelineActivityTypeError();
  const readable = (field: 'subject' | 'body' | 'dueAt' | 'completedAt') =>
    activityFieldLevel(access, programmeId, field) !== 'none';
  return {
    id: row.itemId,
    type: 'activity',
    occurredAt: row.occurredAt,
    actor: row.actor,
    activityId: row.activityId,
    activityType: row.activityType,
    ...(readable('subject') ? { subject: row.subject } : {}),
    ...(readable('body') ? { body: row.body } : {}),
    ...(readable('dueAt') ? { dueAt: row.dueAt?.toISOString() ?? null } : {}),
    ...(readable('completedAt') ? { completedAt: row.completedAt?.toISOString() ?? null } : {}),
  };
}

/** The wire items for a page of rows, field security applied to activity items. */
export function toTimelineItems(
  rows: readonly TimelineRow[],
  activityAccess: ActivityFieldAccess,
  programmeId: string,
): TimelineItemWire[] {
  const items: TimelineItemWire[] = [];
  for (const row of rows) {
    const item =
      row.kind === 'activity' ? activityItem(row, activityAccess, programmeId) : changeItem(row);
    if (item !== null) items.push(item);
  }
  return items;
}

// --- the operation -------------------------------------------------------------------

export async function listContactTimelineFor(
  tx: TenantTx,
  contactId: string,
  query: unknown,
): Promise<TimelinePageWire> {
  // 1. Scope first: one 404 for absent, another tenant's and a sibling's.
  const programmeId = await findActivityTargetProgramme(tx, { kind: 'contact', id: contactId });
  if (programmeId === null) throw notFound();
  // 2. Then the query (400), then the cursor (400 invalid_cursor, in the repository).
  const { cursor, limit } = TimelineQuery.parse(query);

  const [contactAccess, activityAccess] = [
    await loadContactFieldAccess(tx),
    await loadActivityFieldAccess(tx),
  ];
  const page = await listContactTimeline(tx, {
    contactId,
    programmeId,
    limit,
    cursor,
    visibleChangeFields: visibleChangeFields(contactAccess, programmeId),
    includeActivities: activityFieldLevel(activityAccess, programmeId, 'contactId') !== 'none',
  });
  return {
    data: toTimelineItems(page.rows, activityAccess, programmeId),
    nextCursor: page.nextCursor,
  };
}
