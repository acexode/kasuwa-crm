import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor';

describe('cursor encoding', () => {
  const position = {
    createdAt: new Date('2026-01-01T00:05:00.000Z'),
    id: '11111111-0000-4000-8000-0000000e0001',
  };

  it('round-trips a position', () => {
    const decoded = decodeCursor(encodeCursor(position));
    expect(decoded.id).toBe(position.id);
    expect(decoded.createdAt.toISOString()).toBe(position.createdAt.toISOString());
  });

  it('encodes nothing but the position', () => {
    const payload = JSON.parse(Buffer.from(encodeCursor(position), 'base64url').toString('utf8'));
    // If this ever fails because a field was added, read the comment at the top
    // of cursor.ts before changing the test. Authority must not live in a
    // cursor.
    expect(Object.keys(payload).sort()).toEqual(['c', 'i']);
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-base64')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(InvalidCursorError);
  });

  it('rejects a well-formed cursor with an invalid id', () => {
    const forged = Buffer.from(
      JSON.stringify({ c: '2026-01-01T00:00:00.000Z', i: "' OR 1=1 --" }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(forged)).toThrow(InvalidCursorError);
  });

  it('drops extra fields rather than carrying them forward', () => {
    const smuggled = Buffer.from(
      JSON.stringify({ c: '2026-01-01T00:00:00.000Z', i: position.id, tenantId: 'other' }),
      'utf8',
    ).toString('base64url');

    const decoded = decodeCursor(smuggled);
    expect(Object.keys(decoded).sort()).toEqual(['createdAt', 'id']);
  });
});
