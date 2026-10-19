import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { PipelineIndexScreen } from '../../components/pipeline/pipeline-index-screen';
import { PIPELINE_INDEX_MESSAGE_IDS } from '../../components/pipeline/message-ids';
import { crmLiveNav, crmPipelineEnabled } from '../../lib/feature-flags';
import { withShellMessages } from '../../components/crm/shell-messages';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `/pipelines` (T-0109, R1): the caller's pipelines, each linking its board —
 * the CRM nav's Deals target.
 *
 * Behind `crm_pipeline`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 * The pipelines are read from the BROWSER, which the API scopes by session.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmPipelineEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('pipeline.documentTitle') };
}

export default async function PipelinesPage() {
  if (!(await crmPipelineEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <PipelineIndexScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(PIPELINE_INDEX_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
