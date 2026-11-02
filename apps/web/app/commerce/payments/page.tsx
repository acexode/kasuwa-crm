import { notFound } from 'next/navigation';
import { bundleMessages, type MessageId } from '@kasuwa/i18n';
import { CommerceScreen } from '../../../components/commerce/commerce-screen';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmLiveNav, paymentLinksEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

const TITLE = 'record.timeline.filter.payments' satisfies MessageId;
const EMPTY = 'notifications.prefs.event.payment' satisfies MessageId;

/** P21/22 payment status. Real 404 while `payment_links` is off. Refunds are not this screen. */
export default async function PaymentsPage() {
  if (!(await paymentLinksEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  return (
    <CommerceScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([TITLE, EMPTY], live))}
      locales={languageOptions(locale)}
      live={live}
      screen="P21/22"
      titleId={TITLE}
      emptyId={EMPTY}
    />
  );
}
