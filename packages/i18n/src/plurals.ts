/**
 * Which plural categories a locale grammatically requires.
 *
 * English has two, so an English developer writes
 * `{n, plural, one {…} other {…}}` and every catalogue copies that shape.
 * Arabic needs six (`zero one two few many other`); French needs `many` for
 * large numbers. A message that omits a category silently renders the `other`
 * branch — grammatically wrong in a way no English-speaking reviewer catches in
 * review, and no Nigerian reviewer catches for Arabic either.
 *
 * The categories are READ FROM CLDR through `Intl.PluralRules` rather than kept
 * in a table here. A hand-kept table is a second copy of CLDR that drifts from
 * it, and the drift is invisible for the same reason the original bug is.
 */

/** The CLDR plural categories, in CLDR's own order. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

function baseTag(locale: string): string {
  return locale.split('-')[0] ?? locale;
}

function isPluralCategory(value: string): value is PluralCategory {
  return (PLURAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The cardinal plural categories `locale` requires, in CLDR order.
 *
 * If the runtime's CLDR does not know the language, `Intl.PluralRules` quietly
 * resolves to the default locale — which would hand back English's `one`/`other`
 * under another language's name, i.e. exactly the bug this function exists to
 * prevent. When that happens we return `['other']` instead: every language has
 * `other`, and requiring only it is the conservative answer. It is better to
 * under-require than to impose English's shape on a language nobody checked.
 */
export function requiredPluralCategories(locale: string): readonly PluralCategory[] {
  const rules = new Intl.PluralRules(locale);
  const resolved = rules.resolvedOptions();

  if (baseTag(resolved.locale) !== baseTag(locale)) {
    return ['other'];
  }

  const categories = resolved.pluralCategories.filter(isPluralCategory);
  const ordered = PLURAL_CATEGORIES.filter((category) => categories.includes(category));

  // `other` is mandatory in ICU whatever CLDR says, and a runtime that omits it
  // would produce a message that cannot be formatted at all.
  return ordered.includes('other') ? ordered : [...ordered, 'other'];
}
