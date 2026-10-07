import { describe, expect, it } from 'vitest';
import { contactAccountOf, ContactAccountUnresolvedError } from './contact.repository';

// Invented (CLAUDE.md 6.1).
const ACCOUNT_ID = '11111111-0000-4000-8000-0000006100a1';

describe('contactAccountOf (T-0061)', () => {
  it('is null exactly when the contact has no account, whatever the name column says', () => {
    expect(contactAccountOf(null, null)).toBeNull();
    expect(contactAccountOf(null, 'Probe Traders')).toBeNull();
  });

  it('is { id, name } beside a set accountId, and closed', () => {
    const account = contactAccountOf(ACCOUNT_ID, 'Probe Traders');
    expect(account).toEqual({ id: ACCOUNT_ID, name: 'Probe Traders' });
    expect(Object.keys(account ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('refuses to send null beside a set accountId (that would read as "no account")', () => {
    let thrown: unknown;
    try {
      contactAccountOf(ACCOUNT_ID, null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContactAccountUnresolvedError);
    expect(String((thrown as Error).message)).not.toContain(ACCOUNT_ID);
  });
});
