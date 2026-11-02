import { notFound } from 'next/navigation';
import { bundleMessages, type MessageId } from '@kasuwa/i18n';
import { CommerceScreen } from '../../../components/commerce/commerce-screen';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmLiveNav, quoteApprovalsEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

const TITLE = 'deal.approvals.title' satisfies MessageId;
const EMPTY = 'deal.approvals.empty' satisfies MessageId;

/** P21/06 approvals. Real 404 while `quote_approvals` is off. */
export default async function ApprovalsPage() {
  if (!(await quoteApprovalsEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  return (
    <CommerceScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([TITLE, EMPTY], live))}
      locales={languageOptions(locale)}
      live={live}
      screen="P21/06"
      titleId={TITLE}
      emptyId={EMPTY}
    />
  );
}
