import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0050, the `en-XA` pseudo-locale is development and test only
 * (Agent 11, Frontend & Design System). D-P15, answered: "The pseudo-locale
 * preview is for development and test only, and production refuses it."
 *
 * ------------------------------------------------------------------------
 * WHAT IS BEING CLOSED
 *
 * T-0042 made `?locale=en-XA` render the pseudo-locale (bracketed, accented,
 * padded English) on a real screen, which is how the "string never
 * externalised" check runs in e2e. It made it render in production too. A
 * production user who follows a `?locale=en-XA` link — or is sent one — gets
 * a product that looks broken. The gate: under NODE_ENV=production the
 * preview is refused and the request renders exactly as if no preview had
 * been asked for.
 *
 * THE INTERFACE THIS SUITE PINS (the builder implements it; everything else
 * is theirs). In `apps/web/lib/locale.ts`:
 *
 *   export type LocaleNodeEnv = 'development' | 'test' | 'production';
 *
 *   export interface LocaleRequest {
 *     // The `x-kasuwa-preview-locale` header value (PREVIEW_LOCALE_HEADER),
 *     // set by middleware.ts from `?locale=`, or null when absent.
 *     readonly preview: string | null;
 *     // The `kasuwa_locale` cookie value (LOCALE_COOKIE), or null when absent.
 *     readonly cookie: string | null;
 *     // The process's NODE_ENV, read AT RUNTIME (see the trap below).
 *     readonly nodeEnv: LocaleNodeEnv;
 *   }
 *
 *   // Pure: no `next/headers`, no environment read. Returns the existing
 *   // `ActiveLocale` shape ({ locale, dir, preview }).
 *   export function resolveActiveLocale(request: LocaleRequest): ActiveLocale;
 *
 * and `activeLocale()` becomes a thin wrapper that reads the header, the
 * cookie and NODE_ENV and delegates to it. The last test in this file checks
 * that delegation, because a gate in a function nothing calls is no gate.
 *
 * WHY THE GATE MUST BE IN THE RESOLVER AND NOT IN middleware.ts: the
 * middleware forwards every incoming request header, so a client can send
 * `x-kasuwa-preview-locale: en-XA` directly without any `?locale=`. Gating
 * the query parameter alone would leave that path open. Every input this
 * suite tries arrives through `preview`, which covers both.
 *
 * WHICH REQUEST PATHS EXIST. Two: the preview header (from `?locale=` or sent
 * directly) and the cookie. Nothing in apps/web reads `Accept-Language`
 * today; if a future change adds that path it must go through
 * `resolveActiveLocale` and take this gate with it.
 *
 * ------------------------------------------------------------------------
 * THE TRAP THE e2e JOURNEY EXISTS TO CATCH
 *
 * The `@p04-pseudo` journey in `tests/e2e/p04-contacts.spec.ts` (T-0042) runs
 * against `startRecordsWeb` in `tests/e2e/scripts/run-e2e.mjs`: `next start`
 * over the PRODUCTION BUILD, with NODE_ENV=test at runtime (D-L64). It must
 * keep passing. Next inlines a literal `process.env.NODE_ENV` into compiled
 * code at build time, and the build is always `production` (`build.mjs`). A
 * gate that reads NODE_ENV that way passes every test in this file and then
 * refuses en-XA on the test-env server, failing `@p04-pseudo`. Read NODE_ENV
 * at runtime — the same way the feature-flag guard does
 * (`flagProcessNodeEnv` in `@kasuwa/config/feature-flags`) — and run
 * `pnpm test:e2e -- --grep @p04-pseudo` before reporting done. This suite
 * asserts the journey and that server's environment still exist; it cannot
 * prove the runtime read without a browser, and that is the e2e's job.
 * ------------------------------------------------------------------------
 *
 * ON THE PASSES THAT ARE NOT COVERAGE. Several assertions below hold before
 * this task starts — `en-XA` is on no menu, a cookie cannot select it, `ar`
 * previews in every environment. They are NEGATIVE or PRESERVATION
 * invariants: they go red if the gate is built too wide (refusing `ar`, or
 * refusing en-XA in test) or if en-XA drifts onto the menu. Each is marked
 * where it appears so the count is not mistaken for coverage. The tests that
 * MUST fail before the change are in group 1.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const LOCALE_MODULE = fromRoot('apps/web/lib/locale.ts');
const I18N_MODULE = fromRoot('packages/i18n/src/index.ts');

const PSEUDO = 'en-XA';
const AR = 'ar';

type LocaleNodeEnv = 'development' | 'test' | 'production';

interface ActiveLocale {
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly preview: boolean;
}

interface LocaleRequest {
  readonly preview: string | null;
  readonly cookie: string | null;
  readonly nodeEnv: LocaleNodeEnv;
}

interface MenuLanguage {
  readonly code: string;
  readonly label: string;
}

interface LocaleModule {
  resolveActiveLocale?: (request: LocaleRequest) => ActiveLocale;
  languageOptions: (locale: string) => MenuLanguage[];
}

interface I18nModule {
  DEFAULT_LOCALE: string;
  PSEUDO_LOCALE: string;
  MENU_LOCALES: readonly string[];
  REGISTERED_LOCALES: readonly string[];
  createTranslator: (locale: string) => { t: (id: string) => string };
}

async function localeModule(): Promise<LocaleModule> {
  return (await import(LOCALE_MODULE)) as LocaleModule;
}

async function i18n(): Promise<I18nModule> {
  return (await import(I18N_MODULE)) as I18nModule;
}

async function resolver(): Promise<(request: LocaleRequest) => ActiveLocale> {
  const module = await localeModule();
  expect(
    typeof module.resolveActiveLocale,
    'apps/web/lib/locale.ts exports no resolveActiveLocale(request) — the T-0050 interface (see the header)',
  ).toBe('function');
  return module.resolveActiveLocale as (request: LocaleRequest) => ActiveLocale;
}

/**
 * Message ids to render, taken from `en.json` rather than invented: plain
 * strings with letters and vowels and no ICU arguments, so the pseudo
 * transform visibly changes every one of them and `t()` needs no values.
 */
function sampleIds(): string[] {
  const en = JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales/en.json'), 'utf8'),
  ) as Record<string, string>;
  const ids = Object.entries(en)
    .filter(([, message]) => !message.includes('{') && /[aeiou]/i.test(message))
    .map(([id]) => id)
    .slice(0, 12);
  expect(ids.length, 'en.json yielded no sample messages; every render check below would be vacuous').toBe(12);
  return ids;
}

/** T-0042's pseudo text: `[Àccëntëd··]` — brackets, accented vowels, a `·` pad. */
function looksPseudo(text: string): boolean {
  return /·/.test(text) || /^\[.*\]$/s.test(text);
}

const PRODUCTION: LocaleNodeEnv = 'production';
const PSEUDO_ALLOWED: readonly LocaleNodeEnv[] = ['development', 'test'];

// ===========================================================================
// 1. Production refuses en-XA. MUST FAIL before T-0050.
// ===========================================================================

describe('acceptance: T-0050 — under NODE_ENV=production, en-XA resolves to the default locale', () => {
  it('refuses ?locale=en-XA (the preview header) and renders the default locale, not pseudo text', async () => {
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE, createTranslator } = await i18n();

    const result = resolveLocale({ preview: PSEUDO, cookie: null, nodeEnv: PRODUCTION });

    expect(result.locale, 'production resolved the en-XA preview — D-P15 says it must refuse it').toBe(
      DEFAULT_LOCALE,
    );
    expect(result.preview, 'a refused preview is still flagged as a preview').toBe(false);
    expect(result.dir).toBe('ltr');

    // The locale id is not the whole claim: what the user SEES must be the
    // default language's text, not pseudo text under a default-looking id.
    const shown = createTranslator(result.locale);
    const english = createTranslator(DEFAULT_LOCALE);
    for (const id of sampleIds()) {
      const text = shown.t(id);
      expect(looksPseudo(text), `production rendered pseudo text for ${id}: ${text}`).toBe(false);
      expect(text, `production rendered ${id} differently from ${DEFAULT_LOCALE}`).toBe(english.t(id));
    }
  });

  it('treats a refused en-XA preview exactly as if no preview had been sent, cookie included', async () => {
    // Refusing the preview must not also throw away the user's menu choice.
    // The rule is "as if it were absent", and absent falls through to the
    // cookie. `fr` is used because it is on the menu (Beta) today.
    const resolveLocale = await resolver();
    const { MENU_LOCALES } = await i18n();
    expect(MENU_LOCALES, 'fr is no longer on the menu; pick another menu locale here').toContain('fr');

    for (const cookie of [null, 'fr']) {
      const refused = resolveLocale({ preview: PSEUDO, cookie, nodeEnv: PRODUCTION });
      const absent = resolveLocale({ preview: null, cookie, nodeEnv: PRODUCTION });
      expect(refused, `production with cookie=${String(cookie)}: en-XA preview changed the result`).toEqual(
        absent,
      );
    }
  });

  it('never renders pseudo text in production for spellings of en-XA a hand or a proxy might produce', async () => {
    // REGRESSION GUARD, passes before the change: the lookup is exact today,
    // so these already fall back. It is here so a "helpful" normalisation
    // (lower-casing, trimming, `_` to `-`) added with the gate cannot reopen
    // the hole by a different spelling.
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE, createTranslator } = await i18n();
    const ids = sampleIds();

    for (const preview of ['en-xa', 'EN-XA', 'en_XA', ' en-XA', 'en-XA ', 'en-XA,en', 'en-XA-x-test']) {
      const result = resolveLocale({ preview, cookie: null, nodeEnv: PRODUCTION });
      expect(result.locale, `production resolved preview "${preview}"`).toBe(DEFAULT_LOCALE);
      const shown = createTranslator(result.locale);
      for (const id of ids) {
        expect(looksPseudo(shown.t(id)), `production rendered pseudo text for "${preview}" / ${id}`).toBe(false);
      }
    }
  });

  it('cannot be reached through the cookie in any environment', async () => {
    // NEGATIVE invariant, passes before the change: the cookie only ever
    // holds a MENU locale and en-XA is on no menu. Listed so that the cookie
    // path is covered explicitly rather than assumed.
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE } = await i18n();
    for (const nodeEnv of [PRODUCTION, ...PSEUDO_ALLOWED]) {
      const result = resolveLocale({ preview: null, cookie: PSEUDO, nodeEnv });
      expect(result.locale, `cookie=en-XA selected the pseudo-locale under ${nodeEnv}`).toBe(DEFAULT_LOCALE);
      expect(result.preview).toBe(false);
    }
  });
});

// ===========================================================================
// 2. Development and test keep en-XA (PRESERVATION — the gate must not be
//    built so wide that the T-0042 check stops running).
// ===========================================================================

describe('acceptance: T-0050 — under development and test, en-XA still resolves to the pseudo-locale', () => {
  it('resolves ?locale=en-XA to en-XA and renders pseudo text under development and test', async () => {
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE, PSEUDO_LOCALE, createTranslator } = await i18n();
    expect(PSEUDO_LOCALE, 'the pseudo-locale id moved; this suite and the e2e journey both name en-XA').toBe(
      PSEUDO,
    );

    const english = createTranslator(DEFAULT_LOCALE);
    for (const nodeEnv of PSEUDO_ALLOWED) {
      const result = resolveLocale({ preview: PSEUDO, cookie: null, nodeEnv });
      expect(result, `en-XA refused under NODE_ENV=${nodeEnv}`).toEqual({
        locale: PSEUDO,
        dir: 'ltr',
        preview: true,
      });

      // This is also what proves `looksPseudo` can say yes: if it never
      // matched, every "no pseudo text" assertion in group 1 would be vacuous.
      const shown = createTranslator(result.locale);
      for (const id of sampleIds()) {
        const text = shown.t(id);
        expect(looksPseudo(text), `NODE_ENV=${nodeEnv}: ${id} is not pseudo text: ${text}`).toBe(true);
        expect(text, `NODE_ENV=${nodeEnv}: ${id} rendered as plain English`).not.toBe(english.t(id));
      }
    }
  });

  it('still has the @p04-pseudo e2e journey, served by `next start` with NODE_ENV=test', () => {
    // The journey is the only proof that NODE_ENV is read at RUNTIME, not
    // inlined from the production build (see the header). These are file
    // checks that it still exists and still points at a test-env server;
    // running it is `pnpm test:e2e -- --grep @p04-pseudo`.
    const spec = fromRoot('tests/e2e/p04-contacts.spec.ts');
    expect(existsSync(spec), 'tests/e2e/p04-contacts.spec.ts is missing — T-0050 depends on T-0042').toBe(true);
    const journey = readFileSync(spec, 'utf8');
    expect(journey, 'the @p04-pseudo journey is gone').toMatch(/@p04-pseudo/);
    expect(journey, 'the @p04-pseudo journey no longer requests ?locale=en-XA').toMatch(/locale=en-XA/);

    // Normalised: the checkout may have CRLF line endings on Windows.
    const harness = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const records = /function startRecordsWeb\b[\s\S]*?\n}\n/.exec(harness)?.[0] ?? '';
    expect(records, 'run-e2e.mjs no longer defines startRecordsWeb').not.toBe('');
    expect(records, 'the records web server is no longer `next start`').toMatch(/'next',\s*'start'/);
    expect(records, 'the records web server no longer runs with NODE_ENV=test').toMatch(
      /NODE_ENV:\s*'test'/,
    );
  });
});

// ===========================================================================
// 3. The language menu never lists en-XA (NEGATIVE — passes before the change;
//    goes red if en-XA drifts onto the menu, in production or anywhere).
// ===========================================================================

describe('acceptance: T-0050 — the language menu does not list en-XA', () => {
  it('leaves en-XA out of MENU_LOCALES and out of every languageOptions() the server builds', async () => {
    // The menu is built on the server by `languageOptions()` from
    // MENU_LOCALES, and takes no environment: there is one menu, and the
    // production build serves it. So it is checked for every locale a page
    // can render in — including en-XA itself and ar, the two preview-only
    // locales — rather than for one.
    const { MENU_LOCALES, REGISTERED_LOCALES } = await i18n();
    const { languageOptions } = await localeModule();

    expect(MENU_LOCALES, 'en-XA is on the menu').not.toContain(PSEUDO);

    const pageLocales = [...new Set([...REGISTERED_LOCALES, PSEUDO])];
    expect(pageLocales.length, 'no registered locales: the loop below would check nothing').toBeGreaterThan(2);
    for (const pageLocale of pageLocales) {
      const menu = languageOptions(pageLocale);
      expect(menu.length, `languageOptions(${pageLocale}) is empty`).toBeGreaterThan(0);
      const codes = menu.map((entry) => entry.code);
      expect(codes, `the menu on a ${pageLocale} page lists en-XA`).not.toContain(PSEUDO);
      for (const entry of menu) {
        expect(looksPseudo(entry.label), `menu entry ${entry.code} has a pseudo label: ${entry.label}`).toBe(
          false,
        );
      }
    }
  });
});

// ===========================================================================
// 4. ar is not affected by the gate (PRESERVATION — D-P1; ar is a preview
//    locale like en-XA, and a gate written as "no previews in production"
//    would take RTL proof down with it).
// ===========================================================================

describe('acceptance: T-0050 — the gate does not touch ar', () => {
  it('still previews ar, right-to-left, in production, development and test', async () => {
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE, REGISTERED_LOCALES, createTranslator } = await i18n();
    expect(REGISTERED_LOCALES, 'ar is no longer registered').toContain(AR);

    const ids = sampleIds();
    const arabic = JSON.parse(
      readFileSync(fromRoot('packages/i18n/src/locales/ar.json'), 'utf8'),
    ) as Record<string, string>;

    for (const nodeEnv of [PRODUCTION, ...PSEUDO_ALLOWED]) {
      const result = resolveLocale({ preview: AR, cookie: null, nodeEnv });
      expect(result, `ar preview changed under NODE_ENV=${nodeEnv}`).toEqual({
        locale: AR,
        dir: 'rtl',
        preview: true,
      });
      const shown = createTranslator(result.locale);
      for (const id of ids) {
        expect(shown.t(id), `NODE_ENV=${nodeEnv}: ${id} did not render from ar.json`).toBe(
          arabic[id] ?? createTranslator(DEFAULT_LOCALE).t(id),
        );
      }
    }
  });

  it('still keeps ar out of the cookie path in every environment', async () => {
    // NEGATIVE invariant, passes before the change: ar is on no menu, so a
    // cookie cannot select it. The gate must not widen that either.
    const resolveLocale = await resolver();
    const { DEFAULT_LOCALE } = await i18n();
    for (const nodeEnv of [PRODUCTION, ...PSEUDO_ALLOWED]) {
      expect(resolveLocale({ preview: null, cookie: AR, nodeEnv }).locale, `cookie=ar under ${nodeEnv}`).toBe(
        DEFAULT_LOCALE,
      );
    }
  });
});

// ===========================================================================
// 5. The gate is on the path requests actually take.
// ===========================================================================

describe('acceptance: T-0050 — activeLocale() goes through the gate', () => {
  it('delegates to resolveActiveLocale rather than deciding the preview itself', () => {
    // A correct resolveActiveLocale beside an activeLocale that still has its
    // own `REGISTERED_LOCALES.includes(preview)` branch would pass every test
    // above and change nothing a user sees. This reads the source of
    // activeLocale() only, comments stripped.
    const source = readFileSync(LOCALE_MODULE, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const body = /export\s+async\s+function\s+activeLocale\b[\s\S]*?\n}\n/.exec(source)?.[0] ?? '';
    expect(body, 'apps/web/lib/locale.ts no longer exports async function activeLocale').not.toBe('');
    expect(body, 'activeLocale() does not call resolveActiveLocale(...)').toMatch(/\bresolveActiveLocale\s*\(/);
    expect(
      body,
      'activeLocale() still decides the preview itself (REGISTERED_LOCALES / PSEUDO_LOCALE) instead of delegating',
    ).not.toMatch(/\b(REGISTERED_LOCALES|PSEUDO_LOCALE|MENU_LOCALES)\b/);
  });
});
