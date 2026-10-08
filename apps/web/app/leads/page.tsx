import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { LeadsScreen } from '../../components/leads/leads-screen';
import { LEADS_MESSAGE_IDS } from '../../components/leads/message-ids';
import { crmLeadsEnabled, crmLiveNav } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

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
 */
export default async function LeadsPage() {
  if (!(await crmLeadsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();

  return (
    <LeadsScreen
      locale={locale}
      messages={bundleMessages(locale, LEADS_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      live={await crmLiveNav()}
    />
  );
}
