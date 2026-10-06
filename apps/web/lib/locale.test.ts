import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, PSEUDO_LOCALE } from '@kasuwa/i18n';
import { resolveActiveLocale, type LocaleNodeEnv } from './locale';

/**
 * T-0050, D-P15: the `en-XA` pseudo-locale preview is development and test
 * only. `resolveActiveLocale` is the gate; these pin its decisions directly,
 * one environment at a time, without `next/headers`.
 */

const DEFAULT = { locale: DEFAULT_LOCALE, dir: 'ltr', preview: false } as const;
const PSEUDO_PREVIEW = { locale: PSEUDO_LOCALE, dir: 'ltr', preview: true } as const;

describe('resolveActiveLocale — the en-XA preview', () => {
  it('is refused under production and renders the default locale', () => {
    expect(resolveActiveLocale({ preview: PSEUDO_LOCALE, cookie: null, nodeEnv: 'production' })).toEqual(
      DEFAULT,
    );
  });

  it.each<LocaleNodeEnv>(['development', 'test'])('is honoured under %s', (nodeEnv) => {
    expect(resolveActiveLocale({ preview: PSEUDO_LOCALE, cookie: null, nodeEnv })).toEqual(PSEUDO_PREVIEW);
  });

  it('falls through to the menu cookie when refused, as if no preview were sent', () => {
    expect(resolveActiveLocale({ preview: PSEUDO_LOCALE, cookie: 'fr', nodeEnv: 'production' })).toEqual({
      locale: 'fr',
      dir: 'ltr',
      preview: false,
    });
  });

  it('fails closed for an environment outside the allowlist', () => {
    // The type forbids it; the runtime must not read "not production" as "allowed".
    const unknown = 'staging' as unknown as LocaleNodeEnv;
    expect(resolveActiveLocale({ preview: PSEUDO_LOCALE, cookie: null, nodeEnv: unknown })).toEqual(DEFAULT);
  });

  it.each(['en-xa', 'EN-XA', 'en_XA', ' en-XA', 'en-XA,en'])(
    'matches exactly, so "%s" is not a second spelling of en-XA, even in development',
    (preview) => {
      expect(resolveActiveLocale({ preview, cookie: null, nodeEnv: 'development' })).toEqual(DEFAULT);
    },
  );

  it.each<LocaleNodeEnv>(['development', 'test', 'production'])(
    'cannot be selected by the cookie under %s',
    (nodeEnv) => {
      expect(resolveActiveLocale({ preview: null, cookie: PSEUDO_LOCALE, nodeEnv })).toEqual(DEFAULT);
    },
  );
});

describe('resolveActiveLocale — everything the gate must leave alone', () => {
  it.each<LocaleNodeEnv>(['development', 'test', 'production'])('previews ar, right-to-left, under %s', (nodeEnv) => {
    expect(resolveActiveLocale({ preview: 'ar', cookie: null, nodeEnv })).toEqual({
      locale: 'ar',
      dir: 'rtl',
      preview: true,
    });
  });

  it('takes a menu locale from the cookie under production', () => {
    expect(resolveActiveLocale({ preview: null, cookie: 'fr', nodeEnv: 'production' })).toEqual({
      locale: 'fr',
      dir: 'ltr',
      preview: false,
    });
  });

  it('ignores a cookie that is not on the menu', () => {
    expect(resolveActiveLocale({ preview: null, cookie: 'ar', nodeEnv: 'production' })).toEqual(DEFAULT);
    expect(resolveActiveLocale({ preview: null, cookie: 'xx', nodeEnv: 'production' })).toEqual(DEFAULT);
  });

  it('lets a registered preview win over the cookie', () => {
    expect(resolveActiveLocale({ preview: 'ar', cookie: 'fr', nodeEnv: 'production' }).locale).toBe('ar');
  });
});
