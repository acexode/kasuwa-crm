import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { DuplicatesScreen } from '../../../components/duplicates/duplicates-screen';
import { DUPLICATES_MESSAGE_IDS } from '../../../components/duplicates/message-ids';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmDuplicatesEnabled, crmLiveNav, crmRecordsEnabled, dataManagement } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `/contacts/duplicates` — P28, the duplicate sets, the side-by-side merge and
 * the merges history (T-0097).
 *
 * Behind `crm_duplicates`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 * It sits in the CRM shell, whose Contacts link (and the merge result's link to
 * the kept contact) must resolve wherever this is served, so it needs
 * `crm_records` too.
 *
 * Everything the screen reads and writes goes from the BROWSER
 * (`lib/duplicates-api.ts`), which the API scopes by session: the loading and
 * failed states are the user's to see. The title never carries a name.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmDuplicatesEnabled()) || !(await crmRecordsEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('duplicates.title') };
}

export default async function DuplicatesPage() {
  if (!(await crmDuplicatesEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  // T-0141: with the Data management area on, duplicates live there; this path keeps working by sending people on.
  if ((await dataManagement()).area) redirect('/admin/data/duplicates');
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <DuplicatesScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(DUPLICATES_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      frame={{ kind: 'crm', live }}
    />
  );
}
