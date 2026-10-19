import { describe, expect, it } from 'vitest';
import { numberingLocale } from './numbering';

describe('numberingLocale', () => {
  it('names Arabic-Indic digits for Arabic and Latin ones for everything else, whatever the host defaults to', () => {
    expect(numberingLocale('ar')).toBe('ar-u-nu-arab');
    expect(numberingLocale('ar-EG')).toBe('ar-EG-u-nu-arab');
    for (const locale of ['en', 'en-NG', 'fr', 'ha', 'yo', 'ig', 'pcm', 'sw', 'en-XA']) {
      expect(numberingLocale(locale)).toBe(`${locale}-u-nu-latn`);
    }
  });

  it('keeps a numbering system the locale already names', () => {
    expect(numberingLocale('ar-u-nu-latn')).toBe('ar-u-nu-latn');
  });

  it('writes the same digits on every host', () => {
    expect(new Intl.NumberFormat(numberingLocale('ar')).format(1234.5)).toMatch(/^[٠-٩٫٬]+$/);
    expect(new Intl.NumberFormat(numberingLocale('en')).format(1234.5)).toBe('1,234.5');
  });
});
