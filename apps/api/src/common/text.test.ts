import { describe, expect, it } from 'vitest';
import { codePointLength, hasNul, NUL_REASON, text } from './text';

function reasons(result: ReturnType<ReturnType<typeof text>['safeParse']>): unknown[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => (issue.code === 'custom' ? issue.params?.reason : null));
}

describe('text (D-L78: a NUL is 400, never a 500 and never stripped)', () => {
  it('refuses a NUL anywhere, with the invalid_character reason', () => {
    for (const value of ['\u0000', 'Acme\u0000 Ltd', 'end\u0000']) {
      expect(hasNul(value)).toBe(true);
      const result = text(1, 200).safeParse(value);
      expect(result.success).toBe(false);
      expect(reasons(result)).toEqual([NUL_REASON]);
    }
  });

  it('accepts the value unchanged when it carries no NUL', () => {
    expect(text(1, 200).parse('Ọjà Foods Ltd')).toBe('Ọjà Foods Ltd');
  });

  it('counts code points, as JSON Schema and Postgres char_length do', () => {
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2);
    expect(codePointLength(emoji)).toBe(1);
    expect(text(1, 200).safeParse(emoji.repeat(200)).success).toBe(true);
    expect(text(1, 200).safeParse(emoji.repeat(201)).success).toBe(false);
  });

  it('holds the bounds: empty and over-long are refused, the bounds themselves accepted', () => {
    expect(reasons(text(1, 64).safeParse(''))).toEqual(['too_small']);
    expect(reasons(text(1, 64).safeParse('x'.repeat(65)))).toEqual(['too_big']);
    expect(text(1, 64).safeParse('x').success).toBe(true);
    expect(text(1, 64).safeParse('x'.repeat(64)).success).toBe(true);
    expect(text(0, 64).safeParse('').success).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(text(0, 10).safeParse(7).success).toBe(false);
  });
});
