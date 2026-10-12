import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { ActivitiesScreen } from '../../components/activities/activities-screen';
import { ACTIVITIES_MESSAGE_IDS } from '../../components/activities/message-ids';
import { crmActivitiesEnabled, crmLiveNav } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `P07` — Activities (T-0083): My tasks by bucket, the calendar, the
 * composer, snooze and reschedule.
 *
 * Behind `crm_activities`, DEFAULT OFF and read on the server: a gated ROUTE,
 * so with the flag off this is a real 404 and nothing of the screen ships. No
 * header, cookie or query string can switch it on (`lib/feature-flags.ts`).
 *
 * The activities are read from the BROWSER (`lib/activities-api.ts`), not
 * here: the buckets are computed in the browser's own time zone, which a
 * server render cannot know and must not guess, and the loading and offline
 * states are the ones a 256 kbps user lives in.
 */
export default async function ActivitiesPage() {
  if (!(await crmActivitiesEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();

  return (
    <ActivitiesScreen
      locale={locale}
      messages={bundleMessages(locale, ACTIVITIES_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      live={await crmLiveNav()}
    />
  );
}
