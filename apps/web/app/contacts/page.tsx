import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { ContactsScreen } from '../../components/contacts/contacts-screen';
import { CONTACTS_MESSAGE_IDS } from '../../components/contacts/message-ids';
import { crmRecordsEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `P04/02` — the Contacts list (T-0042), with `P04/05` and `P04/06`.
 *
 * Behind `crm_records`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 *
 * The list is read from the BROWSER (`lib/records-api.ts`), not here: a
 * server-component read cannot show the loading, still-connecting or offline
 * states P04/06 draws, and those are the states a 256 kbps user lives in.
 */
export default async function ContactsPage() {
  if (!(await crmRecordsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();

  return (
    <ContactsScreen
      locale={locale}
      messages={bundleMessages(locale, CONTACTS_MESSAGE_IDS)}
      locales={languageOptions(locale)}
    />
  );
}
