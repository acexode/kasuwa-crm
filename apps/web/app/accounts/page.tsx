import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { AccountsScreen } from '../../components/accounts/accounts-screen';
import { ACCOUNTS_MESSAGE_IDS } from '../../components/accounts/message-ids';
import { crmAccountsEnabled, crmLiveNav } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

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
 */
export default async function AccountsPage() {
  if (!(await crmAccountsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();

  return (
    <AccountsScreen
      locale={locale}
      messages={bundleMessages(locale, ACCOUNTS_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      live={await crmLiveNav()}
    />
  );
}
