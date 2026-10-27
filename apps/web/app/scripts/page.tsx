import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { ScriptListScreen } from '../../components/script-builder/script-list-screen';
import { SCRIPT_LIST_MESSAGE_IDS } from '../../components/script-builder/message-ids';
import { crmLiveNav, crmRecordsEnabled, crmScriptsEnabled } from '../../lib/feature-flags';
import { withShellMessages } from '../../components/crm/shell-messages';
import { activeLocale, languageOptions } from '../../lib/locale';

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

/**
 * `P10/05` — the script builder's list (T-0115).
 *
 * Behind `crm_scripts`, DEFAULT OFF and read on the server: a gated ROUTE, so
 * with the flag off this is a real 404 and nothing of the screen ships. It
 * sits in the CRM shell, which needs `crm_records`. No header, cookie or query
 * string can switch either on.
 *
 * The admin set authors (`script.write`, D-P32). The page cannot tell who that
 * is on the server (no read is made here, and a mock only reaches the browser),
 * so the list screen reads `getMyCapabilities` (T-0158) and draws the not-found
 * a missing script gets for a caller who holds it nowhere; the CRM nav links
 * nobody here (R3).
 */
export default async function ScriptListPage() {
  if (!(await crmScriptsEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <ScriptListScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(SCRIPT_LIST_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
