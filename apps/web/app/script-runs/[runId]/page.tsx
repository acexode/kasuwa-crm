import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ScriptRunScreen } from '../../../components/script-run/script-run-screen';
import { SCRIPT_RUN_MESSAGE_IDS } from '../../../components/script-run/message-ids';
import { crmLiveNav, crmRecordViewEnabled, crmRecordsEnabled, crmScriptsEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P10/01` to `P10/04` — one script run in manual mode (T-0116), started from
 * the contact record and walked node by node until it is completed.
 *
 * Behind `crm_scripts`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. It
 * sits in the CRM shell, which needs `crm_records` for its Contacts link. No
 * header, cookie or query string can switch either on.
 *
 * The run is read from the BROWSER: a reload resumes it from the server
 * (getScriptRun, R1), and only the API decides whether the id is the
 * caller's own run. Another agent's run and no run are the same 404, drawn
 * as the generic not-found. A non-uuid id names nothing, so it is the app's
 * own 404 with no round trip.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The document title, in the reader's language. Never a script's, a contact's or
 * a person's name: titles land in browser history on a shared desk (D-L63).
 * With the flag off it is the app's default, so the title does not name a
 * hidden screen either.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmScriptsEnabled()) || !(await crmRecordsEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('scripting.run.documentTitle') };
}

export default async function ScriptRunPage({ params }: { params: Promise<{ runId: string }> }) {
  if (!(await crmScriptsEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  const { runId } = await params;
  if (!UUID.test(runId)) {
    notFound();
  }
  const { locale } = await activeLocale();

  return (
    <ScriptRunScreen
      key={runId}
      id={runId}
      locale={locale}
      messages={bundleMessages(locale, SCRIPT_RUN_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      live={await crmLiveNav()}
      recordLink={await crmRecordViewEnabled()}
    />
  );
}
