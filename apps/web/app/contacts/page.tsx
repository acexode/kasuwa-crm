import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { ContactsScreen } from '../../components/contacts/contacts-screen';
import { CONTACTS_DUPLICATES_MESSAGE_IDS, CONTACTS_IMPORT_MESSAGE_IDS, CONTACTS_MESSAGE_IDS } from '../../components/contacts/message-ids';
import { crmCustomFieldsEnabled, crmLiveNav, crmRecordsEnabled } from '../../lib/feature-flags';
import { withCustomMessages } from '../../components/custom/message-ids';
import { withSearchMessages } from '../../components/search/message-ids';
import { activeLocale, languageOptions } from '../../lib/locale';
import { importIdFromUrl } from '../../lib/import-model';
import { nameFromUrl } from '../../lib/search-query';

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
 *
 * A `q` in the URL (P27's "see all", T-0087) is the list's first search, and
 * only ever a name: a phone number or an email address in a URL is dropped.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await crmRecordsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const customFields = await crmCustomFieldsEnabled();

  const query = await searchParams;
  const initialQ = nameFromUrl(query.q);
  // The report's link (T-0096, I9): honoured only where the import is live, and only as a uuid.
  const importId = live.includes('import') ? importIdFromUrl(query.importId) : undefined;

  return (
    // A render that carries a q is a "see all" (the screen drops q from the
    // address bar at once, so a refresh never carries it): a fresh key makes it
    // a fresh screen searching that q, even from this same screen's palette and
    // even for the same q twice. Without a q, the key is stable.
    <ContactsScreen
      key={initialQ === '' ? (importId === undefined ? 'list' : `import:${importId}`) : `q:${crypto.randomUUID()}`}
      locale={locale}
      messages={bundleMessages(locale, withSearchMessages(withCustomMessages([...(importId === undefined ? CONTACTS_MESSAGE_IDS : [...CONTACTS_MESSAGE_IDS, ...CONTACTS_IMPORT_MESSAGE_IDS]), ...(live.includes('duplicates') ? CONTACTS_DUPLICATES_MESSAGE_IDS : [])], customFields, 'list'), live))}
      locales={languageOptions(locale)}
      live={live}
      initialQ={initialQ}
      customFields={customFields}
      {...(importId === undefined ? {} : { importId })}
    />
  );
}
