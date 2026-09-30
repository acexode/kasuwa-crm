import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { ProgrammeScreen } from '../../../../components/admin/programme-screen';
import {
  isProgrammeTab,
  type ProgrammeTab,
} from '../../../../components/admin/programme-tabs';
import { ADMIN_PROGRAMME_MESSAGE_IDS } from '../../../../components/admin/message-ids';
import { activeLocale } from '../../../../lib/locale';

/**
 * `P02/B2`–`P02/B5` — one programme and its tabs.
 *
 * The tab is a query parameter rather than component state, so a link to the
 * SLA tab is a link a person can send to a colleague and the back button does
 * what it looks like it does. An unknown value falls back to the overview
 * rather than erroring: a mistyped query string is not a missing record.
 */
export default async function ProgrammePage({
  params,
  searchParams,
}: {
  params: Promise<{ programmeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await activeLocale();
  const { programmeId } = await params;
  const query = await searchParams;

  const requested = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: ProgrammeTab = isProgrammeTab(requested) ? requested : 'overview';

  return (
    <ProgrammeScreen
      locale={locale}
      messages={bundleMessages(locale, ADMIN_PROGRAMME_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
      programmeId={programmeId}
      tab={tab}
    />
  );
}
