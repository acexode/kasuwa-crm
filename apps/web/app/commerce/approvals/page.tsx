import { notFound } from 'next/navigation';
import { crmLiveNav, quoteApprovalsEnabled } from '../../../lib/feature-flags';
import { activeLocale } from '../../../lib/locale';

/**
 * P21 approvals entry (T-0171). Real 404 while `quote_approvals` is off.
 * Catalogue and quotes already live at `/catalogue` and `/quotes`.
 */
export default async function ApprovalsPage() {
  if (!(await quoteApprovalsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <main
      data-testid="p21-approvals"
      data-locale={locale}
      data-live={live.join(',')}
    />
  );
}
