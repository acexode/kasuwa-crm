import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor, InvalidCursorError } from './cursor';

describe('cursor encoding', () => {
  const position = {
    createdAt: '2026-01-01T00:05:00.000500Z',
    id: '11111111-0000-4000-8000-0000000e0001',
  };

  it('round-trips a position', () => {
    const decoded = decodeKeysetCursor(encodeKeysetCursor(position));
    expect(decoded.id).toBe(position.id);
    expect(decoded.createdAt).toBe(position.createdAt);
  });

  it('encodes nothing but the position', () => {
    const payload = JSON.parse(
      Buffer.from(encodeKeysetCursor(position), 'base64url').toString('utf8'),
    );
    // If this ever fails because a field was added, read the comment at the top
    // of cursor.ts before changing the test. Authority must not live in a
    // cursor.
    expect(Object.keys(payload).sort()).toEqual(['c', 'i']);
  });

  it('rejects garbage', () => {
    expect(() => decodeKeysetCursor('not-base64')).toThrow(InvalidCursorError);
    expect(() => decodeKeysetCursor(Buffer.from('{}').toString('base64url'))).toThrow(InvalidCursorError);
  });

  it('rejects a well-formed cursor with an invalid id', () => {
    const forged = Buffer.from(
      JSON.stringify({ c: '2026-01-01T00:00:00.000Z', i: "' OR 1=1 --" }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeKeysetCursor(forged)).toThrow(InvalidCursorError);
  });

  it('drops extra fields rather than carrying them forward', () => {
    const smuggled = Buffer.from(
      JSON.stringify({ c: '2026-01-01T00:00:00.000Z', i: position.id, tenantId: 'other' }),
      'utf8',
    ).toString('base64url');

    const decoded = decodeKeysetCursor(smuggled);
    expect(Object.keys(decoded).sort()).toEqual(['createdAt', 'id']);
  });
});

describe('microsecond cursors (T-0019)', () => {
  // Deliberately NOT whole minutes. Every seeded timestamp in the fixtures was
  // a whole minute, which is exactly why FINDING-2 survived a passing suite.
  const id = '11111111-0000-4000-8000-0000000e0002';

  it('round-trips a microsecond timestamp without truncating it', () => {
    const position = { createdAt: '2026-04-01T12:00:00.000500Z', id };
    expect(decodeKeysetCursor(encodeKeysetCursor(position))).toEqual(position);
  });

  it('distinguishes two instants that differ below the millisecond', () => {
    const earlier = encodeKeysetCursor({ createdAt: '2026-04-01T12:00:00.000100Z', id });
    const later = encodeKeysetCursor({ createdAt: '2026-04-01T12:00:00.000900Z', id });
    expect(earlier).not.toBe(later);
    expect(decodeKeysetCursor(earlier).createdAt).toBe('2026-04-01T12:00:00.000100Z');
    expect(decodeKeysetCursor(later).createdAt).toBe('2026-04-01T12:00:00.000900Z');
  });

  it('does not let a Date near the encoder, because a Date cannot hold it', () => {
    // The trap this bug came from, asserted so nobody re-introduces it.
    //
    // The lossy `encodeCursor`/`decodeCursor` pair was DELETED by the lead when
    // T-0019 landed. It was used by nothing but its own tests, and an exported
    // function documented as lossy is how a fixed bug comes back — the next
    // person reads the name, not the comment. The invariant that mattered is
    // asserted directly instead: a Date simply cannot hold this value.
    const precise = '2026-04-01T12:00:00.000500Z';
    expect(new Date(precise).toISOString()).toBe('2026-04-01T12:00:00.000Z');
    expect(new Date(precise).toISOString()).not.toBe(precise);

    expect(decodeKeysetCursor(encodeKeysetCursor({ createdAt: precise, id })).createdAt).toBe(
      precise,
    );
  });

  it('still accepts a millisecond cursor issued before the fix', () => {
    // Rejecting them would 400 every in-flight paging session on deploy, and
    // an old cursor is no worse than it was yesterday. See team/reports/T-0019.md.
    const legacy = Buffer.from(
      JSON.stringify({ c: '2026-04-01T12:00:00.000Z', i: id }),
      'utf8',
    ).toString('base64url');
    expect(decodeKeysetCursor(legacy)).toEqual({ createdAt: '2026-04-01T12:00:00.000Z', id });
  });

  it('rejects a timestamp finer than Postgres stores, or malformed', () => {
    for (const c of [
      '2026-04-01T12:00:00.0005001Z',
      '2026-04-01T12:00:00.000500',
      '2026-13-01T12:00:00.000500Z',
      '2026-04-01 12:00:00.000500Z',
      '1774000000000',
    ]) {
      const forged = Buffer.from(JSON.stringify({ c, i: id }), 'utf8').toString('base64url');
      expect(() => decodeKeysetCursor(forged), c).toThrow(InvalidCursorError);
    }
  });

  it('refuses to issue a cursor from a timestamp it cannot vouch for', () => {
    expect(() => encodeKeysetCursor({ createdAt: '2026-04-01 12:00:00+00', id })).toThrow(
      InvalidCursorError,
    );
  });

  it('encodes nothing but the position, at microsecond precision too', () => {
    const payload = JSON.parse(
      Buffer.from(
        encodeKeysetCursor({ createdAt: '2026-04-01T12:00:00.000500Z', id }),
        'base64url',
      ).toString('utf8'),
    );
    expect(Object.keys(payload).sort()).toEqual(['c', 'i']);
  });
});
