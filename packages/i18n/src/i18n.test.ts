import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  EN_CATALOGUE,
  EN_NG_CATALOGUE,
  fallbackChain,
  MESSAGE_IDS,
} from './index';

describe('fallback chain', () => {
  it('walks from most specific to English', () => {
    expect(fallbackChain('en-NG')).toEqual(['en-NG', 'en']);
    expect(fallbackChain('pcm-NG')).toEqual(['pcm-NG', 'pcm', 'en']);
    expect(fallbackChain('en')).toEqual(['en']);
  });
});

describe('translator', () => {
  it('prefers the regional override', () => {
    expect(createTranslator('en-NG').t('app.tagline')).toBe(EN_NG_CATALOGUE['app.tagline']);
  });

  it('falls back to the base catalogue for everything else', () => {
    expect(createTranslator('en-NG').t('app.name')).toBe(EN_CATALOGUE['app.name']);
  });

  it('formats ICU arguments', () => {
    const t = createTranslator('en');
    expect(t.t('tokens.contrast.label', { ratio: '4.51', background: 'surface' })).toContain(
      '4.51',
    );
    expect(t.t('tokens.scale.count', { count: 1 })).toBe('1 step');
    expect(t.t('tokens.scale.count', { count: 11 })).toBe('11 steps');
  });

  it('throws on an unknown message rather than rendering a blank', () => {
    // A missing string is a bug. Rendering nothing hides it until a customer
    // reports an empty button.
    // @ts-expect-error deliberately not a known message id
    expect(() => createTranslator('en').t('does.not.exist')).toThrow(/Missing message/);
  });

  it('keeps the regional overlay a strict subset of the base catalogue', () => {
    for (const id of Object.keys(EN_NG_CATALOGUE)) {
      expect(MESSAGE_IDS).toContain(id);
    }
  });
});
