import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { PipelineScreen } from '../../../components/pipeline/pipeline-screen';
import { PIPELINE_MESSAGE_IDS } from '../../../components/pipeline/message-ids';
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
 * `P06/01` — the pipeline board — and `P06/01b` — its list view (T-0109), one
 * route with a view switch (R1).
 *
 * Behind `crm_pipeline`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404. A non-uuid id names nothing, so it is
 * the app's own 404 with no round trip and nothing read (R16). The board is
 * read from the BROWSER, and the API alone decides whether the caller reaches
 * it: one in another programme and one that does not exist are the same 404,
 * drawn as the one in-page not-found.
 *
 * The cards' contact and account summaries link only where those records'
 * routes answer in this process, so no link on the board is a 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The document title, in the reader's language. Never a pipeline's or a deal's name (D-L63). */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmPipelineEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('pipeline.documentTitle') };
}

export default async function PipelineBoardPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  if (!(await crmPipelineEnabled())) {
    notFound();
  }
  const { pipelineId } = await params;
  if (!UUID.test(pipelineId)) {
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
    <PipelineScreen
      key={pipelineId}
      pipelineId={pipelineId}
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(withCustomMessages(PIPELINE_MESSAGE_IDS, customFields, 'list'), live))}
      locales={languageOptions(locale)}
      live={live}
      links={{ contacts: recordView && records, accounts: recordView && accounts }}
      customFields={customFields}
    />
  );
}
