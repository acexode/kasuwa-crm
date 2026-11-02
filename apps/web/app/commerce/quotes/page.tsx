import { notFound } from 'next/navigation';
import { bundleMessages, type MessageId } from '@kasuwa/i18n';
import { CommerceScreen } from '../../../components/commerce/commerce-screen';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmLiveNav, crmQuotesEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

const TITLE = 'deal.quotes.title' satisfies MessageId;
const EMPTY = 'deal.quotes.empty' satisfies MessageId;

/** P21/05 quote builder. Real 404 while `crm_quotes` is off. */
export default async function QuotesPage() {
  if (!(await crmQuotesEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  return (
    <CommerceScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([TITLE, EMPTY], live))}
      locales={languageOptions(locale)}
      live={live}
      screen="P21/05"
      titleId={TITLE}
      emptyId={EMPTY}
    />
  );
}
