import { describe, expect, it } from 'vitest';
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
