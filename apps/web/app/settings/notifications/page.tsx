import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { NotificationPreferences } from '../../../components/notifications/preferences';
import { PREFERENCES_MESSAGE_IDS } from '../../../components/notifications/message-ids';
import { CRM_SHELL_MESSAGE_IDS } from '../../../components/crm/crm-nav';
import { withShellMessages } from '../../../components/crm/shell-messages';
import { crmLiveNav, notificationPreferencesEnabled } from '../../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../../lib/locale';

/**
 * `/settings/notifications` — P26 D, notification preferences (T-0137).
 *
 * A gated ROUTE: it answers only where `crm_notifications` AND
 * `notification_preferences` are on, read on the server; otherwise a real 404
 * and nothing of the screen ships. There is no preferences API, so the screen
 * is drawn in its disabled state (D-L194) and saves nothing.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await notificationPreferencesEnabled())) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('notifications.preferences.label') };
}

export default async function NotificationPreferencesPage() {
  if (!(await notificationPreferencesEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  return (
    <NotificationPreferences
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([...CRM_SHELL_MESSAGE_IDS, ...PREFERENCES_MESSAGE_IDS], live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
