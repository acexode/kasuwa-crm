import { notFound } from 'next/navigation';
import { crmLiveNav, crmQuotesEnabled } from '../../lib/feature-flags';
import { activeLocale } from '../../lib/locale';

/**
 * P21 quotes entry (T-0171). Flag-gated route; builder frames follow.
 */
export default async function QuotesPage() {
  if (!(await crmQuotesEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <main
      data-testid="p21-quotes"
      data-locale={locale}
      data-live={live.join(',')}
    />
  );
}
