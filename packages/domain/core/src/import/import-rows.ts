import {
  CUSTOM_FIELD_LIMITS,
  customValueProblem,
  fieldLevel,
  jsonbTextOctets,
  type CustomFieldAccess,
} from '@kasuwa/metadata-engine';
import { z } from 'zod';
import {
  contactFieldLevel,
  isWithholdableContactField,
  type ContactFieldAccess,
} from '../contact/contact-fields';
import type { ContactPhone, ContactValues } from '../contact/contact.repository';
import {
  BCP47,
  CONTACT_MAX_EMAILS,
  CONTACT_MAX_PHONES,
  CONTACT_SOURCES,
  CONTACT_STATUSES,
  CONTACT_WRITABLE_FIELDS,
  ContactEmailSchema,
  ContactSourceSchema,
  PREFERRED_CHANNELS,
} from '../contact/contact-write-schema';
import { wholePhoneE164 } from '../contact/phone';
import { TOO_LONG_REASON, TOO_SHORT_REASON } from '../text';
import type { ImportMapping, ImportRowErrorCode } from './import-job.repository';
import { importCustomKey, isImportStandardField } from './import-mapping';

/**
 * One CSV row to the values of a NEW contact (T-0094; ADR-0017 flow step 4).
 *
 *   - Every field is checked with the contacts API's own schemas
 *     (`CONTACT_WRITABLE_FIELDS`, contact-write-schema.ts) and every
 *     `custom.<key>` with T-0089's per-definition rules
 *     (`customValueProblem`), so an import never writes what createContact
 *     would refuse; the assembled values pass the create schema once more.
 *   - Phones are normalised to E.164 with the mapping's default country, the
 *     trunk `0` dropped (`wholePhoneE164`; NG, GH, KE, ZA; R16).
 *   - COMPLIANCE (D-P28, D-L148): restrict-or-default only. `dnd` true or
 *     false; `whatsappOptIn` false; `consentState` withdrawn or unknown. A
 *     granting value is `consent_grant_refused`, and the row is not created.
 *     Only the exact lower-case spellings are read; anything else is
 *     `invalid_value`, so no spelling of a grant ever grants (R8).
 *   - FIELD SECURITY is judged here, at run time (R12): a mapped field the
 *     creator may not edit is `field_not_editable` at its column for every
 *     row that carries a value there.
 *   - An error is `{ column, code }`: never the cell, a header or a message.
 *
 * Pure: no database, no logging.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 26_214_400,
  maxParts: 4,
  minPartBytes: 5_242_880,
  maxRows: 100_000,
  maxRowBytes: 65_536,
  maxColumns: 500,
  maxErrors: 1_000,
  maxHeaderBytes: 255,
});

export interface ImportCellError {
  readonly column: number | null;
  readonly code: ImportRowErrorCode;
}

export interface ImportRowContext {
  readonly mapping: ImportMapping;
  readonly programmeId: string;
  readonly contactAccess: ContactFieldAccess;
  readonly custom: CustomFieldAccess;
}

export type ParsedImportRow =
  | {
      readonly ok: true;
      readonly values: ContactValues & { displayName: string };
      readonly custom: Record<string, unknown>;
      readonly dnd: boolean;
    }
  | { readonly ok: false; readonly errors: readonly ImportCellError[] };

/** The create schema an assembled row passes once more (the API's `CreateContactBody` minus target and custom). */
const ImportedContactSchema = z
  .object({ ...CONTACT_WRITABLE_FIELDS, source: ContactSourceSchema.optional() })
  .strict();

/** A text issue's code: too long, required (too short), or anything else invalid. */
function textCode(error: z.ZodError, emptyIsRequired: boolean): ImportRowErrorCode {
  for (const issue of error.issues) {
    const reason = issue.code === 'custom' ? issue.params?.['reason'] : undefined;
    if (reason === TOO_LONG_REASON || issue.code === 'too_big') return 'too_long';
    if (reason === TOO_SHORT_REASON || issue.code === 'too_small') {
      return emptyIsRequired ? 'required' : 'invalid_value';
    }
  }
  return 'invalid_value';
}

const lowerEnum = <T extends readonly string[]>(values: T, cell: string): T[number] | null => {
  const lowered = cell.toLowerCase();
  return (values as readonly string[]).includes(lowered) ? (lowered as T[number]) : null;
};

const TAG_SEPARATOR = /[;,]/u;

/** Parses one record. `record` is the row's cells by column index. */
export function parseImportRow(record: readonly string[], context: ImportRowContext): ParsedImportRow {
  const errors: ImportCellError[] = [];
  const fail = (column: number | null, code: ImportRowErrorCode) => errors.push({ column, code });
  const values: ContactValues = {};
  const custom: Record<string, unknown> = {};
  let dnd = false;
  let displayNameColumn: number | null = null;
  let firstCustomColumn: number | null = null;
  const nameParts: { column: number; field: 'givenNames' | 'familyName' }[] = [];
  const phones: ContactPhone[] = [];
  const emails: string[] = [];
  const tags: string[] = [];

  const columns = [...context.mapping.columns].sort((a, b) => a.index - b.index);
  for (const { index, field } of columns) {
    if (field === null) continue;
    const cell = (record[index] ?? '').trim();
    if (field === 'displayName') displayNameColumn = index;
    if (field === 'givenNames' || field === 'familyName') nameParts.push({ column: index, field });
    if (cell === '') continue;
    // D-L167 N6: Postgres text cannot hold U+0000, so a NUL in ANY mapped
    // cell (tags, state, custom text included) is this row's error, never a
    // failed statement that ends the job.
    if (cell.includes('\u0000')) {
      fail(index, 'invalid_value');
      continue;
    }

    const customKey = importCustomKey(field);
    if (customKey !== null) {
      firstCustomColumn ??= index;
      const def = context.custom.defs.get(customKey);
      if (def === undefined) {
        fail(index, 'unknown_field');
        continue;
      }
      if (fieldLevel(context.custom.access, context.programmeId, customKey) !== 'edit') {
        fail(index, 'field_not_editable');
        continue;
      }
      let value: unknown = cell;
      if (def.type === 'boolean') value = cell === 'true' ? true : cell === 'false' ? false : cell;
      if (def.type === 'currency') value = { amountMinor: cell, currency: def.currencyCode };
      const problem = customValueProblem(def, value);
      if (problem !== null) {
        fail(index, problem.code === 'unknown_value' ? 'unknown_value' : 'invalid_value');
        continue;
      }
      custom[customKey] = value;
      continue;
    }

    if (!isImportStandardField(field)) {
      fail(index, 'unknown_field');
      continue;
    }
    if (
      isWithholdableContactField(field) &&
      contactFieldLevel(context.contactAccess, context.programmeId, field) !== 'edit'
    ) {
      fail(index, 'field_not_editable');
      continue;
    }

    switch (field) {
      case 'displayName':
      case 'givenNames':
      case 'familyName':
      case 'companyName': {
        const parsed = CONTACT_WRITABLE_FIELDS[field].safeParse(cell);
        if (parsed.success) values[field] = cell;
        else fail(index, textCode(parsed.error, field === 'displayName'));
        break;
      }
      case 'phones': {
        const e164 = wholePhoneE164(cell, context.mapping.defaultCountry);
        if (e164 === null) fail(index, 'invalid_phone');
        else if (!phones.some((p) => p.e164 === e164)) phones.push({ type: 'mobile', e164 });
        break;
      }
      case 'emails': {
        if (ContactEmailSchema.safeParse(cell).success) {
          if (!emails.some((e) => e.toLowerCase() === cell.toLowerCase())) emails.push(cell);
        } else {
          fail(index, 'invalid_email');
        }
        break;
      }
      case 'status': {
        const status = lowerEnum(CONTACT_STATUSES, cell);
        if (status === null) fail(index, 'unknown_value');
        else values.status = status;
        break;
      }
      case 'source': {
        const source = lowerEnum(CONTACT_SOURCES, cell);
        if (source === null) fail(index, 'unknown_value');
        else values.source = source;
        break;
      }
      case 'preferredChannel': {
        const channel = lowerEnum(PREFERRED_CHANNELS, cell);
        if (channel === null) fail(index, 'unknown_value');
        else values.preferredChannel = channel;
        break;
      }
      case 'tags': {
        const parts = cell.split(TAG_SEPARATOR).map((t) => t.trim()).filter((t) => t !== '');
        if (parts.some((t) => t.length > 64)) fail(index, 'too_long');
        else for (const tag of parts) if (!tags.includes(tag)) tags.push(tag);
        break;
      }
      case 'preferredLanguage':
        if (cell.length <= 35 && BCP47.test(cell)) values.preferredLanguage = cell;
        else fail(index, 'invalid_value');
        break;
      case 'state':
      case 'lga':
        if (cell.length <= 64 && !cell.includes('\u0000')) values[field] = cell;
        else fail(index, cell.length > 64 ? 'too_long' : 'invalid_value');
        break;
      case 'dnd':
        if (cell === 'true' || cell === 'false') dnd = cell === 'true';
        else fail(index, 'invalid_value');
        break;
      case 'whatsappOptIn':
        if (cell === 'false') values.whatsappOptIn = false;
        else fail(index, cell === 'true' ? 'consent_grant_refused' : 'invalid_value');
        break;
      case 'consentState':
        if (cell === 'withdrawn' || cell === 'unknown') values.consentState = cell;
        else fail(index, cell === 'opted_in' || cell === 'pending' ? 'consent_grant_refused' : 'invalid_value');
        break;
    }
  }

  // displayName: from its own column when mapped (empty is `required` there),
  // else from the given and family names.
  if (displayNameColumn !== null) {
    if (values.displayName === undefined && !errors.some((e) => e.column === displayNameColumn)) {
      fail(displayNameColumn, 'required');
    }
  } else {
    const joined = nameParts
      .map((part) => values[part.field])
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' ');
    const column = nameParts[0]?.column ?? null;
    if (joined === '') {
      if (!errors.some((e) => nameParts.some((part) => part.column === e.column))) fail(column, 'required');
    } else if (!CONTACT_WRITABLE_FIELDS.displayName.safeParse(joined).success) {
      fail(column, 'too_long');
    } else {
      values.displayName = joined;
    }
  }

  if (phones.length > CONTACT_MAX_PHONES || emails.length > CONTACT_MAX_EMAILS || tags.length > 50) {
    fail(null, 'too_long');
  }
  if (phones.length > 0) values.phones = phones;
  if (emails.length > 0) values.emails = emails;
  if (tags.length > 0) values.tags = tags;
  if (Object.keys(custom).length > 0 && jsonbTextOctets(custom) > CUSTOM_FIELD_LIMITS.apiBytes) {
    fail(firstCustomColumn, 'custom_too_large');
  }
  values.source ??= 'import';
  if (context.mapping.ownerUserId !== null) {
    if (contactFieldLevel(context.contactAccess, context.programmeId, 'ownerUserId') === 'edit') {
      values.ownerUserId = context.mapping.ownerUserId;
    } else {
      fail(null, 'field_not_editable');
    }
  }

  if (errors.length === 0 && !ImportedContactSchema.safeParse(values).success) fail(null, 'invalid_value');
  if (errors.length > 0) {
    return { ok: false, errors: errors.sort((a, b) => (a.column ?? -1) - (b.column ?? -1)) };
  }
  return { ok: true, values: values as ContactValues & { displayName: string }, custom, dnd };
}
