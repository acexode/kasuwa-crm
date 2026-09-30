import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { AdminHomeScreen } from '../../components/admin/home-screen';
import { ADMIN_HOME_MESSAGE_IDS } from '../../components/admin/message-ids';
import { activeLocale } from '../../lib/locale';

/**
 * `P02/A` and `P02/A1` — admin home and the settings menu.
 *
 * A SERVER component that resolves strings and hands a plain bundle to one
 * client island, exactly as `P01/1` does. `createTranslator` closes over every
 * registered catalogue; shipping nine of them to render one console is most of
 * what a user on 256 kbps would be waiting for.
 *
 * The language menu comes from `SUPPORTED_LOCALES` and from nowhere else — the
 * derived list of languages that are finished and attested (D-P1).
 */
export default async function AdminHomePage() {
  const { locale } = await activeLocale();

  return (
    <AdminHomeScreen
      locale={locale}
      messages={bundleMessages(locale, ADMIN_HOME_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
