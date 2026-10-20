import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { DuplicatesScreen } from '../../../../components/duplicates/duplicates-screen';
import { DUPLICATES_MESSAGE_IDS } from '../../../../components/duplicates/message-ids';
import { withDataShell } from '../../../../components/data/message-ids';
import { dataPage } from '../../../../lib/data-management';
import { activeLocale, languageOptions } from '../../../../lib/locale';

/**
 * `/admin/data/duplicates` — P28 C and C1 in the Data management area
 * (T-0141). Needs `data_management` and the duplicates screen's own flags
 * (`crm_duplicates`, `crm_records`); otherwise a real 404. The title never
 * carries a name.
 */
export async function generateMetadata(): Promise<Metadata> {
  const page = await dataPage();
  if (!page.sections.duplicates) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('duplicates.title') };
}

export default async function DataDuplicatesPage() {
  const page = await dataPage();
  if (!page.sections.duplicates) notFound();
  const { locale } = await activeLocale();
  return (
    <DuplicatesScreen
      locale={locale}
      messages={bundleMessages(locale, withDataShell(DUPLICATES_MESSAGE_IDS, page.bell))}
      locales={languageOptions(locale)}
      frame={{ kind: 'data', bell: page.bell, sections: page.sections, threeWay: page.flags.threeWay }}
    />
  );
}
