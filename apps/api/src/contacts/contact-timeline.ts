import {
  contactFieldLevel,
  isWithholdableContactField,
  loadContactFieldAccess,
  type ActivityFieldAccess,
  type ContactFieldAccess,
  type TimelineChangeRow,
  type TimelineRow,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import {
  itemBase,
  readRecordTimeline,
  timelineItems,
  type ActivityItemWire,
  type RecordTimelineSpec,
  type TimelineItemBase,
  type TimelinePage,
} from '../timeline/record-timeline';
import { CONSENT_STATES } from './contacts.schemas';

export { TimelineQuery } from '../timeline/record-timeline';

/**
 * listContactTimeline (T-0061; the T-0059 contract in records.openapi.yaml;
 * D-L72, D-L73, D-L81), on the record timeline both timelines share
 * (`../timeline/record-timeline.ts`, T-0080): scope first, the query, both
 * matrices once, field security before paging, the activity item.
 *
 * What only the contact's timeline decides:
 *   - FIELD SECURITY: the CONTACT matrix judges change items.
 *     `consent_changed` follows `consentState`; owner and account items
 *     follow theirs; `displayName` is never withheld. An activity is on it
 *     through its `contact_id`, so a withheld `contact_id` hides every
 *     activity item.
 *   - VALUES (D-L72). Only for the value fields, only when the event recorded
 *     them (T-0061 onward), decoded back into the Contact property's wire
 *     type. The redacted fields NEVER carry a value, whatever a row holds.
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
  // T-0076 (D-L82): free text, often a sole trader's own name. Never a value.
  'companyName',
  'phones',
  'emails',
  'ownerUserId',
  'accountId',
] as const;

/** A change to this field is a `consent_changed` item. */
const CONSENT_FIELD = 'consentState';

const VALUE_FIELDS = new Set<string>(TIMELINE_VALUE_FIELDS);
const REDACTED_FIELDS = new Set<string>(TIMELINE_REDACTED_FIELDS);

// --- the wire ------------------------------------------------------------------

type WireValue = string | boolean | string[] | null;

export type ContactChangeItemWire =
  | (TimelineItemBase & {
      type: 'field_changed';
      field: string;
      before?: WireValue;
      after?: WireValue;
    })
  | (TimelineItemBase & { type: 'field_changed'; field: string; redacted: true })
  | (TimelineItemBase & { type: 'consent_changed'; before?: string; after?: string });

export type TimelineItemWire = ContactChangeItemWire | ActivityItemWire;

export type TimelinePageWire = TimelinePage<TimelineItemWire>;

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

function changeItem(row: TimelineChangeRow): ContactChangeItemWire | null {
  const base = itemBase(row);
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

/** The wire items for a page of contact timeline rows, field security applied to activity items. */
export function toTimelineItems(
  rows: readonly TimelineRow[],
  activityAccess: ActivityFieldAccess,
  programmeId: string,
): TimelineItemWire[] {
  return timelineItems(rows, activityAccess, programmeId, changeItem);
}

// --- the operation -------------------------------------------------------------------

export const CONTACT_TIMELINE: RecordTimelineSpec<ContactFieldAccess, ContactChangeItemWire> = {
  subject: 'contact',
  loadRecordAccess: loadContactFieldAccess,
  visibleChangeFields,
  changeItem,
  activityLink: 'contactId',
};

/** `contactId` is the parsed path id (a malformed one is 400 here, T-0061's contract). */
export async function listContactTimelineFor(
  tx: TenantTx,
  contactId: string,
  query: unknown,
): Promise<TimelinePageWire> {
  return readRecordTimeline(tx, CONTACT_TIMELINE, contactId, query);
}
