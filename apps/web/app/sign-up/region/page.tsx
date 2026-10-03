import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { RegionScreen } from '../../../components/onboarding/region-screen';
import { REGION_MESSAGE_IDS } from '../../../components/onboarding/message-ids';
import { selfServeSignupEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P01/5.1` — data region. Behind `self_serve_signup`; 404 while it is off.
 *
 * A sales-provisioned tenant never sees this: its region is chosen at
 * provisioning (T-0015), which is why the step lives under `/sign-up` and the
 * rest of the wizard does not.
 */
export default async function RegionPage() {
  if (!(await selfServeSignupEnabled())) {
    notFound();
  }

  const { locale } = await activeLocale();

  return (
    <RegionScreen
      locale={locale}
      messages={bundleMessages(locale, REGION_MESSAGE_IDS)}
      locales={languageOptions(locale)}
    />
  );
}
