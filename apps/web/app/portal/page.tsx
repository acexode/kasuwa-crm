import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ClientPortalScreen } from '../../components/client-portal/portal-screen';
import { CLIENT_PORTAL_MESSAGE_IDS } from '../../components/client-portal/message-ids';
import { clientPortalEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/** P23 BPO client portal (T-0184), behind `client_portal`. */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await clientPortalEnabled())) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('clientPortal.title') };
}

export default async function PortalPage() {
  if (!(await clientPortalEnabled())) notFound();
  const { locale } = await activeLocale();

  return (
    <ClientPortalScreen
      locale={locale}
      messages={bundleMessages(locale, CLIENT_PORTAL_MESSAGE_IDS)}
      locales={languageOptions(locale)}
    />
  );
}
