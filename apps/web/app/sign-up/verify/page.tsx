import { notFound } from 'next/navigation';
import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { VerifyScreen } from '../../../components/onboarding/verify-screen';
import { VERIFY_MESSAGE_IDS } from '../../../components/onboarding/message-ids';
import { selfServeSignupEnabled } from '../../../lib/feature-flags';
import { activeLocale } from '../../../lib/locale';

/**
 * `P01/4` — email and phone verification. Behind `self_serve_signup`; 404
 * while it is off.
 *
 * The verification id and the masked hints arrive in the URL from `P01/3`,
 * exactly as the server returned them. The id is a bearer of nothing on its
 * own — a shared link gets someone a form and five guesses at a code that went
 * to somebody else's phone.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await selfServeSignupEnabled())) {
    notFound();
  }

  const search = await searchParams;
  const { locale } = await activeLocale();
  const text = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

  return (
    <VerifyScreen
      locale={locale}
      messages={bundleMessages(locale, VERIFY_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
      verificationId={text(search.verification) ?? ''}
      emailHint={text(search.email)}
      phoneHint={text(search.phone)}
      initialResendAt={text(search.resendAt)}
    />
  );
}
