import { bundleMessages } from '@kasuwa/i18n';
import { AdminHomeScreen } from '../../components/admin/home-screen';
import { ADMIN_HOME_MESSAGE_IDS } from '../../components/admin/message-ids';
import { adminLiveNav } from '../../components/admin/live-nav';
import { withNotificationMessages } from '../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `P02/A` and `P02/A1` — admin home and the settings menu.
 *
 * A SERVER component that resolves strings and hands a plain bundle to one
 * client island, exactly as `P01/1` does. `createTranslator` closes over every
 * registered catalogue; shipping nine of them to render one console is most of
 * what a user on 256 kbps would be waiting for.
 *
 * The language menu comes from `languageOptions()` and from nowhere else: the
 * attested `SUPPORTED_LOCALES` plus the complete-but-unreviewed Beta languages
 * (D-P1), both derived from the catalogues.
 */
export default async function AdminHomePage() {
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();

  return (
    <AdminHomeScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_HOME_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
    />
  );
}
