import { crmCustomFieldsEnabled, crmNotificationsEnabled, studioFlags } from '../../lib/feature-flags';
import { dataPage } from '../../lib/data-management';

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
  const [fields, data, studio] = await Promise.all([crmCustomFieldsEnabled(), dataPage(), studioFlags()]);
  // T-0141: the Data management area's sections, and T-0142: the studio's placeholder sections (D-L194),
  // each a link only where its own screen is on.
  return {
    ...(studio.objects ? { 'cu-obj': '/admin/studio' } : {}),
    ...(fields ? { 'cu-fields': '/admin/custom-fields' } : {}),
    ...(studio.layouts ? { 'cu-layouts': '/admin/studio/layouts' } : {}),
    ...(studio.validation ? { 'cu-val': '/admin/studio/validation-rules' } : {}),
    ...(studio.recordTypes ? { 'cu-rt': '/admin/studio/record-types' } : {}),
    ...(data.sections.import ? { 'd-io': '/admin/data/import' } : {}),
    ...(data.sections.duplicates ? { 'd-dedup': '/admin/data/duplicates' } : {}),
    ...(data.sections.requests ? { 'co-dsr': '/admin/data/requests' } : {}),
  };
}

/**
 * Whether the console's header draws the notifications bell (T-0101): its own
 * answer and its own prop, because it is not a settings-menu entry (D-L179 N10).
 * Server only, like the rest of this file.
 */
export async function adminBellLive(): Promise<boolean> {
  return crmNotificationsEnabled();
}
