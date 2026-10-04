import { bundleMessages } from '@kasuwa/i18n';
import { RolesScreen } from '../../../components/admin/roles-screen';
import { ADMIN_ROLES_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/** `P02/C`–`P02/C3` — the role hierarchy, its moves and its delete dialog. */
export default async function RolesPage() {
  const { locale } = await activeLocale();

  return (
    <RolesScreen
      locale={locale}
      messages={bundleMessages(locale, ADMIN_ROLES_MESSAGE_IDS)}
      locales={languageOptions(locale)}
    />
  );
}
