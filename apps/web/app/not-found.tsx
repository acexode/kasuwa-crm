import Link from 'next/link';
import { createTranslator } from '@kasuwa/i18n';
import { activeLocale } from '../lib/locale';

/**
 * App Router 404.
 *
 * Present for two reasons. The obvious one: an app without it gets the
 * framework default, which is unstyled and untranslated, and every 404 in
 * Kasuwa will be seen by someone who followed a stale link to a record they can
 * no longer reach — a routine event in a system where scope changes when a
 * programme membership does.
 *
 * Note the wording: it does not distinguish "does not exist" from "you cannot
 * see it". That is deliberate and matches the API, where an out-of-scope record
 * is 404 and never 403 (CLAUDE.md section 6).
 */
export default async function NotFound() {
  const { locale } = await activeLocale();
  const t = createTranslator(locale);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-16">
      <h1 className="text-h1 text-text">{t.t('notFound.title')}</h1>
      <p className="text-body-lg text-text-2">{t.t('notFound.body')}</p>
      <Link
        href="/"
        className="flex min-h-touch items-center rounded-md bg-primary px-4 text-body-md font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {t.t('notFound.back')}
      </Link>
    </div>
  );
}
