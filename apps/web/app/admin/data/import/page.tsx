import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ImportScreen } from '../../../../components/import/import-screen';
import { IMPORT_MESSAGE_IDS } from '../../../../components/import/message-ids';
import { withDataShell } from '../../../../components/data/message-ids';
import { dataPage } from '../../../../lib/data-management';
import { activeLocale, languageOptions } from '../../../../lib/locale';

/**
 * `/admin/data/import` — P28 A–A6 in the Data management area (T-0141): the
 * five-step wizard with the design's Review step. Needs `data_management` and
 * the import screen's own flags (`crm_import`, `crm_records`); otherwise a real
 * 404. Everything the screen reads and writes goes from the BROWSER, scoped by
 * the session, exactly as at `/contacts/import`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const page = await dataPage();
  if (!page.sections.import) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('import.wizard.title') };
}

export default async function DataImportPage() {
  const page = await dataPage();
  if (!page.sections.import) notFound();
  const { locale } = await activeLocale();
  return (
    <ImportScreen
      locale={locale}
      messages={bundleMessages(locale, withDataShell(IMPORT_MESSAGE_IDS, page.bell))}
      locales={languageOptions(locale)}
      frame={{ kind: 'data', bell: page.bell, sections: page.sections }}
    />
  );
}
