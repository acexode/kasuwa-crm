import { describe, expect, it } from 'vitest';
import { emptyDuplicateIndex } from './duplicates';
import { importCustomKey, suggestImportMapping } from './import-mapping';

describe('suggestImportMapping', () => {
  it('guesses standard fields by folded header name, once for a non-repeatable field', () => {
    expect(suggestImportMapping(['Full Name', 'Mobile', 'E-mail', 'Name', 'Phone', 'Notes'])).toEqual([
      { index: 0, field: 'displayName' },
      { index: 1, field: 'phones' },
      { index: 2, field: 'emails' },
      { index: 3, field: null },
      { index: 4, field: 'phones' },
      { index: 5, field: null },
    ]);
  });

  it('never guesses a custom field', () => {
    expect(importCustomKey('custom.tier__c')).toBe('tier__c');
    expect(importCustomKey('custom.Tier')).toBeNull();
    expect(suggestImportMapping(['tier__c']).map((c) => c.field)).toEqual([null]);
  });
});

describe('the exact duplicate port (D-P12, D-L160 ruling 5)', () => {
  it('matches E.164 phones and lower-cased emails, and rows the file created', () => {
    const port = emptyDuplicateIndex({ phones: true, emails: true });
    port.remember({ phones: ['+2348035550101'], emails: ['Dup@Example.test'] });
    expect(port.isDuplicate({ phones: ['+2348035550101'], emails: [] })).toBe(true);
    expect(port.isDuplicate({ phones: [], emails: ['dup@example.TEST'] })).toBe(true);
    expect(port.isDuplicate({ phones: ['+2348035550102'], emails: ['x@example.test'] })).toBe(false);
  });

  it('never matches on a field the importer cannot read', () => {
    const port = emptyDuplicateIndex({ phones: true, emails: false });
    port.remember({ phones: [], emails: ['hidden@example.test'] });
    expect(port.isDuplicate({ phones: [], emails: ['hidden@example.test'] })).toBe(false);
  });
});
