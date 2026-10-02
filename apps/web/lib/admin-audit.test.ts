import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  looksLikeIdentifier,
  rangeToFrom,
  withheldIfIdentifier,
} from './admin-audit';

describe('withheldIfIdentifier', () => {
  it('passes a configuration label through unchanged', () => {
    expect(withheldIfIdentifier('Workspace MFA policy')).toBe('Workspace MFA policy');
    expect(withheldIfIdentifier('Contact · BVN')).toBe('Contact · BVN');
    expect(withheldIfIdentifier('Amaka Okafor')).toBe('Amaka Okafor');
  });

  it('withholds an email address', () => {
    // The design's "Invited · fatima.bello@…" row is exactly what the contract
    // rules out: an address is a credential-adjacent identifier, and "can read
    // the audit log" is one of the most widely granted admin permissions.
    expect(looksLikeIdentifier('fatima.bello@sabicc.example')).toBe(true);
    expect(withheldIfIdentifier('Invited fatima.bello@sabicc.example')).toBeNull();
  });

  it('does not mistake a lone @ for an address', () => {
    expect(withheldIfIdentifier('Policy @ 2026')).toBe('Policy @ 2026');
  });
});

describe('rangeToFrom', () => {
  const now = new Date('2026-09-30T10:00:00.000Z');

  it('computes UTC bounds in the client, as the contract requires', () => {
    expect(rangeToFrom('1', now)).toBe('2026-09-29T10:00:00.000Z');
    expect(rangeToFrom('7', now)).toBe('2026-09-23T10:00:00.000Z');
    expect(rangeToFrom('30', now)).toBe('2026-08-31T10:00:00.000Z');
  });

  it('sends no bound at all for "all time" rather than a very old one', () => {
    expect(rangeToFrom('all', now)).toBeUndefined();
  });
});

describe('activeFilterCount', () => {
  const none = {
    actorId: '',
    action: '',
    objectType: '',
    range: '30' as const,
    ipPrefix: '',
  };

  it('counts the default range as no filter', () => {
    expect(activeFilterCount(none)).toBe(0);
  });

  it('counts each departure from the default', () => {
    expect(activeFilterCount({ ...none, action: 'exported' })).toBe(1);
    expect(activeFilterCount({ ...none, range: 'all', ipPrefix: '102.89' })).toBe(2);
  });
});
