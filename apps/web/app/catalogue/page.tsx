import { notFound } from 'next/navigation';
import { crmLiveNav, crmProductsEnabled } from '../../lib/feature-flags';
import { activeLocale } from '../../lib/locale';

/**
 * P21 catalogue entry (T-0171). Flag-gated route; full frame parity follows.
 */
export default async function CataloguePage() {
  if (!(await crmProductsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <main
      data-testid="p21-catalogue"
      data-locale={locale}
      data-live={live.join(',')}
    />
  );
}
