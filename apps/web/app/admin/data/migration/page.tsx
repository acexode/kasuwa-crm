import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { MigrationPlaceholder } from '../../../../components/data/placeholders';
import { DATA_PLACEHOLDER_MESSAGE_IDS, withDataShell } from '../../../../components/data/message-ids';
import { dataPage } from '../../../../lib/data-management';
import { activeLocale, languageOptions } from '../../../../lib/locale';

/**
 * `/admin/data/migration` — a P28 section with no backend yet, drawn in the
 * design's empty or disabled state behind its own flag (T-0141, D-L194);
 * otherwise a real 404.
 */
export default async function Page() {
  const page = await dataPage();
  if (!page.sections.migration) notFound();
  const { locale } = await activeLocale();
  return (
    <MigrationPlaceholder
      locale={locale}
      messages={bundleMessages(locale, withDataShell(DATA_PLACEHOLDER_MESSAGE_IDS, page.bell))}
      locales={languageOptions(locale)}
      bell={page.bell}
      sections={page.sections}
    />
  );
}
