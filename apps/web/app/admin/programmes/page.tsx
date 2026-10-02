import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { ProgrammesScreen } from '../../../components/admin/programmes-screen';
import { ADMIN_PROGRAMMES_MESSAGE_IDS } from '../../../components/admin/message-ids';
import { activeLocale } from '../../../lib/locale';

/** `P02/B` — the programmes list — and `P02/B1`, its first-run empty state. */
export default async function ProgrammesPage() {
  const { locale } = await activeLocale();

  return (
    <ProgrammesScreen
      locale={locale}
      messages={bundleMessages(locale, ADMIN_PROGRAMMES_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
