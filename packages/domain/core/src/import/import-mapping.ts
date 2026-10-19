import type { ImportColumnMapping } from './import-job.repository';

/**
 * The fields a CSV column may set (records.openapi.yaml ImportField), and the
 * header-name guess behind `suggestedMapping` (T-0094).
 *
 * Pure. Header names are user text: nothing here logs one, and the guess
 * returns only field names and indices, never a header.
 */

/** The standard contact api names a column may set. Never an id, programme, owner or account. */
export const IMPORT_STANDARD_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
  'dnd',
  'whatsappOptIn',
  'consentState',
] as const;
export type ImportStandardField = (typeof IMPORT_STANDARD_FIELDS)[number];

/** The only fields more than one column may map (the contract). */
export const IMPORT_REPEATABLE_FIELDS: readonly ImportStandardField[] = ['phones', 'emails', 'tags'];

/** `custom.<key>`, the key a custom api name. */
export const IMPORT_CUSTOM_FIELD = /^custom\.([a-z][a-z0-9_]*__c)$/u;

export function isImportStandardField(value: string): value is ImportStandardField {
  return (IMPORT_STANDARD_FIELDS as readonly string[]).includes(value);
}

/** The custom key of `custom.<key>`, or null. */
export function importCustomKey(field: string): string | null {
  return IMPORT_CUSTOM_FIELD.exec(field)?.[1] ?? null;
}

/** Header spellings, folded (lower case, letters and digits only), per field. */
const SYNONYMS: Readonly<Record<string, ImportStandardField>> = {
  name: 'displayName',
  fullname: 'displayName',
  displayname: 'displayName',
  contactname: 'displayName',
  customername: 'displayName',
  firstname: 'givenNames',
  givenname: 'givenNames',
  givennames: 'givenNames',
  forename: 'givenNames',
  lastname: 'familyName',
  surname: 'familyName',
  familyname: 'familyName',
  company: 'companyName',
  companyname: 'companyName',
  business: 'companyName',
  businessname: 'companyName',
  organisation: 'companyName',
  organization: 'companyName',
  phone: 'phones',
  phones: 'phones',
  phonenumber: 'phones',
  mobile: 'phones',
  mobilenumber: 'phones',
  telephone: 'phones',
  tel: 'phones',
  msisdn: 'phones',
  whatsappnumber: 'phones',
  email: 'emails',
  emails: 'emails',
  emailaddress: 'emails',
  status: 'status',
  leadstatus: 'status',
  source: 'source',
  leadsource: 'source',
  tags: 'tags',
  tag: 'tags',
  labels: 'tags',
  language: 'preferredLanguage',
  preferredlanguage: 'preferredLanguage',
  channel: 'preferredChannel',
  preferredchannel: 'preferredChannel',
  state: 'state',
  lga: 'lga',
  dnd: 'dnd',
  donotdisturb: 'dnd',
  whatsapp: 'whatsappOptIn',
  whatsappoptin: 'whatsappOptIn',
  consent: 'consentState',
  consentstate: 'consentState',
};

function fold(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A guess by header name: a standard field when the folded header is a known
 * spelling, else `null` (ignore). A non-repeatable field is suggested once,
 * for its first column; custom fields are never guessed.
 */
export function suggestImportMapping(headers: readonly string[]): ImportColumnMapping[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const field = SYNONYMS[fold(header)] ?? null;
    if (field === null) return { index, field: null };
    if (!IMPORT_REPEATABLE_FIELDS.includes(field) && used.has(field)) return { index, field: null };
    used.add(field);
    return { index, field };
  });
}
