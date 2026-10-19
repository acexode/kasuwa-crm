import { crmCustomFieldsEnabled, crmNotificationsEnabled } from '../../lib/feature-flags';

/**
 * The admin settings-menu entries whose ROUTE is on in this process, as
 * `settingId` to `href`. Each admin page reads it on the server and hands it to
 * the shell, which draws an entry as a link only if it is listed here — the same
 * idea as `crmLiveNav()` for the CRM shell. An entry whose screen is off stays a
 * non-link, like an unbuilt one, so no menu entry leads to a 404.
 *
 * SERVER ONLY, and no `'use client'` here ever: the href lives on the server so
 * that the shell's chunk, which every admin route loads on a 256 kbps link,
 * carries no table of flag-gated routes, and no client module names a flag.
 */
export async function adminLiveNav(): Promise<Readonly<Record<string, string>>> {
  const [fields, bell] = await Promise.all([crmCustomFieldsEnabled(), crmNotificationsEnabled()]);
  return {
    ...(fields ? { 'cu-fields': '/admin/custom-fields' } : {}),
    // Not a settings entry: the shell's bell (T-0101). Its centre link leaves the console for the CRM shell.
    ...(bell ? { notifications: '/notifications' } : {}),
  };
}
