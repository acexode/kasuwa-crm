import { describe, expect, it } from 'vitest';
import { foldForSearch, phoneSearchE164, tenantDefaultCountry } from './phone';

// Invented numbers in the seed's shape; none is a real subscriber.
describe('tenantDefaultCountry', () => {
  it('takes the region of the default locale', () => {
    expect(tenantDefaultCountry({ localeDefault: 'en-NG', currencyDefault: 'KES' })).toBe('NG');
    expect(tenantDefaultCountry({ localeDefault: 'sw_KE', currencyDefault: null })).toBe('KE');
  });

  it('falls back to the currency when the locale names no country we dial', () => {
    expect(tenantDefaultCountry({ localeDefault: 'en', currencyDefault: 'KES' })).toBe('KE');
    expect(tenantDefaultCountry({ localeDefault: 'en-GB', currencyDefault: 'GHS' })).toBe('GH');
    expect(tenantDefaultCountry({ localeDefault: null, currencyDefault: 'zar' })).toBe('ZA');
  });

  it('is null when neither says', () => {
    expect(tenantDefaultCountry({ localeDefault: 'fr', currencyDefault: 'EUR' })).toBeNull();
  });
});

describe('phoneSearchE164', () => {
  it.each([
    ['08031234001', '+2348031234001'],
    ['0803 123 4001', '+2348031234001'],
    ['0803-123-4001', '+2348031234001'],
    ['2348031234001', '+2348031234001'],
    ['+2348031234001', '+2348031234001'],
    ['+234 803 123 4001', '+2348031234001'],
    ['002348031234001', '+2348031234001'],
    ['8031234001', '+2348031234001'],
  ])('reads %s as %s for a Nigerian tenant', (q, e164) => {
    expect(phoneSearchE164(q, 'NG')).toBe(e164);
  });

  it("uses the tenant's own country for a national number", () => {
    expect(phoneSearchE164('0712 345 021', 'KE')).toBe('+254712345021');
    expect(phoneSearchE164('0712 345 021', 'NG')).toBe('+234712345021');
  });

  it('keeps an explicit international number whatever the tenant', () => {
    expect(phoneSearchE164('+254712345021', 'NG')).toBe('+254712345021');
  });

  it.each(['amaka', '%', '_', '.*', '%a%', '12345', '+0803123456', '', 'a'.repeat(100)])(
    'does not read %j as a number',
    (q) => {
      expect(phoneSearchE164(q, 'NG')).toBeNull();
    },
  );

  it('with no default country, only an international form is a number', () => {
    expect(phoneSearchE164('+2348031234001', null)).toBe('+2348031234001');
    expect(phoneSearchE164('2348031234001', null)).toBe('+2348031234001');
    expect(phoneSearchE164('08031234001', null)).toBeNull();
  });
});

describe('foldForSearch', () => {
  it('drops case and diacritics (the contract: Adebayo finds Adébáyọ̀)', () => {
    expect(foldForSearch('Adébáyọ̀')).toBe('adebayo');
    expect(foldForSearch('Ògúnlẹ̀')).toBe('ogunle');
    expect(foldForSearch('EZE')).toBe('eze');
  });

  it('leaves wildcard characters as themselves', () => {
    expect(foldForSearch('%a_')).toBe('%a_');
  });
});
