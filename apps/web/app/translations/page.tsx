import Link from 'next/link';
import { BETA_LOCALES, createTranslator, localeLabel } from '@kasuwa/i18n';
import { activeLocale } from '../../lib/locale';

/**
 * Where the language menu's "help improve this translation" link lands (D-P1,
 * answered 2026-10-03: every language ships; one without a named reviewer's
 * sign-off shows Beta with this link).
 *
 * A server component with no client island: three sentences and a list cost
 * no JavaScript. It says what Beta means, names the Beta languages in their
 * own words, and tells the reader what to do about a wrong word.
 *
 * WHAT IT DOES NOT DO, AND WHY. There is no feedback form: nothing receives
 * one, and a form that goes nowhere is worse than a sentence that is honest
 * about the channel. Choosing that channel — a form, an inbox, the reviewer
 * programme itself — is a product decision, raised with the T-0035 report.
 *
 * The list is `BETA_LOCALES`, derived from the review files. A reviewer's
 * sign-off removes a language from it with no edit here.
 */
export default async function TranslationsPage() {
  const { locale } = await activeLocale();
  const t = createTranslator(locale);

  return (
    <div
      data-screen="translations"
      className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-16"
    >
      <h1 className="text-h1 text-text">{t.t('lang.beta.help')}</h1>
      {BETA_LOCALES.length === 0 ? (
        <p className="text-body-lg text-text-2">{t.t('lang.help.none')}</p>
      ) : (
        <>
          <p className="text-body-lg text-text-2">{t.t('lang.help.body')}</p>
          <h2 className="text-h5 text-text">{t.t('lang.help.list')}</h2>
          <ul data-testid="beta-languages" className="flex flex-wrap gap-2">
            {BETA_LOCALES.map((code) => (
              <li
                key={code}
                lang={code}
                className="rounded-full border border-border bg-surface px-3 py-1 text-body-md text-text"
              >
                {localeLabel(code)}
              </li>
            ))}
          </ul>
        </>
      )}
      <Link
        href="/"
        className="flex min-h-touch items-center rounded-md bg-primary px-4 text-body-md font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {t.t('lang.help.back')}
      </Link>
    </div>
  );
}
