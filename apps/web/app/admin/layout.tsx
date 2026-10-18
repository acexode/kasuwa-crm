import type { ReactNode } from 'react';
import { AdminNavLinksProvider } from '../../components/admin/admin-nav-links';
import { crmCustomFieldsEnabled } from '../../lib/feature-flags';

/**
 * The admin console's frame, server side: which flag-gated settings-menu entries
 * are links in this process. An entry whose screen is off stays a non-link, like
 * an unbuilt one, so no menu entry on any admin screen leads to a 404.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const studio = await crmCustomFieldsEnabled();
  return <AdminNavLinksProvider settingIds={studio ? ['cu-fields'] : []}>{children}</AdminNavLinksProvider>;
}
