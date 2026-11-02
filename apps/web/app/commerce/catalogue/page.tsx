import { notFound } from 'next/navigation';
import { bundleMessages, type MessageId } from '@kasuwa/i18n';
import { CommerceScreen } from '../../../components/commerce/commerce-screen';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmLiveNav, crmProductsEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

const TITLE = 'deal.products.title' satisfies MessageId;
const EMPTY = 'deal.products.empty' satisfies MessageId;

/** P21/01 product catalogue. Real 404 while `crm_products` is off. */
export default async function CataloguePage() {
  if (!(await crmProductsEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  return (
    <CommerceScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([TITLE, EMPTY], live))}
      locales={languageOptions(locale)}
      live={live}
      screen="P21/01"
      titleId={TITLE}
      emptyId={EMPTY}
    />
  );
}
