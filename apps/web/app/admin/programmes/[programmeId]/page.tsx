import { bundleMessages } from '@kasuwa/i18n';
import { ProgrammeScreen } from '../../../../components/admin/programme-screen';
import {
  isProgrammeTab,
  type ProgrammeTab,
} from '../../../../components/admin/programme-tabs';
import { ADMIN_PROGRAMME_MESSAGE_IDS } from '../../../../components/admin/message-ids';
import { activeLocale, languageOptions } from '../../../../lib/locale';
import { adminLiveApiEnabled } from '../../../../lib/feature-flags';
import { adminLiveNav } from '../../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../../components/notifications/message-ids';

/**
 * `P02/B2`–`P02/B5` — one programme and its tabs.
 *
 * The tab is a query parameter rather than component state, so a link to the
 * SLA tab is a link a person can send to a colleague and the back button does
 * what it looks like it does. An unknown value falls back to the overview
 * rather than erroring: a mistyped query string is not a missing record.
 *
 * `admin_live_api` (T-0035) is read HERE, on the server, and handed down as a
 * boolean. With it on, KPIs and skill cover — the two reads the API cannot
 * answer yet — render labelled sample data from `lib/admin-sample.ts`; every
 * other read on the screen is the same request either way.
 */
export default async function ProgrammePage({
  params,
  searchParams,
}: {
  params: Promise<{ programmeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();
  const { programmeId } = await params;
  const query = await searchParams;

  const requested = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: ProgrammeTab = isProgrammeTab(requested) ? requested : 'overview';
  const live = await adminLiveApiEnabled();

  return (
    <ProgrammeScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_PROGRAMME_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
      programmeId={programmeId}
      tab={tab}
      live={live}
    />
  );
}
