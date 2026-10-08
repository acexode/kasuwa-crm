import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../cursor';
import {
  decodeAccountTimelineCursor,
  encodeAccountTimelineCursor,
} from '../account/account-timeline.repository';
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '../contact/contact-timeline.repository';
import {
  decodeRecordTimelineCursor,
  encodeRecordTimelineCursor,
} from './record-timeline.repository';

// Invented ids (CLAUDE.md 6.1).
const RECORD = '11111111-0000-4000-8000-008000000c01';
const OTHER = '11111111-0000-4000-8000-008000000c02';
const ITEM = `ti_${'b'.repeat(32)}`;
const AT = '2026-04-22T10:00:01.123Z';

const payloadOf = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;

const raw = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('record timeline cursors (T-0080)', () => {
  it('round-trips an account position: the account, the millisecond and the item id', () => {
    const cursor = encodeAccountTimelineCursor({ accountId: RECORD, occurredAt: AT, itemId: ITEM });
    expect(decodeAccountTimelineCursor(cursor, RECORD)).toEqual({
      accountId: RECORD,
      occurredAt: AT,
      itemId: ITEM,
    });
    expect(decodeAccountTimelineCursor(cursor, RECORD.toUpperCase()).itemId).toBe(ITEM);
  });

  it('keeps the contact cursor exactly as T-0061 issued it ({ k, t, i })', () => {
    const cursor = encodeTimelineCursor({ contactId: RECORD, occurredAt: AT, itemId: ITEM });
    expect(payloadOf(cursor)).toEqual({ k: RECORD, t: AT, i: ITEM });
    expect(cursor).toBe(
      encodeRecordTimelineCursor('contact', { recordId: RECORD, occurredAt: AT, itemId: ITEM }),
    );
  });

  it('carries a position only: the account id, a time and an item id, nothing else', () => {
    const cursor = encodeAccountTimelineCursor({ accountId: RECORD, occurredAt: AT, itemId: ITEM });
    expect(Object.keys(payloadOf(cursor)).sort()).toEqual(['a', 'i', 't']);
  });

  it('refuses an account cursor on a contact timeline, and a contact cursor on an account one', () => {
    const account = encodeAccountTimelineCursor({
      accountId: RECORD,
      occurredAt: AT,
      itemId: ITEM,
    });
    const contact = encodeTimelineCursor({ contactId: RECORD, occurredAt: AT, itemId: ITEM });
    // The same record id on both: only the subject differs, and that is enough.
    expect(() => decodeTimelineCursor(account, RECORD)).toThrow(InvalidCursorError);
    expect(() => decodeAccountTimelineCursor(contact, RECORD)).toThrow(InvalidCursorError);
  });

  it('refuses a cursor issued for another account', () => {
    const cursor = encodeAccountTimelineCursor({ accountId: OTHER, occurredAt: AT, itemId: ITEM });
    expect(() => decodeAccountTimelineCursor(cursor, RECORD)).toThrow(InvalidCursorError);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a list cursor', raw({ c: AT, i: RECORD })],
    ['both keys at once', raw({ a: RECORD, k: RECORD, t: AT, i: ITEM })],
    ['a scope smuggled in', raw({ a: RECORD, t: AT, i: ITEM, p: OTHER })],
    ['year 0000', raw({ a: RECORD, t: '0000-01-01T00:00:00.000Z', i: ITEM })],
    ['an item id that is not one of ours', raw({ a: RECORD, t: AT, i: RECORD })],
  ])('refuses %s on an account timeline', (_label, cursor) => {
    expect(() => decodeRecordTimelineCursor('account', cursor, RECORD)).toThrow(
      InvalidCursorError,
    );
  });

  it('refuses to encode a position that would not decode', () => {
    expect(() =>
      encodeAccountTimelineCursor({ accountId: 'not-a-uuid', occurredAt: AT, itemId: ITEM }),
    ).toThrow(InvalidCursorError);
  });
});
