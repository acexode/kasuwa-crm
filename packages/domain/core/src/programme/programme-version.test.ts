import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor } from '../cursor';
import { UnparseableVersionTimestampError, versionFromUpdatedAt } from './programme-version';

describe('programme version (derived from updated_at, T-0024)', () => {
  it('is the epoch milliseconds of the rendered timestamp', () => {
    expect(versionFromUpdatedAt('2026-10-02T10:00:00.123456Z')).toBe(
      Date.UTC(2026, 9, 2, 10, 0, 0, 123),
    );
  });

  it('truncates sub-millisecond digits rather than rounding them up', () => {
    // .999999 must not become the next second: that version does not exist yet.
    expect(versionFromUpdatedAt('2026-10-02T10:00:00.999999Z')).toBe(
      Date.UTC(2026, 9, 2, 10, 0, 0, 999),
    );
  });

  it('accepts fewer fractional digits and none at all', () => {
    expect(versionFromUpdatedAt('2026-10-02T10:00:00.5Z')).toBe(
      Date.UTC(2026, 9, 2, 10, 0, 0, 500),
    );
    expect(versionFromUpdatedAt('2026-10-02T10:00:00Z')).toBe(Date.UTC(2026, 9, 2, 10, 0, 0, 0));
  });

  it('is an integer, and moves forward with the timestamp', () => {
    const before = versionFromUpdatedAt('2026-10-02T10:00:00.123000Z');
    const after = versionFromUpdatedAt('2026-10-02T10:00:00.124000Z');
    expect(Number.isSafeInteger(before)).toBe(true);
    expect(after).toBeGreaterThan(before);
  });

  it('refuses anything that is not a UTC rendering, rather than guessing', () => {
    for (const bad of [
      '',
      '2026-10-02 10:00:00',
      '2026-10-02T10:00:00+01:00',
      '2026-10-02T10:00:00.1234567Z',
      'not a date',
    ]) {
      expect(() => versionFromUpdatedAt(bad), bad).toThrow(UnparseableVersionTimestampError);
    }
  });
});

describe('programme list cursors carry a position only', () => {
  it('round-trips a programme position with nothing else in it', () => {
    const position = {
      createdAt: '2026-10-02T10:00:00.123456Z',
      id: '11111111-0000-4000-8000-0000000c0001',
    };
    const cursor = encodeKeysetCursor(position);
    expect(decodeKeysetCursor(cursor)).toEqual(position);
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as object;
    expect(Object.keys(payload).sort()).toEqual(['c', 'i']);
  });
});
