import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ImportScreen } from '../../../components/import/import-screen';
import { IMPORT_MESSAGE_IDS } from '../../../components/import/message-ids';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmImportEnabled, crmLiveNav, crmRecordsEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `/contacts/import` — P28, the CSV import wizard and its history (T-0096).
 *
 * Behind `crm_import`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 * It sits in the CRM shell, whose Contacts link (and the report's link back to
 * the imported contacts) must resolve wherever this is served, so it needs
 * `crm_records` too.
 *
 * Everything the screen reads and writes goes from the BROWSER
 * (`lib/imports-api.ts`), which the API scopes by session. The title never
 * carries a filename.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmImportEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('import.wizard.title') };
}

export default async function ImportPage() {
  if (!(await crmImportEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <ImportScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(IMPORT_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
