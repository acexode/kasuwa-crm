import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { withNotificationMessages } from '../../components/notifications/message-ids';
import { SearchScreen } from '../../components/search/search-screen';
import { SEARCH_MESSAGE_IDS } from '../../components/search/screen-message-ids';
import { crmLiveNav, crmSearchEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';
import { nameFromUrl } from '../../lib/search-query';

/**
 * `/search` — P27, the global search screen (T-0087).
 *
 * Behind `crm_search`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 *
 * The search is read from the BROWSER (`lib/search-api.ts`), which the API
 * scopes by session. A `q` in the URL is honoured only as a name: a phone
 * number or an email address is never searched from a URL (R12). The title
 * never carries what was searched.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmSearchEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('search.title') };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await crmSearchEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const query = await searchParams;
  const live = await crmLiveNav();

  return (
    <SearchScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(SEARCH_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
      initialText={nameFromUrl(query.q)}
    />
  );
}
