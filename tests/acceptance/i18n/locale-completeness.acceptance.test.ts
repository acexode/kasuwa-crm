import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0009, the seven locale catalogues and the completeness gate
 * (Agent 11, Frontend & Design System).
 *
 * PENDING. `pnpm test:pending` runs them. Renaming this file to drop
 * `.pending` is what assigns the task.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS SUITE EXISTS TO ENFORCE
 *
 *   Shipping a menu entry that falls back to English is worse than offering
 *   fewer languages.
 *
 * It is worse because it is a promise the product breaks the moment someone
 * accepts it. A Hausa speaker who picks Hausa and gets an English form has
 * been told, in the most concrete way available, that the language menu was
 * decoration. Offering six languages honestly is a better product than
 * offering seven dishonestly, and this suite makes the dishonest version fail
 * the build rather than fail the user.
 *
 * So the central assertion is not "the catalogues exist". It is that
 * SUPPORTED_LOCALES is DERIVED from completeness rather than hand-maintained —
 * the list of languages offered and the list of languages finished are the
 * same list, structurally, and cannot drift.
 * ------------------------------------------------------------------------
 *
 * THE SECOND THING THIS CATCHES, which is less obvious and more likely:
 * English-shaped plurals. English has two plural categories, so an English
 * developer writes `{n, plural, one {...} other {...}}` and every catalogue
 * copies that shape. Arabic needs six categories; a message missing `few` or
 * `many` renders the `other` branch, which in Arabic is grammatically wrong in
 * a way an English speaker cannot see in review. The check is mechanical and
 * the bug is invisible — a good trade.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const LOCALES_DIR = 'packages/i18n/src/locales';

/**
 * The seven offered on `P01/1`, cited from the design export rather than
 * invented here: English, Français, Hausa, Igbo, Kiswahili, Pidgin, Yorùbá.
 *
 * `en-NG` stays as the overlay it already is. `ar` is deliberately NOT in this
 * list — see the RTL group below.
 */
const OFFERED = ['en', 'fr', 'ha', 'ig', 'sw', 'pcm', 'yo'] as const;

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot(LOCALES_DIR, `${locale}.json`), 'utf8'));
}

function englishKeys(): string[] {
  return Object.keys(catalogue('en'));
}

describe('acceptance (pending): every offered language is actually translated', () => {
  it('ships a catalogue for each of the seven languages on P01/1', () => {
    for (const locale of OFFERED) {
      expect(
        existsSync(fromRoot(LOCALES_DIR, `${locale}.json`)),
        `${locale}.json is missing — it is offered on the P01/1 language menu`,
      ).toBe(true);
    }
  });

  it('translates every key in every offered language, with nothing left in English', async () => {
    const keys = englishKeys();
    const en = catalogue('en');

    for (const locale of OFFERED) {
      if (locale === 'en') continue;

      const target = catalogue(locale);
      const missing = keys.filter((key) => !(key in target));

      expect(missing, `${locale}: ${missing.length} untranslated key(s)`).toEqual([]);

      // A key that is present but identical to English is the same failure
      // wearing a disguise — it is how a half-finished catalogue passes a
      // key-count check. Some strings legitimately match (a product name, an
      // abbreviation), so the catalogue must SAY SO rather than be silently
      // forgiven.
      const untranslated = keys.filter(
        (key) => target[key] === en[key] && !isDeliberatePassthrough(locale, key),
      );

      expect(
        untranslated,
        `${locale}: key(s) identical to English and not declared as deliberate passthroughs`,
      ).toEqual([]);
    }
  });

  it('derives SUPPORTED_LOCALES from completeness rather than a hand-kept list', async () => {
    // THE CENTRAL ASSERTION. A hand-maintained list drifts: someone adds a
    // catalogue and forgets the constant, or adds the constant ahead of the
    // catalogue to "unblock the menu". The second is the one that ships a
    // language that falls back to English.
    //
    // AMENDED BY THE LEAD after D-P1 was answered. This originally asserted
    // that all seven menu languages are offered. That was written BEFORE
    // @acexode answered D-P1, and the answer supersedes its premise: a
    // language with no named reviewer stays unoffered. No reviewer has been
    // named, so the honest offered set today is English and its overlay.
    //
    // Left as a record of how it was changed, because "the test was wrong" is
    // the most dangerous sentence in this repository. It was not wrong about
    // the property; it encoded an assumption a human decision then replaced.
    // The builder that hit this refused to make it pass and said so, which is
    // exactly right — a builder must never edit an acceptance test.
    //
    // What replaces it is STRICTER, not looser: the offered set must equal the
    // ready set exactly, and the held-back languages must be provably complete
    // rather than merely absent.
    const i18n: {
      SUPPORTED_LOCALES: readonly string[];
      allLocaleReadiness: () => readonly {
        locale: string;
        complete: boolean;
        attested: boolean;
        ready: boolean;
        problems: readonly string[];
      }[];
    } = await import(fromRoot('packages/i18n/src/index.ts'));

    const readiness = i18n.allLocaleReadiness();
    const ready = readiness.filter((entry) => entry.ready).map((entry) => entry.locale);

    // Offered is exactly ready. Not a superset (a language that falls back),
    // not a subset (a finished language nobody switched on).
    expect([...i18n.SUPPORTED_LOCALES].sort()).toEqual([...ready].sort());

    // Nothing reaches the menu on structural completeness alone. This is the
    // half D-P1 added and the half a machine can satisfy by itself, so it is
    // the half most likely to be quietly dropped.
    for (const locale of i18n.SUPPORTED_LOCALES) {
      const entry = readiness.find((candidate) => candidate.locale === locale);
      expect(entry?.attested, `${locale} is offered without a named reviewer`).toBe(true);
    }

    const source = readFileSync(fromRoot('packages/i18n/src/index.ts'), 'utf8');
    expect(
      source,
      'SUPPORTED_LOCALES is still a literal array — an incomplete locale can be added to it',
    ).not.toMatch(/SUPPORTED_LOCALES\s*=\s*\[\s*'/);
  });

  it('holds languages back for attestation only, never for missing work', async () => {
    // The replacement for "all seven are offered", and a stronger property.
    //
    // If a menu language were held back because its catalogue is full of
    // holes, "awaiting review" would be a comfortable label on unfinished
    // work, and the gate would be hiding the backlog rather than reporting it.
    // Every held-back language must be STRUCTURALLY COMPLETE — so the only
    // thing standing between it and the menu is a human name.
    const i18n: {
      SUPPORTED_LOCALES: readonly string[];
      allLocaleReadiness: () => readonly {
        locale: string;
        complete: boolean;
        attested: boolean;
        problems: readonly string[];
      }[];
    } = await import(fromRoot('packages/i18n/src/index.ts'));

    const readiness = i18n.allLocaleReadiness();

    for (const locale of OFFERED) {
      if (i18n.SUPPORTED_LOCALES.includes(locale)) continue;

      const entry = readiness.find((candidate) => candidate.locale === locale);
      expect(entry, `${locale} is on the P01/1 menu but has no catalogue at all`).toBeDefined();
      expect(
        entry?.complete,
        `${locale} is held back for real gaps, not just review: ${entry?.problems.join('; ')}`,
      ).toBe(true);
      expect(entry?.attested, `${locale} is complete and attested but not offered`).toBe(false);
    }
  });

  it('gives no deployment a way to widen the offered set', async () => {
    // Found by the T-0009 builder, and it was real: `@kasuwa/config` carried
    // its own SUPPORTED_LOCALES environment variable. Nothing read it, but it
    // could have turned on a language the gate considers unfinished — the
    // dishonest menu this whole suite exists to prevent, reachable by editing
    // a deployment variable and touching no code.
    //
    // Two sources of truth for one fact, one of which can lie silently.
    // Removed rather than reconciled (D-L27). A deployment may narrow the set
    // through a feature flag; it may never widen it.
    const config = readFileSync(fromRoot('packages/config/src/index.ts'), 'utf8');
    expect(
      config,
      '@kasuwa/config declares SUPPORTED_LOCALES again — it can widen past the gate',
    ).not.toMatch(/SUPPORTED_LOCALES:/);

    const example = readFileSync(fromRoot('.env.example'), 'utf8');
    expect(example, '.env.example still advertises SUPPORTED_LOCALES').not.toMatch(
      /^SUPPORTED_LOCALES=/m,
    );
  });

  it('resolves every key in every offered locale without reaching the English fallback', async () => {
    // The end-to-end version of the rule, through the real resolver rather
    // than by reading files: whatever the fallback chain does, no offered
    // locale may depend on it.
    const i18n: {
      SUPPORTED_LOCALES: readonly string[];
      translate: (locale: string, id: string, values?: Record<string, unknown>) => string;
    } = await import(fromRoot('packages/i18n/src/index.ts'));

    const en = catalogue('en');

    for (const locale of OFFERED) {
      if (locale === 'en') continue;
      const target = catalogue(locale);

      for (const key of englishKeys()) {
        const resolved = i18n.translate(locale, key);
        // It resolved from the locale's own catalogue if it matches that
        // catalogue's entry. If it matches English while the catalogue says
        // something else, the fallback fired.
        if (target[key] !== undefined && target[key] !== en[key]) {
          expect(resolved, `${locale}.${key} fell back to English`).not.toBe(en[key]);
        }
      }
    }
  });
});

describe('acceptance (pending): plurals are not English-shaped', () => {
  it('provides every plural category each locale grammatically requires', async () => {
    // Arabic: zero, one, two, few, many, other. French: one, many, other.
    // Hausa, Igbo, Yorùbá and Pidgin: other (and one, for some). A message
    // that offers only one/other renders `other` for the missing categories,
    // which is wrong in a way no English-speaking reviewer will catch.
    const i18n: {
      requiredPluralCategories: (locale: string) => readonly string[];
    } = await import(fromRoot('packages/i18n/src/index.ts'));

    const keys = englishKeys();

    for (const locale of [...OFFERED, 'ar']) {
      if (!existsSync(fromRoot(LOCALES_DIR, `${locale}.json`))) continue;

      const target = catalogue(locale);
      const required = i18n.requiredPluralCategories(locale);

      for (const key of keys) {
        const message = target[key];
        if (message === undefined || !message.includes('plural,')) continue;

        for (const category of required) {
          expect(
            message,
            `${locale}.${key}: missing the "${category}" plural category`,
          ).toMatch(new RegExp(`\\b${category}\\s*\\{`));
        }
      }
    }
  });

  it('validates ICU syntax as a build step, and that step fails on a bad message', () => {
    // A malformed ICU string throws at render time, on the screen that uses
    // it, for the one user who chose that language. Catch it at build.
    //
    // Asserted through `pnpm i18n:validate` rather than by parsing here, for
    // two reasons: it makes the validator a real mechanism a developer can run
    // rather than an assertion only CI sees, and it keeps the ICU parser a
    // dependency of the i18n package instead of adding one to the acceptance
    // suite.
    const scripts = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8')).scripts ?? {};
    expect(scripts['i18n:validate'], 'no pnpm i18n:validate script').toBeDefined();

    const clean = spawnSync('pnpm', ['i18n:validate'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(clean.status, `i18n:validate failed on the committed catalogues:
${clean.stdout}`).toBe(
      0,
    );

    // And it must actually reject something. A validator only ever seen
    // passing is indistinguishable from one that validates nothing — the same
    // rule applied to the design-token drift check and the e2e byte budget.
    const broken = spawnSync(
      'pnpm',
      // Contract: `--probe <message>` validates one extra message supplied on
      // the command line. A flag rather than an environment variable, both
      // because `@kasuwa/config` owns the environment and because a probe that
      // cannot be left behind in a shell is a probe that cannot mislead a
      // later run.
      ['i18n:validate', '--', '--probe', '{count, plural, one {one} '],
      { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' },
    );

    expect(broken.status, 'i18n:validate accepted a malformed ICU message').not.toBe(0);
  });

  it('keeps every placeholder English declared', async () => {
    // A translator who drops `{count}` produces a sentence with a hole in it;
    // one who invents `{total}` produces a render-time error. Both are common
    // and neither is visible without the source beside the translation.
    // AMENDED BY THE LEAD, 2026-09-27. This used the regex /\{\s*(\w+)/g,
    // which also matches the first word of a plural BRANCH BODY — so
    // `one {Encore # tentative}` reports a placeholder named `Encore`.
    //
    // I fixed that bug in `completeness.ts` during the T-0009 review, with a
    // long comment explaining why a regex cannot do this, AND LEFT THE SAME
    // REGEX HERE. So the implementation was right and the test still enforced
    // the broken rule — which is worse than either alone, because the test is
    // what the next person is forced to obey.
    //
    // The T-0007 builder hit it and complied the only way it could without
    // editing this file: it made every French, Hausa, Igbo and Swahili plural
    // branch start with `#`. That silently forbids every plural form that does
    // not lead with the number, which is a constraint on wording in four
    // languages nobody chose and nobody wrote down.
    //
    // Now reuses the parser rather than repeating its job. Those catalogues can
    // be reworded naturally whenever a reviewer under D-P1 wants to.
    const { placeholderNames } = await import(fromRoot('packages/i18n/src/completeness.ts'));

    const en = catalogue('en');
    const placeholders = (message: string): string[] =>
      [...(placeholderNames(message) as Set<string>)].sort();

    for (const locale of OFFERED) {
      if (locale === 'en') continue;
      const target = catalogue(locale);

      for (const [key, message] of Object.entries(en)) {
        const translated = target[key];
        if (translated === undefined) continue;

        const expected = new Set(placeholders(message));
        const actual = new Set(placeholders(translated));

        for (const name of actual) {
          if (['plural', 'select', 'selectordinal'].includes(name)) continue;
          expect(
            expected.has(name) || isPluralCategory(name),
            `${locale}.${key}: unknown placeholder {${name}} — it will not be supplied`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('acceptance (pending): RTL works before it is offered', () => {
  const AR = 'ar';

  it('ships an Arabic catalogue even though Arabic is not on the menu', () => {
    // Deliberate and worth explaining, because it looks like an oversight in
    // both directions.
    //
    // Arabic is NOT offered: it is not on `P01/1`, so shipping it in the menu
    // would break the rule at the top of this file.
    //
    // Arabic IS present: RTL is not a translation, it is a layout mode, and
    // retrofitting it across thirty screens is a project while proving it on
    // one is an afternoon. PRD 2.9 lists `ar`, and T-0007's definition of done
    // requires RTL verified with `dir="rtl" lang="ar"` — which needs something
    // to render.
    expect(
      existsSync(fromRoot(LOCALES_DIR, `${AR}.json`)),
      'no Arabic catalogue — RTL cannot be proven on a real string',
    ).toBe(true);
  });

  // Passes today, and legitimately: it is a NEGATIVE invariant — Arabic must
  // stay off the menu before this task and after it. It is here to go red if
  // someone adds `ar` to the menu because the catalogue exists, which is the
  // exact drift the central assertion above is designed to prevent.
  it('does not offer Arabic in the language menu', async () => {
    const i18n: { SUPPORTED_LOCALES: readonly string[] } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );

    expect(
      i18n.SUPPORTED_LOCALES,
      'Arabic is offered but is not on P01/1 — decide deliberately, do not drift into it',
    ).not.toContain(AR);
  });

  it('reports text direction per locale', async () => {
    const i18n: { textDirection: (locale: string) => 'ltr' | 'rtl' } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );

    expect(i18n.textDirection(AR)).toBe('rtl');
    for (const locale of OFFERED) {
      expect(i18n.textDirection(locale), `${locale} should be ltr`).toBe('ltr');
    }
  });
});

describe('acceptance (pending): the language menu names languages in their own words', () => {
  it('labels each locale endonymically, exactly as the design does', async () => {
    // "Yorùbá", not "Yoruba (Nigeria)". A language menu written in English is
    // useless to the person who cannot read English, which is the entire
    // population it exists for. The diacritics are part of the word.
    const i18n: { localeLabel: (locale: string) => string } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );

    const expected: Record<string, string> = {
      en: 'English',
      fr: 'Français',
      ha: 'Hausa',
      ig: 'Igbo',
      sw: 'Kiswahili',
      pcm: 'Pidgin',
      yo: 'Yorùbá',
    };

    for (const [locale, label] of Object.entries(expected)) {
      expect(i18n.localeLabel(locale), `${locale} label`).toBe(label);
    }
  });
});

/**
 * A locale may declare, per key, that matching English is correct — a product
 * name, an abbreviation, a loanword in common use. The point is that it is
 * DECLARED. An undeclared match is indistinguishable from an untranslated
 * string, and treating them the same is how half a catalogue ships.
 *
 * Contract: `packages/i18n/src/locales/<locale>.passthrough.json`, an array of
 * message ids.
 */
function isDeliberatePassthrough(locale: string, key: string): boolean {
  const path = fromRoot(LOCALES_DIR, `${locale}.passthrough.json`);
  if (!existsSync(path)) return false;
  const declared: string[] = JSON.parse(readFileSync(path, 'utf8'));
  return declared.includes(key);
}

function isPluralCategory(name: string): boolean {
  return ['zero', 'one', 'two', 'few', 'many', 'other'].includes(name);
}
