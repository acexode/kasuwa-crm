import { bundleMessages } from '@kasuwa/i18n';
import { STUDIO_SECTION_MESSAGE_IDS } from '../../../components/admin/studio/message-ids';
import { adminBellLive, adminLiveNav } from '../../../components/admin/live-nav';
import { withNotificationMessages } from '../../../components/notifications/message-ids';
import { CustomFieldObject } from '../../../lib/custom-fields-api';
import { studioFlags, type StudioFlags } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * What every studio placeholder route reads on the server (T-0142): the
 * flags, the locale and its bundle, the menu's live links and the bell. Each
 * route still calls `notFound()` on its OWN flag before drawing anything.
 */
export async function studioPage(search: Record<string, string | string[] | undefined>) {
  const [studio, { locale }, linkedSettings, bell] = await Promise.all([
    studioFlags(),
    activeLocale(),
    adminLiveNav(),
    adminBellLive(),
  ]);
  const requested = CustomFieldObject.safeParse(search.object);
  return {
    studio,
    common: {
      locale,
      messages: bundleMessages(locale, withNotificationMessages(STUDIO_SECTION_MESSAGE_IDS, bell ? ['notifications'] : [])),
      locales: languageOptions(locale),
      linkedSettings,
      bell,
    },
    object: requested.success ? requested.data : ('contact' as const),
    sections: sectionsOf(studio),
  };
}

export function sectionsOf(studio: StudioFlags) {
  return {
    objects: studio.objects,
    layouts: studio.layouts,
    validation: studio.validation,
    relationships: studio.relationships,
  };
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
