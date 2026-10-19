import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validationFailedFrom } from '../admin/common/admin-errors';
import { looksLikeIdentifier, nameQuery } from './name-query';

// Placeholders only: Nigeria has no fictional number range.
const IDENTIFIERS = [
  '08031234567',
  '+234 803 123 4567',
  '(0803) 123-4567',
  '0803/123/4567',
  '123456',
  'Sample 080312',
  'sample@example.test',
  '@sample',
  '٠٨٠٣١٢٣٤٥٦٧',
  '０８０３１２３４５６７',
  'sample＠example.test',
  '①②③④⑤⑥',
];
const NAMES = ['Sample', 'Sámple Fixture', 'Sample 2026', 'Unit 12 Block 3456', 'Sample 12345'];

describe('looksLikeIdentifier (R21, D-L135)', () => {
  it('refuses every identifier shape and admits names', () => {
    for (const q of IDENTIFIERS) expect(looksLikeIdentifier(q), q).toBe(true);
    for (const q of NAMES) expect(looksLikeIdentifier(q), q).toBe(false);
  });
});

describe('nameQuery (T-0124 I9)', () => {
  const schema = z.object({ q: nameQuery(1, 100).optional() });

  it('is identifier_in_url at q, and the error body never carries the value', () => {
    for (const q of IDENTIFIERS) {
      const parsed = schema.safeParse({ q });
      expect(parsed.success, q).toBe(false);
      if (parsed.success) continue;
      const body = validationFailedFrom(parsed.error).getResponse();
      expect(body).toMatchObject({
        code: 'validation_failed',
        details: [{ path: 'q', code: 'identifier_in_url' }],
      });
      expect(JSON.stringify(body)).not.toContain(q);
      expect(JSON.stringify(parsed.error.issues)).not.toContain(q);
    }
  });

  it('admits names and keeps its 1..100 bounds and NUL rule', () => {
    for (const q of NAMES) expect(schema.safeParse({ q }).success, q).toBe(true);
    expect(schema.safeParse({ q: 'S'.repeat(100) }).success).toBe(true);
    expect(schema.safeParse({ q: 'S'.repeat(101) }).success).toBe(false);
    expect(schema.safeParse({ q: '' }).success).toBe(false);
    expect(schema.safeParse({ q: 'a\u0000b' }).success).toBe(false);
  });
});
