import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { QuotesScreen } from '../../components/commerce/quotes-screen';
import { COMMERCE_MESSAGE_IDS } from '../../components/commerce/message-ids';
import { withShellMessages } from '../../components/crm/shell-messages';
import { crmLiveNav, crmQuotesEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/** P21 quotes list (T-0171), behind `crm_quotes`. */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmQuotesEnabled())) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('commerce.quotes.title') };
}

export default async function QuotesPage() {
  if (!(await crmQuotesEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <QuotesScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([...COMMERCE_MESSAGE_IDS], live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
