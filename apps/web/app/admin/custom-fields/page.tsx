import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { ADMIN_STUDIO_MESSAGE_IDS } from '../../../components/admin/custom-fields/message-ids';
import { StudioScreen } from '../../../components/admin/custom-fields/studio-screen';
import { crmCustomFieldsEnabled } from '../../../lib/feature-flags';
import { adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `P18/B` — the customisation studio for custom fields (T-0090).
 *
 * Behind `crm_custom_fields`: with it off this is a real 404 and nothing of
 * the screen ships. The flag is read here, on the server, and decides nothing
 * about access: the API answers every read and refuses every write without
 * `custom_field.write`, on or off.
 */
export default async function CustomFieldsPage() {
  if (!(await crmCustomFieldsEnabled())) notFound();
  const { locale } = await activeLocale();
  const linkedSettings = await adminLiveNav();

  return (
    <StudioScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_STUDIO_MESSAGE_IDS, Object.keys(linkedSettings)))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
    />
  );
}
