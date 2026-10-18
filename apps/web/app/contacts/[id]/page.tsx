import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { ContactRecordScreen } from '../../../components/contact-record/contact-record-screen';
import { CONTACT_RECORD_MESSAGE_IDS } from '../../../components/contact-record/message-ids';
import { START_SCRIPT_MESSAGE_IDS } from '../../../components/script-run/message-ids';
import { crmCustomFieldsEnabled, crmLiveNav, crmRecordViewEnabled, crmRecordsEnabled, crmScriptsEnabled } from '../../../lib/feature-flags';
import { withCustomMessages } from '../../../components/custom/message-ids';
import { withSearchMessages } from '../../../components/search/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P05/01` — the contact record, the 360° view (T-0062), with `P05/02`,
 * `P05/05` and `P05/06`.
 *
 * Behind `crm_record_view`, DEFAULT OFF and read on the server: a gated ROUTE,
 * so with the flag off this is a real 404 and nothing of the screen ships. It
 * needs `crm_records` too, because the record sits in the CRM shell and the
 * shell's Contacts link must resolve wherever the record does. No header,
 * cookie or query string can switch either on (`lib/feature-flags.ts`).
 *
 * The record is read from the BROWSER, not here: a server-component read
 * cannot show the loading, still-connecting or offline states P05/06 draws.
 * That is also what the `@harness` tenancy test relies on — the browser asks
 * for the record by id and the API alone decides whether it is in scope.
 *
 * The P10 "Start script" control (T-0116) is drawn only where `crm_scripts`
 * is on, read HERE and passed down as a boolean: no client module names the
 * flag, and with it off the record ships neither the control nor its strings.
 *
 * An id that is not a uuid cannot name a record, so it is the app's own 404
 * without a round trip. It is the same generic page an out-of-scope id gets.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ContactRecordPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await crmRecordViewEnabled()) || !(await crmRecordsEnabled())) {
    notFound();
  }
  const { id } = await params;
  if (!UUID.test(id)) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const scripts = await crmScriptsEnabled();
  const customFields = await crmCustomFieldsEnabled();

  return (
    <ContactRecordScreen
      id={id}
      locale={locale}
      messages={bundleMessages(locale, withSearchMessages(withCustomMessages(scripts ? [...CONTACT_RECORD_MESSAGE_IDS, ...START_SCRIPT_MESSAGE_IDS] : CONTACT_RECORD_MESSAGE_IDS, customFields), live))}
      locales={languageOptions(locale)}
      live={live}
      scripts={scripts}
      customFields={customFields}
    />
  );
}
