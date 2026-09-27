import Link from 'next/link';
import { createTranslator } from '@kasuwa/i18n';

/**
 * App Router 404.
 *
 * Present for two reasons. The obvious one: an app without it gets the
 * framework default, which is unstyled and untranslated, and every 404 in
 * Kasuwa will be seen by someone who followed a stale link to a record they can
 * no longer reach — a routine event in a system where scope changes when a
 * programme membership does.
 *
 *
 * Note the wording: it does not distinguish "does not exist" from "you cannot
 * see it". That is deliberate and matches the API, where an out-of-scope record
 * is 404 and never 403 (CLAUDE.md section 6).
 */
export default function NotFound() {
  const t = createTranslator('en-NG');
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-h1 text-text">{t.t('notFound.title')}</h1>
      <p className="text-body-lg text-text-2">{t.t('notFound.body')}</p>
      <Link
        href="/"
        className="min-h-touch rounded-md bg-primary px-4 py-2 text-body-md text-on-primary hover:bg-primary-hover focus-visible:ring-2"
      >
        {t.t('notFound.back')}
      </Link>
    </div>
  );
}
