import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { AccountRecordScreen } from '../../../components/account-record/account-record-screen';
import { ACCOUNT_RECORD_MESSAGE_IDS } from '../../../components/account-record/message-ids';
import { crmAccountsEnabled, crmCustomFieldsEnabled, crmLiveNav, crmRecordViewEnabled } from '../../../lib/feature-flags';
import { withCustomMessages } from '../../../components/custom/message-ids';
import { withSearchMessages } from '../../../components/search/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P05/04` — the account record (T-0063), with `P05/05` and `P05/06`.
 *
 * Behind `crm_record_view` (the P05 record flag) AND `crm_accounts` (the
 * accounts flag), both DEFAULT OFF and read on the server: a gated ROUTE, so
 * with either off this is a real 404 and nothing of the screen ships. The
 * record sits in the CRM shell, and the shell's Accounts link must resolve
 * wherever the record does. No header, cookie or query string can switch
 * either on (`lib/feature-flags.ts`).
 *
 * The record is read from the BROWSER, not here: a server-component read
 * cannot show the loading, still-connecting or offline states P05/06 draws,
 * and the API alone decides whether an id is in scope.
 *
 * An id that is not a uuid cannot name an account, so it is the app's own 404
 * without a round trip — `map` included, which is a real API path (the Map,
 * a 501) and must never be turned into a call. It is the same generic page an
 * out-of-scope id gets.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AccountRecordPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await crmRecordViewEnabled()) || !(await crmAccountsEnabled())) {
    notFound();
  }
  const { id } = await params;
  if (!UUID.test(id)) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const customFields = await crmCustomFieldsEnabled();

  return (
    // Keyed by id: following a breadcrumb to another account starts a fresh
    // record, with nothing of the last one's state carried over.
    <AccountRecordScreen
      key={id}
      id={id}
      locale={locale}
      messages={bundleMessages(locale, withSearchMessages(withCustomMessages(ACCOUNT_RECORD_MESSAGE_IDS, customFields), live))}
      locales={languageOptions(locale)}
      live={live}
      customFields={customFields}
    />
  );
}
