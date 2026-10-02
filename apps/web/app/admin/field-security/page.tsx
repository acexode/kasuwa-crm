import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { FieldSecurityScreen } from '../../../components/admin/field-security-screen';
import { ADMIN_FLS_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { activeLocale } from '../../../lib/locale';

/** `P02/D`, `P02/D1`, `P02/D2` — the field-level security matrix. */
export default async function FieldSecurityPage() {
  const { locale } = await activeLocale();

  return (
    <FieldSecurityScreen
      locale={locale}
      messages={bundleMessages(locale, ADMIN_FLS_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
