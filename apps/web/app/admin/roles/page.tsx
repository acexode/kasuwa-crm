import { bundleMessages } from '@kasuwa/i18n';
import { RolesScreen } from '../../../components/admin/roles-screen';
import { ADMIN_ROLES_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/C`–`P02/C3` — the role hierarchy, its moves and its delete dialog. */
export default async function RolesPage() {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();

  return (
    <RolesScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_ROLES_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
    />
  );
}
