import { bundleMessages } from '@kasuwa/i18n';
import { FieldSecurityScreen } from '../../../components/admin/field-security-screen';
import { ADMIN_FLS_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/D`, `P02/D1`, `P02/D2` — the field-level security matrix. */
export default async function FieldSecurityPage() {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();

  return (
    <FieldSecurityScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_FLS_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
    />
  );
}
