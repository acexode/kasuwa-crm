import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../cursor';
import { decodeTimelineCursor, encodeTimelineCursor } from './contact-timeline.repository';

// Invented ids (CLAUDE.md 6.1).
const CONTACT = '11111111-0000-4000-8000-006100000c01';
const OTHER = '11111111-0000-4000-8000-006100000c02';
const ITEM = `ti_${'a'.repeat(32)}`;
const AT = '2026-04-22T10:00:01.123Z';

describe('timeline cursors (T-0061)', () => {
  it('round-trips a position: the millisecond and the item id, verbatim', () => {
    const cursor = encodeTimelineCursor({ contactId: CONTACT, occurredAt: AT, itemId: ITEM });
    expect(decodeTimelineCursor(cursor, CONTACT)).toEqual({
      contactId: CONTACT,
      occurredAt: AT,
      itemId: ITEM,
    });
  });

  it('accepts the contact id in either case', () => {
    const cursor = encodeTimelineCursor({ contactId: CONTACT, occurredAt: AT, itemId: ITEM });
    expect(decodeTimelineCursor(cursor, CONTACT.toUpperCase()).itemId).toBe(ITEM);
  });

  it('refuses a cursor issued for another contact', () => {
    const cursor = encodeTimelineCursor({ contactId: OTHER, occurredAt: AT, itemId: ITEM });
    expect(() => decodeTimelineCursor(cursor, CONTACT)).toThrow(InvalidCursorError);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['empty JSON', Buffer.from('{}').toString('base64url')],
    [
      'a microsecond timestamp',
      Buffer.from(
        JSON.stringify({ k: CONTACT, t: '2026-04-22T10:00:01.123456Z', i: ITEM }),
      ).toString('base64url'),
    ],
    [
      'an item id that is not one of ours',
      Buffer.from(JSON.stringify({ k: CONTACT, t: AT, i: 'ti_zz' })).toString('base64url'),
    ],
    [
      'an extra property (a scope smuggled in)',
      Buffer.from(JSON.stringify({ k: CONTACT, t: AT, i: ITEM, p: OTHER })).toString('base64url'),
    ],
    [
      'an impossible date',
      Buffer.from(JSON.stringify({ k: CONTACT, t: '2026-13-40T10:00:01.123Z', i: ITEM })).toString(
        'base64url',
      ),
    ],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodeTimelineCursor(cursor, CONTACT)).toThrow(InvalidCursorError);
  });

  it('carries no tenant or programme: a position only', () => {
    const cursor = encodeTimelineCursor({ contactId: CONTACT, occurredAt: AT, itemId: ITEM });
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as object;
    expect(Object.keys(payload).sort()).toEqual(['i', 'k', 't']);
  });
});
