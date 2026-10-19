import { describe, expect, it } from 'vitest';
import {
  contactFieldApiName,
  DISPLAY_NAME_PARTS,
  WITHHOLDABLE_CONTACT_FIELDS,
} from '../contact/contact-fields';
import { notificationNameReadable } from './notification.repository';

const P1 = '11111111-0000-4000-8000-0000001240a1';

/** Generic (api-name) contact access in P1: every field `edit`, except `overrides`. */
function contactAccess(overrides: Record<string, 'none' | 'read' | 'edit'> = {}) {
  const levels = new Map<string, 'none' | 'read' | 'edit'>(
    WITHHOLDABLE_CONTACT_FIELDS.map((field) => [contactFieldApiName(field), 'edit']),
  );
  for (const [field, level] of Object.entries(overrides)) levels.set(field, level);
  return new Map([[P1, levels]]);
}

describe('notificationNameReadable follows the shared displayName rule (D-L68, D-L184)', () => {
  it('a contact name is readable exactly when every part in DISPLAY_NAME_PARTS is', () => {
    expect(notificationNameReadable('contact', contactAccess(), P1)).toBe(true);
    expect(notificationNameReadable('contact', contactAccess({ family_name: 'read' }), P1)).toBe(true);
    for (const part of DISPLAY_NAME_PARTS) {
      const access = contactAccess({ [contactFieldApiName(part)]: 'none' });
      expect(notificationNameReadable('contact', access, P1), part).toBe(false);
    }
    // Fail closed: a programme the access does not know.
    expect(notificationNameReadable('contact', contactAccess(), 'elsewhere')).toBe(false);
  });

  it('adding a hypothetical third part to the parts list makes notifications withhold: it reads the list, not a copy', () => {
    const access = contactAccess({ company_name: 'none' });
    expect(notificationNameReadable('contact', access, P1)).toBe(true);
    expect(
      notificationNameReadable('contact', access, P1, [...DISPLAY_NAME_PARTS, 'companyName']),
    ).toBe(false);
  });

  it('other objects keep their own name field', () => {
    const access = new Map([[P1, new Map([['name', 'none' as const], ['subject', 'read' as const]])]]);
    expect(notificationNameReadable('account', access, P1)).toBe(false);
    expect(notificationNameReadable('deal', access, P1)).toBe(false);
    expect(notificationNameReadable('activity', access, P1)).toBe(true);
  });
});
