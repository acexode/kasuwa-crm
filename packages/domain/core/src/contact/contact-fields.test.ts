import { STANDARD_OBJECT_CATALOGUE } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  contactFieldAccessFromObjectAccess,
  contactFieldApiName,
  contactFieldLevel,
  displayNameReadable,
  displayNameWithheldAnywhere,
  notEditableContactFields,
  notEditableContactUpdateFields,
  programmesReading,
  programmesReadingDisplayName,
  summaryDisplayName,
  WITHHOLDABLE_CONTACT_FIELDS,
  withheldAnywhere,
  withheldContactFields,
  type ContactFieldLevel,
} from './contact-fields';

/*
 * The matrix semantics (set held in the programme, D-L45 default, locked
 * sets, no-set weakest, fail closed on a missing membership) live in
 * @kasuwa/metadata-engine's resolveFieldAccess since T-0053 and are unit-tested
 * there. This file tests what is contact-specific: the wire-name mapping and
 * the helpers the contacts API calls.
 */

const A1 = 'programme-a1';
const A2 = 'programme-a2';

/** The generic per-object answer: every contact field_def `edit`, except `overrides`. */
function objectAccess(
  perProgramme: Record<string, Record<string, ContactFieldLevel>>,
): Map<string, Map<string, ContactFieldLevel>> {
  return new Map(
    Object.entries(perProgramme).map(([programmeId, overrides]) => {
      const levels = new Map<string, ContactFieldLevel>(
        WITHHOLDABLE_CONTACT_FIELDS.map((field) => [contactFieldApiName(field), 'edit']),
      );
      for (const [field, level] of Object.entries(overrides)) levels.set(field, level);
      return [programmeId, levels];
    }),
  );
}

describe('contactFieldApiName', () => {
  it('is the snake_case of the wire name (S3)', () => {
    expect(contactFieldApiName('emails')).toBe('emails');
    expect(contactFieldApiName('ownerUserId')).toBe('owner_user_id');
    expect(contactFieldApiName('whatsappOptIn')).toBe('whatsapp_opt_in');
  });
});

describe('contact field access from the generic per-object loader (T-0053)', () => {
  it('re-keys snake_case field_def names to wire names, per reachable programme', () => {
    const access = contactFieldAccessFromObjectAccess(
      objectAccess({ [A1]: { given_names: 'read', whatsapp_opt_in: 'none' } }),
      [A1],
    );
    expect(contactFieldLevel(access, A1, 'givenNames')).toBe('read');
    expect(withheldContactFields(access, A1)).toEqual(['whatsappOptIn']);
  });

  it('fails closed: a programme or a field the generic answer lacks is none, never the default', () => {
    const generic = new Map([[A1, new Map<string, ContactFieldLevel>([['emails', 'edit']])]]);
    const access = contactFieldAccessFromObjectAccess(generic, [A1, A2]);
    expect(withheldContactFields(access, A1)).toEqual(
      WITHHOLDABLE_CONTACT_FIELDS.filter((field) => field !== 'emails'),
    );
    expect(withheldContactFields(access, A2)).toEqual([...WITHHOLDABLE_CONTACT_FIELDS]);
  });

  it('fails closed for a programme it was not told about', () => {
    const access = contactFieldAccessFromObjectAccess(objectAccess({ [A1]: {} }), [A1]);
    expect(contactFieldLevel(access, A2, 'phones')).toBe('none');
  });

  it('the standard contact catalogue has a field_def for exactly the withholdable properties', () => {
    // If these drift, the fail-closed rule above withholds a field from
    // everyone (catalogue short) or the matrix shows a row that does nothing
    // (catalogue long). A new withholdable property needs a catalogue entry
    // and a backfilling migration in the same change.
    const contact = STANDARD_OBJECT_CATALOGUE.find((object) => object.apiName === 'contact');
    expect(contact?.fields.map((field) => field.apiName).sort()).toEqual(
      WITHHOLDABLE_CONTACT_FIELDS.map(contactFieldApiName).sort(),
    );
  });
});

describe('the per-programme helpers', () => {
  const access = contactFieldAccessFromObjectAccess(
    objectAccess({ [A1]: {}, [A2]: { emails: 'none', lga: 'read' } }),
    [A1, A2],
  );

  it('decide per programme', () => {
    expect(withheldContactFields(access, A1)).toEqual([]);
    expect(withheldContactFields(access, A2)).toEqual(['emails']);
    expect(contactFieldLevel(access, A2, 'lga')).toBe('read');
    expect(programmesReading(access, 'emails')).toEqual([A1]);
    expect(withheldAnywhere(access, 'emails')).toBe(true);
    expect(withheldAnywhere(access, 'lga')).toBe(false);
  });
});

describe('notEditableContactFields', () => {
  const access = contactFieldAccessFromObjectAccess(
    objectAccess({ [A1]: { emails: 'none', lga: 'read' } }),
    [A1],
  );

  it('names every sent field below edit, withheld and read-only alike', () => {
    expect(notEditableContactFields(access, A1, ['status', 'emails', 'lga', 'phones'])).toEqual([
      'emails',
      'lga',
    ]);
  });

  it('leaves unknown, never-withheld and server-owned names to the body schema', () => {
    expect(notEditableContactFields(access, A1, ['version', 'displayName', 'nickname'])).toEqual(
      [],
    );
  });
});

describe('displayName follows its name parts (D-L68, T-0124 I1)', () => {
  const access = (perProgramme: Record<string, Record<string, ContactFieldLevel>>) =>
    contactFieldAccessFromObjectAccess(objectAccess(perProgramme), Object.keys(perProgramme));

  it('is readable exactly when both givenNames and familyName are readable (read or edit)', () => {
    const cases: [Record<string, ContactFieldLevel>, boolean][] = [
      [{}, true],
      [{ given_names: 'read', family_name: 'read' }, true],
      [{ family_name: 'read' }, true],
      [{ given_names: 'none' }, false],
      [{ family_name: 'none' }, false],
      [{ given_names: 'none', family_name: 'none' }, false],
      // Another field withheld changes nothing.
      [{ emails: 'none', company_name: 'none' }, true],
    ];
    for (const [overrides, readable] of cases) {
      expect(displayNameReadable(access({ [A1]: overrides }), A1), JSON.stringify(overrides)).toBe(
        readable,
      );
    }
  });

  it('fails closed for a programme the access map does not know', () => {
    expect(displayNameReadable(access({ [A1]: {} }), A2)).toBe(false);
  });

  it('is judged per programme', () => {
    const both = access({ [A1]: { family_name: 'none' }, [A2]: {} });
    expect(programmesReadingDisplayName(both)).toEqual([A2]);
    expect(displayNameWithheldAnywhere(both)).toBe(true);
    expect(displayNameWithheldAnywhere(access({ [A1]: {}, [A2]: {} }))).toBe(false);
  });

  it('a summary carries the name or null, never a part', () => {
    const both = access({ [A1]: { given_names: 'none' }, [A2]: {} });
    expect(summaryDisplayName(both, A1, 'Zq Person')).toBeNull();
    expect(summaryDisplayName(both, A2, 'Zq Person')).toBe('Zq Person');
    expect(summaryDisplayName(both, A2, null)).toBeNull();
  });

  it('an update naming displayName is refused only where it is withheld, in the order sent; create is not judged here (I11)', () => {
    const hidden = access({ [A1]: { family_name: 'none', emails: 'read' } });
    expect(
      notEditableContactUpdateFields(hidden, A1, ['status', 'displayName', 'emails', 'version']),
    ).toEqual(['displayName', 'emails']);
    expect(notEditableContactFields(hidden, A1, ['displayName'])).toEqual([]);
    const readOnlyPart = access({ [A1]: { family_name: 'read' } });
    expect(notEditableContactUpdateFields(readOnlyPart, A1, ['displayName'])).toEqual([]);
  });
});
