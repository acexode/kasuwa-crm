import { describe, expect, it } from 'vitest';
import { decodeSortedCursor, encodeSortedCursor, InvalidCursorError } from './cursor';

const id = '11111111-0000-4000-8000-0000000e0001';
const raw = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

describe('sorted cursors (T-0041)', () => {
  it('round-trips a text position and a microsecond timestamp verbatim', () => {
    const name = encodeSortedCursor({ sort: 'displayName', value: 'Adébáyọ̀ Ògúnlẹ̀', id }, 'text');
    expect(decodeSortedCursor(name, 'displayName', 'text')).toEqual({
      sort: 'displayName',
      value: 'Adébáyọ̀ Ògúnlẹ̀',
      id,
    });
    const at = '2026-03-01T00:00:00.000500Z';
    const time = encodeSortedCursor({ sort: '-updatedAt', value: at, id }, 'timestamp');
    expect(decodeSortedCursor(time, '-updatedAt', 'timestamp').value).toBe(at);
  });

  it('encodes nothing but the sort and the position', () => {
    const cursor = encodeSortedCursor({ sort: 'displayName', value: 'A', id }, 'text');
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as object;
    expect(Object.keys(payload).sort()).toEqual(['i', 's', 'v']);
  });

  it('refuses a cursor issued for another sort', () => {
    const cursor = encodeSortedCursor({ sort: 'displayName', value: 'A', id }, 'text');
    expect(() => decodeSortedCursor(cursor, '-displayName', 'text')).toThrow(InvalidCursorError);
  });

  it('refuses garbage, a bad timestamp, a bad id and smuggled fields', () => {
    expect(() => decodeSortedCursor('not-base64-json', 'displayName', 'text')).toThrow(
      InvalidCursorError,
    );
    expect(() =>
      decodeSortedCursor(raw({ s: 'updatedAt', v: 'yesterday', i: id }), 'updatedAt', 'timestamp'),
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeSortedCursor(raw({ s: 'displayName', v: 'A', i: "' OR 1=1" }), 'displayName', 'text'),
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeSortedCursor(
        raw({ s: 'displayName', v: 'A', i: id, tenantId: 'x' }),
        'displayName',
        'text',
      ),
    ).toThrow(InvalidCursorError);
  });

  it('refuses to issue a cursor from a timestamp it cannot vouch for', () => {
    expect(() =>
      encodeSortedCursor({ sort: 'updatedAt', value: '2026-04-01 12:00:00+00', id }, 'timestamp'),
    ).toThrow(InvalidCursorError);
  });
});
