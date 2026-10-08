import { describe, expect, it } from 'vitest';
import { contactOwnerOf, ContactOwnerUnresolvedError } from './contact.repository';

// Invented (CLAUDE.md 6.1).
const OWNER_ID = '11111111-0000-4000-8000-0000004300a2';

describe('contactOwnerOf (T-0043, T-0103)', () => {
  it('is null exactly when the contact has no owner', () => {
    expect(contactOwnerOf(null, null, null)).toBeNull();
    // A stray name with no owner id is still unassigned, never a half owner.
    expect(contactOwnerOf(null, true, 'Probe Owner')).toBeNull();
    expect(contactOwnerOf(null, false, null)).toBeNull();
  });

  it('is exactly { id, displayName } for a member owner, id equal to ownerUserId', () => {
    const owner = contactOwnerOf(OWNER_ID, true, 'Probe Owner');
    expect(owner).toEqual({ id: OWNER_ID, displayName: 'Probe Owner' });
    expect(Object.keys(owner ?? {}).sort()).toEqual(['displayName', 'id']);
  });

  it('is a former owner, { id, displayName: null }, for an owner outside the programme (D-P23)', () => {
    const owner = contactOwnerOf(OWNER_ID, false, null);
    expect(owner).toEqual({ id: OWNER_ID, displayName: null });
    expect(Object.keys(owner ?? {}).sort()).toEqual(['displayName', 'id']);
  });

  it('never prints a name for a non-member, even if one were read beside it', () => {
    expect(contactOwnerOf(OWNER_ID, false, 'Probe Owner')).toEqual({
      id: OWNER_ID,
      displayName: null,
    });
    // A missing membership answer is not membership: fail closed to "former".
    expect(contactOwnerOf(OWNER_ID, null, 'Probe Owner')).toEqual({
      id: OWNER_ID,
      displayName: null,
    });
  });

  it('fails for a member whose name could not be read (schema drift), naming nobody', () => {
    let thrown: unknown;
    try {
      contactOwnerOf(OWNER_ID, true, null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContactOwnerUnresolvedError);
    expect(String((thrown as Error).message)).not.toContain(OWNER_ID);
  });
});
