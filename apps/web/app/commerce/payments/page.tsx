import { notFound } from 'next/navigation';
import { crmLiveNav, paymentLinksEnabled } from '../../../lib/feature-flags';
import { activeLocale } from '../../../lib/locale';

/**
 * P21 payment status (T-0171). Real 404 while `payment_links` is off.
 * Refund frames are not this route.
 */
export default async function PaymentsPage() {
  if (!(await paymentLinksEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <main
      data-testid="p21-payments"
      data-locale={locale}
      data-live={live.join(',')}
    />
  );
}
