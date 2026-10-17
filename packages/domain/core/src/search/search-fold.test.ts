import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBINING_MARK_RANGES, SEARCH_WHITESPACE } from './search-charsets';
import { foldSearchText, prefixUpperBound } from './search-fold';

// Every value is synthetic.
describe('foldSearchText (T-0086 R2)', () => {
  it('folds case, accents and whitespace as the contract states', () => {
    expect(foldSearchText('  Sámple   Fixture ')).toBe('sample fixture');
    expect(foldSearchText('Sample\t\nFixture')).toBe('sample fixture');
    expect(foldSearchText('Sample Fixture　')).toBe('sample fixture');
  });

  it('removes every combining mark, Arabic harakat and Yoruba tone marks included', () => {
    expect(foldSearchText('سَامْبِل')).toBe('سامبل');
    expect(foldSearchText('Ẹ̀xámple')).toBe('example');
  });

  it('lower-cases letters with no decomposition without folding them', () => {
    expect(foldSearchText('ØLSEN')).toBe('ølsen');
    expect(foldSearchText('ТЕСТ')).toBe('тест');
    expect(foldSearchText('ø')).not.toBe('o');
  });

  it('keeps wildcards literal', () => {
    expect(foldSearchText('Zq%_\\ Sample')).toBe('zq%_\\ sample');
  });
});

describe('prefixUpperBound', () => {
  it('increments the last code point', () => {
    expect(prefixUpperBound('zq')).toBe('zr');
    expect(prefixUpperBound('zqø')).toBe('zqù');
    expect(prefixUpperBound('zq\u{1F372}')).toBe('zq\u{1F373}');
  });

  it('skips the surrogate range and carries past U+10FFFF', () => {
    expect(prefixUpperBound('a퟿')).toBe('a');
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b');
    expect(prefixUpperBound('\u{10FFFF}')).toBeNull();
    expect(prefixUpperBound('')).toBeNull();
  });

  it('bounds exactly the strings that start with the prefix, in code-point order', () => {
    const cmp = (a: string, b: string) => {
      const x = [...a].map((c) => c.codePointAt(0) ?? 0);
      const y = [...b].map((c) => c.codePointAt(0) ?? 0);
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return x.length - y.length;
    };
    const prefix = 'zqbnd';
    const upper = prefixUpperBound(prefix) ?? '';
    for (const value of [
      'zqbnd',
      'zqbnd~',
      'zqbndø',
      'zqbnd\u{10FFFD}',
      'zqbne',
      'zqbnc\u{10FFFD}',
    ]) {
      const inRange = cmp(value, prefix) >= 0 && cmp(value, upper) < 0;
      expect(inRange, value).toBe(value.startsWith(prefix));
    }
  });
});

// The frozen sets equal migration 0038's, range for range (review fix 5).
describe('the fold twin agrees with 0038 on its character sets', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../../db/migrations/0038_search_prefix_columns.sql'),
    'utf8',
  );
  const code = sql.replace(/--[^\n]*/g, '');
  const parseEscapes = (text: string): number[] =>
    [...text.matchAll(/\\U([0-9a-f]{8})|\\u([0-9a-f]{4})/g)].map((match) =>
      parseInt(match[1] ?? match[2] ?? '', 16),
    );
  /** A bracket's escapes as inclusive ranges (`a-b` pairs and singles). */
  const parseRanges = (bracket: string): [number, number][] =>
    [
      ...bracket.matchAll(/(\\U[0-9a-f]{8}|\\u[0-9a-f]{4})(?:-(\\U[0-9a-f]{8}|\\u[0-9a-f]{4}))?/g),
    ].map((match) => {
      const [first] = parseEscapes(match[1] ?? '');
      const [last] = parseEscapes(match[2] ?? match[1] ?? '');
      return [first ?? -1, last ?? -1];
    });

  it('every generation expression carries exactly COMBINING_MARK_RANGES', () => {
    const brackets = [
      ...code.matchAll(/normalize\(\w+, NFD\),\s*((?:'[^']*'\s*)+),\s*'', 'g'\)/g),
    ].map((match) => (match[1] ?? '').replace(/'\s*'/g, '').replace(/'/g, ''));
    expect(brackets).toHaveLength(6);
    for (const bracket of brackets) {
      expect(parseRanges(bracket)).toEqual(COMBINING_MARK_RANGES.map(([a, b]) => [a, b]));
    }
  });

  it('every non-ASCII path translates exactly SEARCH_WHITESPACE (minus the space) to spaces', () => {
    const sets = [...code.matchAll(/E'((?:\\u[0-9a-f]{4})+)',\s*'( +)'/g)];
    expect(sets).toHaveLength(6);
    for (const [, escapes = '', spaces = ''] of sets) {
      const points = parseEscapes(escapes);
      expect([...points, 0x20].sort((a, b) => a - b)).toEqual(
        [...SEARCH_WHITESPACE].sort((a, b) => a - b),
      );
      expect(spaces).toHaveLength(points.length);
    }
  });

  it('every ASCII path collapses exactly the ASCII members of SEARCH_WHITESPACE', () => {
    const brackets = [...code.matchAll(/'\[(\\u0009-\\u000d) \]\+'/g)];
    expect(brackets).toHaveLength(6);
    expect(SEARCH_WHITESPACE.filter((point) => point < 0x80)).toEqual([
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20,
    ]);
  });

  it('the fold uses the frozen sets, not the runtime ones: a later-assigned mark would be kept', () => {
    // U+0300 is in the list; a code point outside every range is never stripped.
    expect(foldSearchText('àb')).toBe('ab');
    const outside = 0x10fffd;
    expect(COMBINING_MARK_RANGES.some(([a, b]) => outside >= a && outside <= b)).toBe(false);
    expect(foldSearchText(`a${String.fromCodePoint(outside)}`)).toBe(
      `a${String.fromCodePoint(outside)}`,
    );
  });
});
