import { z } from 'zod';
import { text } from '../text';
import { E164 } from './phone';

/**
 * The contact write fields' boundary schemas (T-0039 contract), shared by the
 * contacts API (`apps/api/src/contacts/contacts.schemas.ts` composes
 * `CreateContactBody` and `UpdateContactBody` from them) and the import worker
 * (T-0094), which parses every CSV row with exactly these schemas (ADR-0017
 * flow step 4). One definition, so an import can never accept a value the API
 * would refuse.
 *
 * Parse, never cast (CLAUDE.md 4). Free text goes through `text()` (D-L78).
 */

export const CONTACT_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'customer',
] as const;
export const CONTACT_SOURCES = [
  'whatsapp',
  'ussd',
  'web_form',
  'missed_call',
  'import',
  'api',
  'manual',
  'referral',
  'walk_in',
] as const;
export const PREFERRED_CHANNELS = ['whatsapp', 'sms', 'voice', 'email'] as const;
export const CONSENT_STATES = ['unknown', 'opted_in', 'pending', 'withdrawn'] as const;
export const PHONE_TYPES = ['mobile', 'work', 'home', 'other'] as const;

export const ContactPhoneSchema = z
  .object({
    type: z.enum(PHONE_TYPES),
    e164: z.string().regex(E164),
  })
  .strict();

export const ContactEmailSchema = z.string().max(254).email();

/**
 * RFC 5646 langtag structure, the same expression as 0019's
 * contact_preferred_language_bcp47_check, so a bad tag is a 400 here rather
 * than a CHECK violation (a 500) there.
 */
export const BCP47 = new RegExp(
  '^((' +
    '([A-Za-z]{2,3}(-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})' +
    '(-[A-Za-z]{4})?' +
    '(-([A-Za-z]{2}|[0-9]{3}))?' +
    '(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*' +
    '(-[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+)*' +
    '(-[Xx](-[A-Za-z0-9]{1,8})+)?' +
    ')|([Xx](-[A-Za-z0-9]{1,8})+))$',
);

/** The most numbers a contact holds; the duplicates ordinal cap derives from it (T-0095). */
export const CONTACT_MAX_PHONES = 10;
/** The most addresses a contact holds; the duplicates ordinal cap derives from it (T-0095). */
export const CONTACT_MAX_EMAILS = 10;

/**
 * Properties both contact writes accept, as the contract names them. The
 * free-text names go through `text()` (D-L78): a NUL is 400
 * `invalid_character`, never a Postgres 22021 (a 500); lengths are counted in
 * code points.
 */
export const CONTACT_WRITABLE_FIELDS = {
  displayName: text(1, 200),
  givenNames: text(0, 200).nullable().optional(),
  familyName: text(0, 200).nullable().optional(),
  // T-0076 (D-L82): 1..200 code points, no NUL; `null` clears it, "" is 400.
  companyName: text(1, 200).nullable().optional(),
  phones: z.array(ContactPhoneSchema).max(CONTACT_MAX_PHONES).optional(),
  emails: z.array(ContactEmailSchema).max(CONTACT_MAX_EMAILS).optional(),
  accountId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  preferredLanguage: z.string().max(35).regex(BCP47).nullable().optional(),
  preferredChannel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
  state: z.string().max(64).nullable().optional(),
  lga: z.string().max(64).nullable().optional(),
  whatsappOptIn: z.boolean().optional(),
  consentState: z.enum(CONSENT_STATES).optional(),
};

/** createContact's `source` (not on update: how a contact arrived does not change). */
export const ContactSourceSchema = z.enum(CONTACT_SOURCES);
