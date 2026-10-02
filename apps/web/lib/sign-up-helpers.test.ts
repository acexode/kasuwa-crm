import { describe, expect, it } from 'vitest';
import { guessField, summariseCsv } from './csv-columns';
import { classifyAddress, splitAddresses } from './invite-emails';
import {
  ONBOARDING_CURRENCIES,
  currencySymbol,
  formatMinorUnits,
  minorDigits,
  type OnboardingCurrency,
} from './money-format';
import { toE164 } from './phone';
import { rovingIndex } from './roving';

function currency(code: string): OnboardingCurrency {
  const found = ONBOARDING_CURRENCIES.find((entry) => entry.code === code);
  if (found === undefined) throw new Error(`${code} is not offered`);
  return found;
}

/** Intl uses narrow no-break spaces in some locales; compare the digits and words. */
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ');
}

describe('toE164 (P01/3)', () => {
  it('drops the trunk 0 people type from a SIM pack', () => {
    expect(toE164('NG', '0803 555 4567')).toBe('+2348035554567');
    expect(toE164('NG', '803-555-4567')).toBe('+2348035554567');
  });

  it('uses the chosen country, not Nigeria, once it changes', () => {
    expect(toE164('ZA', '082 555 0142')).toBe('+27825550142');
  });

  it('refuses what cannot be a number rather than sending it', () => {
    expect(toE164('NG', '')).toBeNull();
    expect(toE164('NG', '12')).toBeNull();
  });
});

describe('formatMinorUnits (P01/5.2)', () => {
  it('takes the minor digits from Intl, not from a table', () => {
    expect(minorDigits(currency('NGN'))).toBe(2);
    expect(minorDigits(currency('XOF'))).toBe(0);
  });

  it('formats kobo exactly, with the symbol Intl gives the currency', () => {
    const naira = currency('NGN');
    const formatted = formatMinorUnits(125_000_000n, naira);
    expect(formatted).toContain('1,250,000.00');
    expect(formatted).toContain(currencySymbol(naira));
  });

  it('keeps the last minor unit of a balance too large for a float', () => {
    expect(formatMinorUnits(900_719_925_474_099_312n, currency('USD'))).toContain(
      '9,007,199,254,740,993.12',
    );
  });

  it('writes a zero-decimal currency without a fraction', () => {
    const formatted = plain(formatMinorUnits(1_250_000n, currency('XOF')));
    expect(formatted).toContain('1 250 000');
    expect(formatted).not.toMatch(/[.,]\d{2}\b/);
  });

  it('never falls back to typing the code where Intl has a symbol', () => {
    for (const entry of ONBOARDING_CURRENCIES) {
      expect(currencySymbol(entry).length).toBeGreaterThan(0);
    }
  });
});

describe('invite addresses (P01/5.5)', () => {
  it('splits a pasted list on commas and new lines, dropping repeats', () => {
    const added = splitAddresses('tunde@ojafoods.ng, chiamaka@ojafoods.ng\nTUNDE@ojafoods.ng\n\n');
    expect(added.map((entry) => entry.address)).toEqual(['tunde@ojafoods.ng', 'chiamaka@ojafoods.ng']);
  });

  it('names the missing ending, which is the mistake people make', () => {
    expect(classifyAddress('bola@ojafoods')).toBe('missing_ending');
    expect(classifyAddress('bola@ojafoods.')).toBe('missing_ending');
    expect(classifyAddress('bola.ojafoods.ng')).toBe('invalid');
    expect(classifyAddress('bola@ojafoods.ng')).toBeNull();
  });

  it('does not re-add an address already on the list', () => {
    const first = splitAddresses('a@b.ng');
    expect(splitAddresses('A@b.ng', first)).toEqual([]);
  });
});

describe('CSV column mapping (P01/5.4)', () => {
  it('reads the header and counts rows, honouring quotes', () => {
    const summary = summariseCsv('\uFEFF"Customer Name",Phone,"Amt, NGN"\r\nAda,0803,10\n\nBola,0805,12\n');
    expect(summary.columns).toEqual(['Customer Name', 'Phone', 'Amt, NGN']);
    expect(summary.rows).toBe(2);
  });

  it('guesses the obvious fields and leaves the rest to the person', () => {
    expect(guessField('Customer Name')).toBe('fullName');
    expect(guessField('Phone')).toBe('mobile');
    expect(guessField('Company Name')).toBe('company');
    expect(guessField('E-mail')).toBe('email');
    expect(guessField('Amt')).toBeNull();
  });
});

describe('rovingIndex (P01/5.4 sources, P01/5.5 tabs)', () => {
  it('wraps forwards and backwards', () => {
    expect(rovingIndex('ArrowRight', 3, 4)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(rovingIndex('ArrowDown', 1, 4)).toBe(2);
  });

  it('swaps left and right under RTL', () => {
    expect(rovingIndex('ArrowLeft', 0, 4, 'rtl')).toBe(1);
    expect(rovingIndex('ArrowRight', 0, 4, 'rtl')).toBe(3);
  });

  it('jumps with Home and End, and leaves Tab alone', () => {
    expect(rovingIndex('End', 0, 4)).toBe(3);
    expect(rovingIndex('Home', 2, 4)).toBe(0);
    expect(rovingIndex('Tab', 2, 4)).toBeNull();
  });
});
