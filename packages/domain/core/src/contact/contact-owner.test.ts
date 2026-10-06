import { describe, expect, it } from 'vitest';
import { contactOwnerOf, ContactOwnerUnresolvedError } from './contact.repository';

// Invented (CLAUDE.md 6.1).
const OWNER_ID = '11111111-0000-4000-8000-0000004300a2';

describe('contactOwnerOf (T-0043)', () => {
  it('is null exactly when the contact has no owner', () => {
    expect(contactOwnerOf(null, null)).toBeNull();
    // A stray name with no owner id is still unassigned, never a half owner.
    expect(contactOwnerOf(null, 'Probe Owner')).toBeNull();
  });

  it('is exactly { id, displayName } for an owned contact, id equal to ownerUserId', () => {
    const owner = contactOwnerOf(OWNER_ID, 'Probe Owner');
    expect(owner).toEqual({ id: OWNER_ID, displayName: 'Probe Owner' });
    expect(Object.keys(owner ?? {}).sort()).toEqual(['displayName', 'id']);
  });

  it('fails rather than sending owner: null beside a set ownerUserId, naming nobody', () => {
    let thrown: unknown;
    try {
      contactOwnerOf(OWNER_ID, null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContactOwnerUnresolvedError);
    expect(String((thrown as Error).message)).not.toContain(OWNER_ID);
  });
});
