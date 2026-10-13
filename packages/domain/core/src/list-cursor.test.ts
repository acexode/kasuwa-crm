import { describe, expect, it } from 'vitest';
import {
  decodeListCursor,
  encodeKeysetCursor,
  encodeListCursor,
  InvalidCursorError,
  LIST_CURSOR_VERSION,
  MAX_CURSOR_LENGTH,
} from './cursor';

const id = '11111111-0000-4000-8000-0000000e0001';
const raw = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const decoded = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

describe('list cursors (T-0084, D-L80)', () => {
  it('round-trips the id under the sort it was issued for', () => {
    for (const sort of ['displayName', '-updatedAt', 'name', '-createdAt']) {
      expect(decodeListCursor(encodeListCursor({ sort, id }), sort)).toBe(id);
    }
  });

  it('carries the id, the sort and the version, and nothing else', () => {
    const cursor = encodeListCursor({ sort: 'displayName', id });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decoded(cursor)).toEqual({ v: LIST_CURSOR_VERSION, s: 'displayName', i: id });
    expect(cursor.length).toBeLessThan(MAX_CURSOR_LENGTH);
  });

  it('refuses a cursor issued for another sort', () => {
    const cursor = encodeListCursor({ sort: 'displayName', id });
    expect(() => decodeListCursor(cursor, '-displayName')).toThrow(InvalidCursorError);
  });

  it('refuses garbage, an unknown version, extra keys and a non-uuid id', () => {
    for (const bad of [
      'not-base64-json',
      raw({ v: 2, s: 'name', i: id }),
      raw({ v: '1', s: 'name', i: id }),
      raw({ v: 1, s: 'name', i: id, tenantId: id }),
      raw({ v: 1, s: 'name', i: "' OR 1=1" }),
      raw({ v: 1, s: 'name' }),
      raw(id),
    ]) {
      expect(() => decodeListCursor(bad, 'name'), bad).toThrow(InvalidCursorError);
    }
  });

  it('refuses a T-0041 valued cursor: a name never reaches SQL again', () => {
    const valued = raw({ s: 'displayName', v: 'Adébáyọ̀ Ògúnlẹ̀', i: id });
    expect(() => decodeListCursor(valued, 'displayName')).toThrow(InvalidCursorError);
  });

  it('accepts the legacy { c, i } shape only under the legacy sort, and by its id alone', () => {
    const legacy = encodeKeysetCursor({ createdAt: '2026-04-01T12:00:00.000123Z', id });
    expect(decodeListCursor(legacy, '-createdAt', { legacyKeysetSort: '-createdAt' })).toBe(id);
    expect(() => decodeListCursor(legacy, 'createdAt', { legacyKeysetSort: '-createdAt' })).toThrow(
      InvalidCursorError,
    );
    expect(() => decodeListCursor(legacy, '-createdAt')).toThrow(InvalidCursorError);
    // The timestamp is still validated, so a garbage legacy cursor stays 400.
    expect(() =>
      decodeListCursor(raw({ c: 'not-a-date', i: id }), '-createdAt', {
        legacyKeysetSort: '-createdAt',
      }),
    ).toThrow(InvalidCursorError);
  });

  it('never lets a payload with v or s through the legacy path (another sort, or an unknown version)', () => {
    const legacyOnly = { legacyKeysetSort: '-createdAt' };
    for (const payload of [
      // A cursor of another sort, carrying a valid c and i besides.
      { c: '2026-04-01T12:00:00.000Z', i: id, s: 'displayName', v: 1 },
      { c: '2026-04-01T12:00:00.000Z', i: id, s: 'createdAt' },
      // An unknown version.
      { c: '2026-04-01T12:00:00.000Z', i: id, v: 2 },
      { c: '2026-04-01T12:00:00.000Z', i: id, v: 1 },
    ]) {
      expect(() => decodeListCursor(raw(payload), '-createdAt', legacyOnly), JSON.stringify(payload))
        .toThrow(InvalidCursorError);
    }
    // Other extra keys are still dropped, as before T-0084 (cursor-tampering).
    const smuggled = raw({ c: '2026-04-01T12:00:00.000Z', i: id, tenantId: id });
    expect(decodeListCursor(smuggled, '-createdAt', legacyOnly)).toBe(id);
  });

  it('refuses anything but unpadded base64url before decoding', () => {
    const good = encodeListCursor({ sort: 'name', id });
    // Node's base64url decoder would accept every one of these as `good`.
    const plusSlash = good.replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(plusSlash, 'base64url').toString('utf8')).toBe(
      Buffer.from(good, 'base64url').toString('utf8'),
    );
    const variants = [`${good}=`, `${good}==`, ` ${good}`, `${good}\n`, `${good}.`];
    if (plusSlash !== good) variants.push(plusSlash);
    for (const bad of variants) {
      expect(() => decodeListCursor(bad, 'name'), JSON.stringify(bad)).toThrow(InvalidCursorError);
    }
    expect(decodeListCursor(good, 'name')).toBe(id);
  });

  it('refuses to issue a cursor for a non-uuid id or an empty sort', () => {
    expect(() => encodeListCursor({ sort: 'name', id: 'not-a-uuid' })).toThrow(InvalidCursorError);
    expect(() => encodeListCursor({ sort: '', id })).toThrow(InvalidCursorError);
  });
});
