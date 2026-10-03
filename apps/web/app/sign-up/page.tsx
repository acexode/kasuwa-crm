import { notFound } from 'next/navigation';
import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { SignUpScreen } from '../../components/onboarding/sign-up-screen';
import { SIGN_UP_MESSAGE_IDS } from '../../components/onboarding/message-ids';
import { selfServeSignupEnabled } from '../../lib/feature-flags';
import { activeLocale } from '../../lib/locale';

/**
 * `P01/3` — sign up. Behind `self_serve_signup` (D-P2), default OFF.
 *
 * The flag gates the ROUTE: with it off this is a real HTTP 404 before any of
 * the screen is rendered or shipped, not a client-side redirect after a 200.
 * Not found, never forbidden (CLAUDE.md 6.4) — a hidden feature does not
 * announce itself.
 */
export default async function SignUpPage() {
  if (!(await selfServeSignupEnabled())) {
    notFound();
  }

  const { locale } = await activeLocale();

  return (
    <SignUpScreen
      locale={locale}
      messages={bundleMessages(locale, SIGN_UP_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
