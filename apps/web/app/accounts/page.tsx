import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { AccountsScreen } from '../../components/accounts/accounts-screen';
import { ACCOUNTS_MESSAGE_IDS } from '../../components/accounts/message-ids';
import { crmAccountsEnabled, crmCustomFieldsEnabled, crmLiveNav } from '../../lib/feature-flags';
import { withCustomMessages } from '../../components/custom/message-ids';
import { withSearchMessages } from '../../components/search/message-ids';
import { activeLocale, languageOptions } from '../../lib/locale';
import { nameFromUrl } from '../../lib/search-query';

/**
 * `P04/03` — the Accounts list (T-0057), with `P04/05` and `P04/06`, and the
 * create and edit sheet.
 *
 * Behind `crm_accounts`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 * It is its own flag, separate from `crm_records` (Contacts).
 *
 * The list is read from the BROWSER (`lib/accounts-api.ts`), not here: a
 * server-component read cannot show the loading, still-connecting or offline
 * states P04/06 draws, and those are the states a 256 kbps user lives in.
 *
 * A `q` in the URL (P27's "see all", T-0087) is the list's first search, and
 * only ever a name: a phone number or an email address in a URL is dropped.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await crmAccountsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const customFields = await crmCustomFieldsEnabled();

  const initialQ = nameFromUrl((await searchParams).q);

  return (
    // A render that carries a q is a "see all" (the screen drops q from the
    // address bar at once, so a refresh never carries it): a fresh key makes it
    // a fresh screen searching that q, even from this same screen's palette and
    // even for the same q twice. Without a q, the key is stable.
    <AccountsScreen
      key={initialQ === '' ? 'list' : `q:${crypto.randomUUID()}`}
      locale={locale}
      messages={bundleMessages(locale, withSearchMessages(withCustomMessages(ACCOUNTS_MESSAGE_IDS, customFields), live))}
      locales={languageOptions(locale)}
      live={live}
      customFields={customFields}
      initialQ={initialQ}
    />
  );
}
