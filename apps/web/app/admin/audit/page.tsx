import { bundleMessages } from '@kasuwa/i18n';
import { AuditScreen } from '../../../components/admin/audit-screen';
import { ADMIN_AUDIT_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/E`, `P02/E1`, `P02/E2` — the audit log, its empty state and its export. */
export default async function AuditPage() {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();

  return (
    <AuditScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_AUDIT_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
    />
  );
}
