import { describe, expect, it } from 'vitest';
import { cleanName, identifierShaped, listQ, nameFromUrl, numberTyped, phoneLike, planSearch } from './search-query';

/** PLACEHOLDER numbers only (the contract's own +234803000000x). */
describe('planSearch: what a search box holds, and where it may go (T-0087)', () => {
  it('sends a name to searchRecords, cleaned: no control character, collapsed, at most 100 characters', () => {
    expect(planSearch('sam')).toEqual({ kind: 'search', key: 'q:sam', q: 'sam' });
    expect(planSearch('  Sample\tFixture  ')).toMatchObject({ kind: 'search', q: 'Sample Fixture' });
    const long = planSearch(`Sample${'x'.repeat(120)}`);
    expect(long.kind === 'search' ? long.q.length : 0).toBe(100);
    expect(planSearch('Sample 12')).toMatchObject({ kind: 'search', q: 'Sample 12' });
    expect(planSearch('Unit 12 Block 3456')).toMatchObject({ kind: 'search' });
  });

  it('sends nothing under two characters once folded, and draws nothing for it', () => {
    for (const short of ['', '   ', 's', ' s ', 'É', 'ś', 'Ø ']) {
      expect(['idle', 'short']).toContain(planSearch(short).kind);
    }
  });

  it('counts code points, as the server does: one astral letter is too short, two are a name', () => {
    expect(planSearch('\u{1E900}')).toEqual({ kind: 'short' });
    expect(planSearch('\u{1E900}\u{1E901}')).toMatchObject({ kind: 'search' });
  });

  it('never lets a number reach searchRecords, not even its first digits (R27)', () => {
    for (const prefix of ['0803', '+234 80', '(0803) 0', '０８０３', '0803/1', '٠٨', '0803–']) {
      expect(planSearch(prefix)).toEqual({ kind: 'keepTyping' });
    }
  });

  it('sends a whole-looking number only to the lookup, NFKC-normalised and trimmed (R11, R28)', () => {
    expect(planSearch(' 0803 000 0001 ')).toEqual({ kind: 'lookup', key: 'phone:0803 000 0001', field: 'phone', value: '0803 000 0001' });
    expect(planSearch('０８０３ ０００ ０００７')).toMatchObject({ kind: 'lookup', field: 'phone', value: '0803 000 0007' });
    // D-L135: any separator and digits of any script; NFKC leaves these alone.
    expect(planSearch('0803/000/0001')).toMatchObject({ kind: 'lookup', value: '0803/000/0001' });
    expect(planSearch('٠٨٠٣٠٠٠٠٠٠٧')).toMatchObject({ kind: 'lookup', value: '٠٨٠٣٠٠٠٠٠٠٧' });
    // A partial number past six digits is the API's to refuse.
    expect(planSearch('0803 000')).toMatchObject({ kind: 'lookup', field: 'phone' });
  });

  it('sends an address only to the lookup, whole, a full-width ＠ made ASCII', () => {
    expect(planSearch('  Sample.Fixture@Example.test ')).toMatchObject({ kind: 'lookup', field: 'email', value: 'Sample.Fixture@Example.test' });
    expect(planSearch('Samplewise.Testcase＠Example.test')).toMatchObject({ field: 'email', value: 'Samplewise.Testcase@Example.test' });
    expect(planSearch('sample.fixture@')).toMatchObject({ kind: 'lookup', field: 'email' });
  });

  it('refuses a six-digit run inside a name: it is neither a name to search nor a phone', () => {
    expect(planSearch('Sample 0803/000/0001')).toEqual({ kind: 'refused', field: 'phone' });
  });
});

describe('the rules underneath', () => {
  it('identifierShaped follows D-L135', () => {
    expect(identifierShaped('0803,123,4567')).toBe(true);
    expect(identifierShaped('0803_123_4567')).toBe(true);
    expect(identifierShaped('Sample12Block3456')).toBe(false);
    expect(identifierShaped('a@b')).toBe(true);
  });

  it('phoneLike is a digit and no letter', () => {
    expect(phoneLike('+-.() ')).toBe(false);
    expect(phoneLike('1')).toBe(true);
    expect(phoneLike('Sample 1')).toBe(false);
  });

  it('cleanName never cuts through a code point', () => {
    expect([...cleanName('😀'.repeat(150))].length).toBe(100);
  });
});

describe('nameFromUrl: a q in a URL is only ever a name (R12)', () => {
  it('keeps a name and drops an identifier, a number prefix, a short value and anything not a string', () => {
    expect(nameFromUrl('sam')).toBe('sam');
    expect(nameFromUrl('08030000001')).toBe('');
    expect(nameFromUrl('sample.fixture@example.test')).toBe('');
    expect(nameFromUrl('0803')).toBe('');
    expect(nameFromUrl('s')).toBe('');
    expect(nameFromUrl(['sam', 'x'])).toBe('');
    expect(nameFromUrl(undefined)).toBe('');
  });
});

describe('a list’s own search box (T-0124 I9, R21)', () => {
  it('holds back a number or an address, whole or half typed, and sends a name', () => {
    for (const text of ['0803 000 0001', '0803', 'sample@example.test', 'Sample 0803/000/0001']) {
      expect(numberTyped(text), text).toBe(true);
      expect(listQ(text), text).toBe('');
    }
    for (const text of ['Sample', 'Unit 12 Block 3456', 'A', '']) {
      expect(numberTyped(text), text).toBe(false);
      expect(listQ(text), text).toBe(text);
    }
  });
});
