import { describe, expect, it } from 'vitest';
import { parseReview, DESIGN_MENU_LOCALES, LOCALE_SOURCES } from './catalogues';
import {
  deriveBetaLocales,
  deriveSupportedLocales,
  localeReadiness,
  placeholderNames,
} from './completeness';
import { requiredPluralCategories } from './plurals';
import {
  BETA_LOCALES,
  localeLabel,
  MENU_LOCALES,
  SUPPORTED_LOCALES,
  textDirection,
  translate,
} from './index';

describe('requiredPluralCategories', () => {
  it("does not impose English's two-category shape on other languages", () => {
    // The bug this exists to stop: `one`/`other` copied into every catalogue.
    expect(requiredPluralCategories('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    expect(requiredPluralCategories('fr')).toEqual(['one', 'many', 'other']);
    expect(requiredPluralCategories('ig')).toEqual(['other']);
    expect(requiredPluralCategories('yo')).toEqual(['other']);
    expect(requiredPluralCategories('en')).toEqual(['one', 'other']);
  });

  it('returns only `other` for a language CLDR does not know', () => {
    // Rather than English's shape under another language's name.
    expect(requiredPluralCategories('zxx-Qaai')).toEqual(['other']);
  });
});

describe('the completeness gate', () => {
  it('offers only locales that are both complete and attested', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const readiness = localeReadiness(locale);
      expect(readiness.complete, `${locale}: ${readiness.problems.join('; ')}`).toBe(true);
      expect(readiness.attested, `${locale} is offered without an attestation`).toBe(true);
    }
  });

  it('holds back a structurally complete catalogue that nobody has reviewed', () => {
    // The whole point of D-P1. A machine draft can be flawless structurally and
    // still be wrong in the words, and wrong is worse than missing for the
    // strings a user acts on.
    for (const locale of ['fr', 'ha', 'ig', 'sw', 'pcm', 'yo']) {
      const readiness = localeReadiness(locale);
      expect(readiness.complete, `${locale}: ${readiness.problems.join('; ')}`).toBe(true);
      expect(readiness.attested, `${locale} claims an attestation it does not have`).toBe(false);
      expect(SUPPORTED_LOCALES).not.toContain(locale);
    }
  });

  it('registers Arabic without offering it', () => {
    expect(Object.keys(LOCALE_SOURCES)).toContain('ar');
    expect(SUPPORTED_LOCALES).not.toContain('ar');
    expect(DESIGN_MENU_LOCALES as readonly string[]).not.toContain('ar');
    // Registered means renderable: RTL needs real strings to prove itself on.
    expect(translate('ar', 'notFound.title')).not.toBe(translate('en', 'notFound.title'));
  });

  it('reports a missing message rather than silently falling back', () => {
    const readiness = localeReadiness('zu');
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.join(' ')).toMatch(/no catalogue/);
  });

  it('derives the offered list rather than reading a constant', () => {
    expect([...SUPPORTED_LOCALES]).toEqual([...deriveSupportedLocales()]);
  });
});

describe('Beta languages (D-P1, answered 2026-10-03)', () => {
  it('lists the complete-but-unattested menu languages, and nothing attested', () => {
    expect([...BETA_LOCALES]).toEqual([...deriveBetaLocales()]);
    // Today: the six drafts. A reviewer's sign-off moves one to SUPPORTED.
    expect([...BETA_LOCALES].sort()).toEqual(['fr', 'ha', 'ig', 'pcm', 'sw', 'yo']);
    for (const locale of BETA_LOCALES) {
      const readiness = localeReadiness(locale);
      expect(readiness.complete, `${locale}: ${readiness.problems.join('; ')}`).toBe(true);
      expect(readiness.attested).toBe(false);
      expect(SUPPORTED_LOCALES).not.toContain(locale);
    }
  });

  it('never makes Arabic a Beta language — it is not on the design menu', () => {
    expect(BETA_LOCALES).not.toContain('ar');
    expect(MENU_LOCALES).not.toContain('ar');
  });

  it('builds the menu in the design order, with attested overlays after it', () => {
    expect([...MENU_LOCALES]).toEqual([
      ...DESIGN_MENU_LOCALES.filter(
        (locale) => SUPPORTED_LOCALES.includes(locale) || BETA_LOCALES.includes(locale),
      ),
      'en-NG',
    ]);
    expect(MENU_LOCALES[0]).toBe('en');
  });
});

describe('review attestations', () => {
  it('refuses a sign-off that names nobody', () => {
    // D-P1: "A language with no named reviewer should be treated as option 4
    // until it has one." An unsigned sign-off is not a sign-off.
    expect(() => parseReview('xx', { status: 'reviewed', reviewer: null })).toThrow(
      /named reviewer/,
    );
  });

  it('refuses a status it does not recognise', () => {
    expect(() => parseReview('xx', { status: 'probably fine' })).toThrow(/status must be one of/);
  });
});

describe('direction and labels', () => {
  it('reports RTL for Arabic and LTR for everything offered', () => {
    expect(textDirection('ar')).toBe('rtl');
    expect(textDirection('ar-EG')).toBe('rtl');
    for (const locale of SUPPORTED_LOCALES) {
      expect(textDirection(locale)).toBe('ltr');
    }
  });

  it('names languages in their own words, diacritics included', () => {
    expect(localeLabel('yo')).toBe('Yorùbá');
    expect(localeLabel('fr')).toBe('Français');
    expect(localeLabel('sw')).toBe('Kiswahili');
  });

  it('falls back to the tag, not to an English name', () => {
    // A tag is obviously a placeholder. An English name silently looks finished.
    expect(localeLabel('zu')).toBe('zu');
  });
});

describe('placeholder extraction (regression)', () => {
  // This is the bug that survived review twice: the obvious regex
  // /\{\s*(\w+)/g also matches the first word of a plural BRANCH BODY, so a
  // natural translation reports a placeholder that does not exist.
  //
  // It hid because \w is [A-Za-z0-9_]: the Arabic catalogue's `zero {لا خطوات}`
  // sailed through while the Latin-script catalogues had to be written so every
  // branch led with `#`. That constraint is invisible, undocumented, and wrong
  // for any language that does not put the number first.
  it('does not mistake the first word of a plural branch for a placeholder', () => {
    expect([...placeholderNames('{count, plural, one {a single step} other {# steps}}')]).toEqual([
      'count',
    ]);
  });

  it('still finds real arguments, including inside a branch', () => {
    expect(
      [...placeholderNames('{count, plural, one {{name} has one} other {{name} has #}}')].sort(),
    ).toEqual(['count', 'name']);
  });

  it('finds nothing in a message that has no arguments', () => {
    expect([...placeholderNames('Barka da dawowa')]).toEqual([]);
  });

  it('ignores the pound sign, which is a value and not a name', () => {
    expect([...placeholderNames('{n, plural, other {#}}')]).toEqual(['n']);
  });
});
