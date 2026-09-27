import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { SsoScreen } from '../../components/auth/sso-screen';
import { SSO_MESSAGE_IDS } from '../../components/auth/message-ids';
import { activeLocale } from '../../lib/locale';

/** `P01/1c` — single sign-on by email domain, and its not-found state. */
export default async function SsoPage() {

  const { locale } = await activeLocale();

  return (
    <SsoScreen
      locale={locale}
      messages={bundleMessages(locale, SSO_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
