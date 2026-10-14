'use client';

import { useEffect } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { dropQueryFromAddressBar } from '../../lib/search-query';
import { SearchPanel } from './search-panel';

/**
 * `P27` — the global search screen (T-0087): the search panel inline, not in
 * a dialog — A1 grouped hits, A2 lookups by a whole number or address, A4
 * searching and A5 no matches. Frames A, A3, B, B1, C and C1 are overruled or
 * not served (D-L133) and are not built.
 *
 * THE ADDRESS BAR NEVER KEEPS A SEARCH (R12). A `q` the page was opened with
 * arrives here as `initialText` only when it is a NAME (`nameFromUrl`, on the
 * server); a crafted `?q=<phone or email>` is never searched, looked up or put
 * in the box. Either way `q` is then removed from the address bar, without a
 * navigation or a new history entry, and nothing typed is ever written back.
 */
export function SearchScreen({
  locale,
  messages,
  locales,
  live,
  initialText,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  initialText: string;
}) {
  const t = createBundleTranslator(locale, messages);

  useEffect(() => {
    dropQueryFromAddressBar();
  }, []);

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="search" live={live}>
      <div data-screen="P27" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2">{t.t('search.title')}</h1>
          <p className="text-body-sm text-text-2">{t.t('search.intro')}</p>
        </div>
        <section className="rounded-lg border border-border bg-surface p-3 sm:p-4">
          <SearchPanel t={t} initialText={initialText} autoFocus dealsLive={live.includes('deals')} />
        </section>
      </div>
    </CrmShell>
  );
}
