import { CRM_NAV, liveHref } from '../../components/crm/crm-nav';
import { crmLiveNav } from '../feature-flags';
import { bffConfig } from './bff-config';
import { readSessionCookie } from './session-cookie';

/**
 * WHERE A SIGNED-IN BROWSER LANDS (T-0125). SERVER ONLY.
 *
 * ADR-0019 leaves the landing page unruled (D-L172). This is the smallest
 * rule that does not show a signed-in user the sign-in form: the first CRM
 * screen whose flag is on in this process, in nav order, and otherwise the
 * admin console. It decides navigation only, never access: whatever the
 * landing screen reads still goes through the BFF to the API, which resolves
 * the session and the scope on that request.
 */
export async function landingPath(): Promise<string> {
  const live = await crmLiveNav();
  return CRM_NAV.map((item) => liveHref(item, live)).find((href) => href !== null) ?? '/admin';
}

/**
 * Whether the request carries ONE well-formed session cookie. Presence only:
 * a dead cookie still counts, its first API read answers 401, the BFF clears
 * it, and the browser comes back here with none. Nothing is validated here,
 * because only the API can say whether a session is live.
 */
export function carriesSessionCookie(cookieHeader: string | null): boolean {
  return readSessionCookie(cookieHeader, bffConfig().cookie).kind === 'token';
}
