import { describe, expect, it } from 'vitest';
import { createTranslator } from '@kasuwa/i18n';
import { currencyOptionLabel, errorText, modifiedDate } from './studio-text';

const t = createTranslator('en');

describe('errorText', () => {
  it('draws a custom-field detail by its own label, never the code', () => {
    const said = errorText(t, { code: 'validation_failed', details: [{ path: 'apiName', code: 'invalid_api_name' }] });
    expect(said).toBe(t.t('admin.studio.custom.error.invalid_api_name'));
    expect(said).not.toContain('invalid_api_name');
  });

  it('draws a taken name by the duplicate label, not the disposition wording of duplicate_code', () => {
    const said = errorText(t, { code: 'duplicate_code', details: [{ path: 'apiName', code: 'duplicate' }] });
    expect(said).toBe(t.t('admin.studio.custom.error.duplicate'));
    expect(said).not.toBe(t.t('admin.error.duplicate_code'));
  });

  it('does not read a label off the prototype for a hostile detail code', () => {
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(errorText(t, { code: 'validation_failed', details: [{ path: 'x', code }] })).toBe(t.t('admin.error.validation_failed'));
    }
  });

  it('falls back to the localised error code when there is no detail, or a detail it has no label for', () => {
    expect(errorText(t, { code: 'not_permitted' })).toBe(t.t('admin.error.not_permitted'));
    expect(errorText(t, { code: 'network' })).toBe(t.t('admin.error.network'));
    expect(errorText(t, { code: 'validation_failed', details: [{ path: 'x', code: 'something_new' }] })).toBe(
      t.t('admin.error.validation_failed'),
    );
    expect(errorText(t, { code: 'limit_reached' })).toBe(t.t('admin.error.limit_reached'));
  });
});

describe('modifiedDate', () => {
  it('writes English day first with "Sep", and nothing for a date that is not one (T-0149)', () => {
    expect(modifiedDate('en', '2026-09-03T10:00:00Z')).toBe('3 Sep 2026');
    expect(modifiedDate('en', 'not a date')).toBe('');
  });
});

describe('currencyOptionLabel', () => {
  it('names a currency from the catalogue, in the reader’s language, with Intl’s symbol (T-0149)', () => {
    expect(currencyOptionLabel(t, 'en', 'NGN')).toBe(`₦ ${t.t('admin.studio.custom.currency.name.NGN')} (NGN)`);
    const fr = createTranslator('fr');
    expect(currencyOptionLabel(fr, 'fr', 'KES')).toContain(fr.t('admin.studio.custom.currency.name.KES'));
    expect(currencyOptionLabel(t, 'en', 'XYZ')).not.toContain('undefined');
  });
});
