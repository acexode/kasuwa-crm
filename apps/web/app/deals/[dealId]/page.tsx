import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { DealScreen } from '../../../components/deal/deal-screen';
import { DEAL_MESSAGE_IDS } from '../../../components/deal/message-ids';
import {
  crmAccountsEnabled,
  crmCustomFieldsEnabled,
  crmLiveNav,
  crmPipelineEnabled,
  crmRecordViewEnabled,
  crmRecordsEnabled,
} from '../../../lib/feature-flags';
import { withCustomMessages } from '../../../components/custom/message-ids';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P06/05` — the deal detail — and `P06/06` — the same at 360 px (T-0110).
 *
 * Behind `crm_pipeline`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. An id
 * that is not a uuid names no deal, so it is the app's own 404 with no round
 * trip and nothing read (`move` included, a real API path) (R1).
 *
 * The deal is read from the BROWSER, never here: the API alone decides
 * whether the caller reaches it, so a deal in another programme and one that
 * does not exist are the same 404, drawn as the generic not-found (D-L69).
 *
 * The contact and account summaries link only where those records' routes
 * answer in this process, so no link on the deal is a 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The document title, in the reader's language. Never the deal's name: it lands in history on shared desks (D-L63, D-L91). */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmPipelineEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('deal.documentTitle') };
}

export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  if (!(await crmPipelineEnabled())) {
    notFound();
  }
  const { dealId } = await params;
  if (!UUID.test(dealId)) {
    notFound();
  }
  const [{ locale }, live, records, accounts, recordView] = await Promise.all([
    activeLocale(),
    crmLiveNav(),
    crmRecordsEnabled(),
    crmAccountsEnabled(),
    crmRecordViewEnabled(),
  ]);
  const customFields = await crmCustomFieldsEnabled();

  return (
    // Keyed by id: following a link to another deal starts a fresh screen, with nothing of the last one carried over.
    <DealScreen
      key={dealId}
      dealId={dealId}
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(withCustomMessages(DEAL_MESSAGE_IDS, customFields), live))}
      locales={languageOptions(locale)}
      live={live}
      links={{ contacts: recordView && records, accounts: recordView && accounts }}
      customFields={customFields}
    />
  );
}
