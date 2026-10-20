import { notFound } from 'next/navigation';
import { DESIGN_MENU_LOCALES, bundleMessages } from '@kasuwa/i18n';
import { ADMIN_STUDIO_MESSAGE_IDS } from '../../../components/admin/custom-fields/message-ids';
import { StudioScreen } from '../../../components/admin/custom-fields/studio-screen';
import { crmCustomFieldsEnabled, studioFlags } from '../../../lib/feature-flags';
import { CustomFieldObject } from '../../../lib/custom-fields-api';
import { adminBellLive, adminLiveNav } from '../../../components/admin/live-nav';
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
export default async function CustomFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await crmCustomFieldsEnabled())) notFound();
  const { locale } = await activeLocale();
  const [linkedSettings, bell, studio, search] = await Promise.all([adminLiveNav(), adminBellLive(), studioFlags(), searchParams]);
  // `?object=` is where the object manager and the studio's tabs link; anything else is contact, the contract's first.
  const requested = CustomFieldObject.safeParse(search.object);

  return (
    <StudioScreen
      locale={locale}
      messages={bundleMessages(locale, withNotificationMessages(ADMIN_STUDIO_MESSAGE_IDS, bell ? ['notifications'] : []))}
      locales={languageOptions(locale)}
      linkedSettings={linkedSettings}
      bell={bell}
      initialObject={requested.success ? requested.data : 'contact'}
      sections={{
        objects: studio.objects,
        layouts: studio.layouts,
        validation: studio.validation,
        relationships: studio.relationships,
      }}
      editorFlags={{
        extendedTypes: studio.extendedTypes,
        usage: studio.usage,
        translations: studio.translations ? DESIGN_MENU_LOCALES.filter((entry) => entry !== 'en') : [],
      }}
    />
  );
}
