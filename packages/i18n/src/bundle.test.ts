import { describe, expect, it } from 'vitest';
import { bundleMessages, createBundleTranslator, requiredPluralCategories } from './index';
import ha from './locales/ha.json';

/**
 * The server-resolves / client-formats split that keeps nine catalogues out of
 * the browser bundle (see the note on `MessageBundle`).
 *
 * The property that matters is not "it formats a string". It is that the bundle
 * cannot silently pretend: a missing id has to throw here exactly as it does in
 * `createTranslator`, because the alternative — a blank button — hides the bug
 * until a customer reports it.
 */
describe('bundleMessages', () => {
  it('resolves through the fallback chain, not from one file', () => {
    // `en-NG` is an overlay holding only what differs. `nav.skipToContent` is
    // not in it, so this can only come from `en` — which is the chain working.
    const bundle = bundleMessages('en-NG', ['app.tagline', 'nav.skipToContent']);
    expect(bundle['app.tagline']).toContain('Naija');
    expect(bundle['nav.skipToContent']).toBe('Skip to content');
  });

  it('throws on an id that does not exist', () => {
    expect(() => bundleMessages('en', ['auth.signIn.nope' as 'app.name'])).toThrow(/auth\.signIn\.nope/);
  });
});

describe('createBundleTranslator', () => {
  it('throws when a screen forgot to ask for a string', () => {
    const t = createBundleTranslator('en', bundleMessages('en', ['app.name']));
    expect(() => t.t('auth.signIn.title')).toThrow(/not in the bundle/);
  });

  it('formats ICU arguments, including the plural on the lockout counter', () => {
    const t = createBundleTranslator('en', bundleMessages('en', ['auth.attemptsRemaining']));
    expect(t.t('auth.attemptsRemaining', { count: 1 })).toContain('1 more try');
    expect(t.t('auth.attemptsRemaining', { count: 4 })).toContain('4 more tries');
  });

  it('uses the LOCALE’s plural rules, not English ones', () => {
    // The failure this guards against is invisible to an English reviewer: a
    // catalogue written with only `one`/`other` renders `other` for every
    // category the language actually requires. Hausa needs `one` and `other`;
    // the point is that the formatter is asked in Hausa, not in English.
    const t = createBundleTranslator('ha', bundleMessages('ha', ['auth.attemptsRemaining']));
    const one = t.t('auth.attemptsRemaining', { count: 1 });
    const many = t.t('auth.attemptsRemaining', { count: 4 });

    expect(one).not.toBe('');
    expect(one).not.toBe(many);
    expect(ha['auth.attemptsRemaining']).toContain('plural,');
    for (const category of requiredPluralCategories('ha')) {
      expect(ha['auth.attemptsRemaining']).toMatch(new RegExp(`\\b${category}\\s*\\{`));
    }
  });
});
