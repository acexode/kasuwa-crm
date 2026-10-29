import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { CatalogueScreen } from '../../components/commerce/catalogue-screen';
import { COMMERCE_MESSAGE_IDS } from '../../components/commerce/message-ids';
import { withShellMessages } from '../../components/crm/shell-messages';
import { crmLiveNav, crmProductsEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/** P21 product catalogue (T-0171), behind `crm_products`. */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmProductsEnabled())) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('commerce.catalogue.title') };
}

export default async function CataloguePage() {
  if (!(await crmProductsEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <CatalogueScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([...COMMERCE_MESSAGE_IDS], live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
