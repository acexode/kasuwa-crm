import { describe, expect, it } from 'vitest';
import { UnreadableAmountError, formatDealMoney, minorDigits, minorToMajorText, parseMajorAmount } from './deal-money';

/** The digits a formatted amount draws, whatever the grouping and the mark. */
function digits(text: string): string {
  return text.replace(/\D/g, '');
}

/** The currency mark Intl gives `currency` in `locale`, read from Intl here too, never typed. */
function mark(locale: string, currency: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(1).find((part) => part.type === 'currency')?.value ?? '';
}

describe('formatDealMoney', () => {
  it('draws every digit of an 18-digit amount, past 2^53, where a number would round', () => {
    const text = formatDealMoney('en', '999999999999999999', 'NGN');
    expect(digits(text)).toBe('999999999999999999');
    // What going through a JS number would have drawn instead.
    expect(digits(new Intl.NumberFormat('en', { style: 'currency', currency: 'NGN' }).format(Number('999999999999999999') / 100))).not.toBe(
      '999999999999999999',
    );
  });

  it('draws a 24-digit column total exactly', () => {
    expect(digits(formatDealMoney('en', '123456789012345678901234', 'GHS'))).toBe('123456789012345678901234');
  });

  it('keeps the minor digits, padding a small amount: five kobo is 0.05, not 5', () => {
    expect(digits(formatDealMoney('en', '5', 'NGN'))).toBe('005');
    expect(digits(formatDealMoney('en', '0', 'KES'))).toBe('000');
    expect(formatDealMoney('en', '125050', 'GHS')).toContain('1,250.50');
  });

  it('takes the currency mark and its position from Intl for the language, never compact', () => {
    for (const currency of ['NGN', 'GHS', 'KES', 'ZAR']) {
      const text = formatDealMoney('en', '366000000030', currency);
      expect(text).toContain(mark('en', currency));
      expect(digits(text)).toBe('366000000030');
    }
    // French groups with a narrow no-break space and writes a decimal comma.
    expect(formatDealMoney('fr', '125050', 'ZAR')).toMatch(/1\s?250,50/);
  });

  it('draws exactly what Intl currency formatting draws, wherever a number is still exact', () => {
    // The whole string — mark, its position, spacing, grouping, decimal — is
    // Intl's. Compared against plain Intl.NumberFormat in style currency for
    // amounts small enough that the number path is exact, so nothing here
    // (and nothing in deal-money.ts) has to type a currency mark.
    const cases: readonly [string, string, string, number][] = [
      ['en', '125050', 'GHS', 1250.5],
      ['en', '5', 'NGN', 0.05],
      ['en-NG', '366000000030', 'NGN', 3660000000.3],
      ['en-KE', '99', 'KES', 0.99],
      ['en-ZA', '123456', 'ZAR', 1234.56],
      ['fr', '125050', 'ZAR', 1250.5],
      ['en', '1250', 'JPY', 1250],
    ];
    for (const [locale, minor, currency, major] of cases) {
      const intl = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major);
      expect(formatDealMoney(locale, minor, currency), `${locale} ${currency} ${minor}`).toBe(intl);
    }
  });

  it('survives a language Intl does not know', () => {
    expect(digits(formatDealMoney('en-XA', '125050', 'NGN'))).toBe('125050');
  });

  it('writes the fraction in the same digits as the whole part: Arabic-Indic in ar, Latin in en', () => {
    const arabicIndic = /[\u0660-\u0669]/;
    const latin = /[0-9]/;
    for (const amount of ['123456789012345678', '5']) {
      const ar = formatDealMoney('ar', amount, 'NGN');
      expect(ar, `${amount} in ar`).toMatch(arabicIndic);
      expect(ar, `${amount} in ar mixes Latin digits`).not.toMatch(latin);
      // Exact: the native digits, read back as Latin ones, are the amount.
      const asLatin = Array.from(ar.replace(/[^\u0660-\u0669]/g, ''), (digit) => String(digit.charCodeAt(0) - 0x0660)).join('');
      expect(asLatin).toBe(amount.padStart(3, '0'));
      const en = formatDealMoney('en', amount, 'NGN');
      expect(en).not.toMatch(arabicIndic);
      expect(digits(en)).toBe(amount.padStart(3, '0'));
    }
    expect(formatDealMoney('ar', '125050', 'GHS')).toContain('١٬٢٥٠٫٥٠');
  });

  it('refuses an amount that is not a digit run rather than drawing a zero (R5)', () => {
    for (const bad of ['', '12.5', '-5', 'abc', ' 5']) {
      expect(() => formatDealMoney('en', bad, 'NGN'), JSON.stringify(bad)).toThrow(UnreadableAmountError);
    }
  });

  it('reads the minor digits from Intl', () => {
    expect(minorDigits('NGN')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
  });
});

describe('parseMajorAmount', () => {
  it('turns major units into a minor-unit string by string arithmetic', () => {
    expect(parseMajorAmount('1250.5', 2)).toBe('125050');
    expect(parseMajorAmount('1250.50', 2)).toBe('125050');
    expect(parseMajorAmount('0.05', 2)).toBe('5');
    expect(parseMajorAmount('0', 2)).toBe('0');
    expect(parseMajorAmount(' 42 ', 2)).toBe('4200');
    expect(parseMajorAmount('9999999999999999.99', 2)).toBe('999999999999999999');
  });

  it('refuses a sign, letters, a grouping comma, too many decimals and more than 18 minor digits', () => {
    for (const bad of ['-5', 'abc', '1,250.50', '1.234', '12.', '.5', '', '1e3', '10000000000000000']) {
      expect(parseMajorAmount(bad, 2), bad).toBeNull();
    }
  });
});

describe('minorToMajorText', () => {
  it('seeds an amount input in major units, exactly, past 2^53', () => {
    expect(minorToMajorText('1500000015', 2)).toBe('15000000.15');
    expect(minorToMajorText('999999999999999999', 2)).toBe('9999999999999999.99');
    expect(minorToMajorText('5', 2)).toBe('0.05');
    expect(minorToMajorText('0', 2)).toBe('0');
  });

  it('drops a zero fraction, and reads back to the same minor units', () => {
    expect(minorToMajorText('1650000000', 2)).toBe('16500000');
    for (const minor of ['1500000015', '1650000000', '5', '999999999999999999', '100']) {
      expect(parseMajorAmount(minorToMajorText(minor, 2), 2)).toBe(minor);
    }
  });

  it('draws nothing for an amount that is not a digit run', () => {
    expect(minorToMajorText('15.5', 2)).toBe('');
    expect(minorToMajorText('-100', 2)).toBe('');
  });
});
