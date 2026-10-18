import { describe, expect, it } from 'vitest';
import {
  changedCustomKeys,
  changedMergeFields,
  complianceOf,
  defaultSide,
  isEmptyValue,
  strictestCompliance,
} from './contact-merge';
import {
  CONTACT_MAX_EMAILS,
  CONTACT_MAX_PHONES,
  MAX_DUPLICATE_ORDINAL,
  decodeDuplicateCursor,
  encodeDuplicateCursor,
} from './duplicates.repository';
import { InvalidCursorError } from '../cursor';

// Synthetic ids only.
const ID = '11111111-0000-4000-8000-0000000000c1';

describe('strictestCompliance (D-P28)', () => {
  it('takes dnd if either has it, opt-in only if both have it, the lowest consent', () => {
    expect(
      strictestCompliance(
        { dnd: false, whatsappOptIn: true, consentState: 'opted_in' },
        { dnd: true, whatsappOptIn: false, consentState: 'pending' },
      ),
    ).toEqual({ dnd: true, whatsappOptIn: false, consentState: 'pending' });
    expect(
      strictestCompliance(
        { dnd: false, whatsappOptIn: true, consentState: 'unknown' },
        { dnd: false, whatsappOptIn: true, consentState: 'opted_in' },
      ),
    ).toEqual({ dnd: false, whatsappOptIn: true, consentState: 'unknown' });
  });

  it('is symmetric: the survivor never matters', () => {
    const a = { dnd: false, whatsappOptIn: false, consentState: 'withdrawn' };
    const b = { dnd: true, whatsappOptIn: true, consentState: 'opted_in' };
    expect(strictestCompliance(a, b)).toEqual(strictestCompliance(b, a));
  });

  it('fails closed on an unknown consent code or a missing value', () => {
    expect(
      strictestCompliance(
        { dnd: false, whatsappOptIn: true, consentState: 'bogus' },
        { dnd: false, whatsappOptIn: true, consentState: 'opted_in' },
      ).consentState,
    ).toBe('withdrawn');
    expect(complianceOf({})).toEqual({
      dnd: false,
      whatsappOptIn: false,
      consentState: 'withdrawn',
    });
  });
});

describe('defaultSide (M16, M4)', () => {
  it('prefers the newer side when it is non-empty, else the other, else the survivor', () => {
    expect(defaultSide('a', 'b', true)).toBe('merged');
    expect(defaultSide('a', 'b', false)).toBe('survivor');
    expect(defaultSide('a', null, true)).toBe('survivor');
    expect(defaultSide(null, 'b', false)).toBe('merged');
    expect(defaultSide([], [], true)).toBe('survivor');
    expect(defaultSide(['x'], [], true)).toBe('survivor');
  });

  it('never picks an unacceptable side; with none acceptable, an empty side, else none', () => {
    const onlySurvivor = (side: 'survivor' | 'merged') => side === 'survivor';
    expect(defaultSide('s', 'm', true, onlySurvivor)).toBe('survivor');
    const neither = () => false;
    expect(defaultSide('s', null, false, neither)).toBe('merged');
    expect(defaultSide('s', 'm', true, neither)).toBeNull();
  });
});

describe('isEmptyValue', () => {
  it('treats null, blank strings, empty arrays and objects as empty, false as a value', () => {
    for (const value of [null, undefined, '', '  ', [], {}]) expect(isEmptyValue(value)).toBe(true);
    for (const value of ['x', ['x'], { a: 1 }, false, 0]) expect(isEmptyValue(value)).toBe(false);
  });
});

describe('changed fields and keys', () => {
  it('names only fields present in the new values whose stored value differs', () => {
    expect(
      changedMergeFields(
        { status: 'new', tags: ['a'], dnd: false },
        { status: 'new', tags: ['b'], dnd: true },
        ['status', 'tags', 'dnd', 'lga'],
      ),
    ).toEqual(['tags', 'dnd']);
    expect(changedCustomKeys({ a__c: 1, b__c: 2 }, { a__c: 1, c__c: 3 })).toEqual(['b__c', 'c__c']);
  });
});

describe('duplicate cursors (M5)', () => {
  it('round-trips the lowest id, the match kind and the ordinal, and carries nothing else', () => {
    const cursor = encodeDuplicateCursor({
      lowestId: ID.toUpperCase(),
      matchOn: 'email',
      ordinal: 2,
    });
    expect(decodeDuplicateCursor(cursor)).toEqual({ lowestId: ID, matchOn: 'email', ordinal: 2 });
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded).sort()).toEqual(['id', 'm', 'n', 'v']);
  });

  it('refuses anything this server did not issue', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of [
      '!!!',
      b64({ v: 1, id: ID, m: 'phone' }),
      b64({ v: 1, id: ID, m: 'name', n: 0 }),
      b64({ v: 1, id: ID, m: 'phone', n: 100 }),
      b64({ v: 1, id: ID, m: 'phone', n: 0, value: '+2348000000000' }),
      b64({ v: 2, id: ID, m: 'phone', n: 0 }),
    ]) {
      expect(() => decodeDuplicateCursor(bad), bad).toThrow(InvalidCursorError);
    }
  });

  it('ties the ordinal cap to the phone and email caps: one below the larger (D-L163)', () => {
    expect(MAX_DUPLICATE_ORDINAL).toBe(Math.max(CONTACT_MAX_PHONES, CONTACT_MAX_EMAILS) - 1);
    const last = encodeDuplicateCursor({
      lowestId: ID,
      matchOn: 'phone',
      ordinal: MAX_DUPLICATE_ORDINAL,
    });
    expect(decodeDuplicateCursor(last).ordinal).toBe(MAX_DUPLICATE_ORDINAL);
    expect(() =>
      encodeDuplicateCursor({ lowestId: ID, matchOn: 'phone', ordinal: MAX_DUPLICATE_ORDINAL + 1 }),
    ).toThrow(InvalidCursorError);
  });
});
