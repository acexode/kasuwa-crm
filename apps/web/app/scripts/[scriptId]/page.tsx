import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ScriptEditorScreen } from '../../../components/script-builder/script-editor-screen';
import { SCRIPT_EDITOR_MESSAGE_IDS } from '../../../components/script-builder/message-ids';
import { crmLiveNav, crmRecordsEnabled, crmScriptsEnabled } from '../../../lib/feature-flags';
import { withSearchMessages } from '../../../components/search/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P10/05` — the script builder's editor for one script's draft (T-0115), and
 * a published version read-only inside the same route (R1).
 *
 * Behind `crm_scripts`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404. The script is read from the BROWSER,
 * and the API alone decides whether the caller may author it: a script in
 * another programme, one the caller may not author and one that does not
 * exist are the same 404, drawn as the one generic not-found (R2). A non-uuid
 * id names nothing, so it is the app's own 404 with no round trip.
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
  return { title: createTranslator(locale).t('scripting.builder.documentTitle') };
}

export default async function ScriptEditorPage({ params }: { params: Promise<{ scriptId: string }> }) {
  if (!(await crmScriptsEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  const { scriptId } = await params;
  if (!UUID.test(scriptId)) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <ScriptEditorScreen
      key={scriptId}
      id={scriptId}
      locale={locale}
      messages={bundleMessages(locale, withSearchMessages(SCRIPT_EDITOR_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
