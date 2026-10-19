import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { LeadsScreen } from '../../components/leads/leads-screen';
import { LEADS_MESSAGE_IDS } from '../../components/leads/message-ids';
import { crmCustomFieldsEnabled, crmLeadsEnabled, crmLiveNav } from '../../lib/feature-flags';
import { withCustomMessages } from '../../components/custom/message-ids';
import { withShellMessages } from '../../components/crm/shell-messages';
import { activeLocale, languageOptions } from '../../lib/locale';
import { nameFromUrl } from '../../lib/search-query';

/**
 * `P04/01` — the Leads table — and `P04/04` — the Kanban by status (T-0058),
 * with `P04/05` and `P04/06`, and convert.
 *
 * Behind `crm_leads`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 * It is its own flag, separate from `crm_records` and `crm_accounts`.
 *
 * The leads are read from the BROWSER (`lib/leads-api.ts`), not here: a
 * server-component read cannot show the loading, still-connecting or offline
 * states P04/06 draws, and those are the states a 256 kbps user lives in.
 *
 * A `q` in the URL (P27's "see all", T-0087) is the list's first search, and
 * only ever a name: a phone number or an email address in a URL is dropped.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await crmLeadsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const customFields = await crmCustomFieldsEnabled();

  const initialQ = nameFromUrl((await searchParams).q);

  return (
    // A render that carries a q is a "see all" (the screen drops q from the
    // address bar at once, so a refresh never carries it): a fresh key makes it
    // a fresh screen searching that q, even from this same screen's palette and
    // even for the same q twice. Without a q, the key is stable.
    <LeadsScreen
      key={initialQ === '' ? 'list' : `q:${crypto.randomUUID()}`}
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(withCustomMessages(LEADS_MESSAGE_IDS, customFields, 'list'), live))}
      locales={languageOptions(locale)}
      live={live}
      initialQ={initialQ}
      customFields={customFields}
    />
  );
}
