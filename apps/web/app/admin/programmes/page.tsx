import { bundleMessages } from '@kasuwa/i18n';
import { ProgrammesScreen } from '../../../components/admin/programmes-screen';
import { ADMIN_PROGRAMMES_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { adminBellLive, adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/B` — the programmes list — and `P02/B1`, its first-run empty state. */
export default async function ProgrammesPage() {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();
  const bell = await adminBellLive();

  return (
    <ProgrammesScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_PROGRAMMES_MESSAGE_IDS, bell ? ['notifications'] : []))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
      bell={bell}
    />
  );
}
