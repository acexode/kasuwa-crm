import { bundleMessages } from '@kasuwa/i18n';
import { AuditScreen } from '../../../components/admin/audit-screen';
import { ADMIN_AUDIT_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { adminBellLive, adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/E`, `P02/E1`, `P02/E2` — the audit log, its empty state and its export. */
export default async function AuditPage() {
  const { locale } = await activeLocale();
  const [linkedSettings, bell] = await Promise.all([adminLiveNav(), adminBellLive()]);

  return (
    <AuditScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_AUDIT_MESSAGE_IDS, bell ? ['notifications'] : []))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
      bell={bell}
    />
  );
}
