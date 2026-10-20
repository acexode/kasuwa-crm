import { bundleMessages, localeLabel } from '@kasuwa/i18n';
import { OnboardingWizard } from '../../components/onboarding/onboarding-wizard';
import { CUSTOMER_LANGUAGE_CODES, ONBOARDING_MESSAGE_IDS } from '../../components/onboarding/message-ids';
import { activeLocale, languageOptions } from '../../lib/locale';
import { productTourShown, selfServeSignupEnabled } from '../../lib/feature-flags';

/**
 * `P01/5.2`–`5.5` and `P01/6` — the first-admin-login flow.
 *
 * DELIBERATELY NOT BEHIND `self_serve_signup` (D-P2 point 4, T-0018). Every
 * tenant needs these steps, including the ones provisioned by hand, and gating
 * them behind the self-serve switch would strand every launch tenant halfway
 * through setup. An e2e test tagged `@self-serve-off` asserts they render with
 * the flag at its default, because "tidying" the flag handling onto this route
 * is the regression T-0018 names as most likely.
 *
 * Step state is client-side until T-0018 gives it a server home; see the note
 * in `onboarding-wizard.tsx`.
 */
export default async function OnboardingPage() {
  const { locale } = await activeLocale();

  return (
    <OnboardingWizard
      locale={locale}
      messages={bundleMessages(locale, ONBOARDING_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      customerLanguages={CUSTOMER_LANGUAGE_CODES.map((code) => ({ code, label: localeLabel(code) }))}
      regionReachable={await selfServeSignupEnabled()}
      tourShown={await productTourShown()}
    />
  );
}
