import { describe, expect, it } from 'vitest';
import { decodeIdCursor, encodeIdCursor, InvalidCursorError, MAX_ID_CURSOR_LENGTH } from './cursor';

const ID = '11111111-0000-4000-8000-0107d0000001';

describe('id cursors (T-0107; the pipeline list and each board column)', () => {
  it('round-trips, and carries the id, the version and nothing else', () => {
    const cursor = encodeIdCursor(ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({ v: 1, i: ID });
    expect(decodeIdCursor(cursor)).toBe(ID);
    expect(decodeIdCursor(encodeIdCursor(ID.toUpperCase()))).toBe(ID);
  });

  it('refuses everything it did not issue, with one error', () => {
    const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const bad = [
      'not a cursor!',
      Buffer.from('{"i":').toString('base64url'),
      json({ v: 1, i: 'not-a-uuid' }),
      json({ v: 2, i: ID }),
      json({ v: 1, i: ID, s: 'name' }),
      json({ i: ID }),
      json(ID),
      `${encodeIdCursor(ID)}=`,
      'A'.repeat(MAX_ID_CURSOR_LENGTH + 1),
    ];
    for (const cursor of bad) {
      expect(() => decodeIdCursor(cursor), cursor).toThrow(InvalidCursorError);
    }
    expect(() => encodeIdCursor('nope')).toThrow(InvalidCursorError);
  });
});
