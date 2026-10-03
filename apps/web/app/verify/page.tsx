import { bundleMessages } from '@kasuwa/i18n';
import { MfaScreen } from '../../components/auth/mfa-screen';
import { MFA_MESSAGE_IDS } from '../../components/auth/message-ids';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `P01/2`, `P01/2a`, `P01/2b` — the second factor.
 *
 * The challenge id arrives in the URL. It is a bearer of nothing on its own:
 * the contract is explicit that a successful first factor returns a
 * `challengeId` and no session, so a challenge id in a shared link gets an
 * attacker a form and a `401`. Scope still comes from the server, always.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {

  const search = await searchParams;
  const { locale } = await activeLocale();

  const challenge = typeof search.challenge === 'string' ? search.challenge : '';
  const method = search.method === 'sms' ? 'sms' : 'totp';
  const hint = typeof search.hint === 'string' ? search.hint : null;
  const resendAt = typeof search.resendAt === 'string' ? search.resendAt : null;

  return (
    <MfaScreen
      locale={locale}
      messages={bundleMessages(locale, MFA_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      challengeId={challenge}
      initialMethod={method}
      initialHint={hint}
      initialResendAvailableAt={resendAt}
    />
  );
}
