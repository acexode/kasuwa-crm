import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { NotificationCentre } from '../../components/notifications/centre';
import { CENTRE_MESSAGE_IDS } from '../../components/notifications/message-ids';
import { CRM_SHELL_MESSAGE_IDS } from '../../components/crm/crm-nav';
import { withShellMessages } from '../../components/crm/shell-messages';
import { crmLiveNav, crmNotificationsEnabled } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `/notifications` — P26, the notification centre (T-0101).
 *
 * Behind `crm_notifications`, DEFAULT OFF and read on the server: a gated
 * ROUTE, so with the flag off this is a real 404 and nothing of the screen
 * ships. No header, cookie or query string can switch it on
 * (`lib/feature-flags.ts`).
 *
 * The list is read from the BROWSER (`lib/notifications-api.ts`), which the API
 * scopes by the session. The title never carries a name, and nothing about a
 * notification is kept on the device (D-P21).
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmNotificationsEnabled())) {
    return {};
  }
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('notifications.title') };
}

export default async function NotificationsPage() {
  if (!(await crmNotificationsEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const live = await crmLiveNav();

  return (
    <NotificationCentre
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([...CRM_SHELL_MESSAGE_IDS, ...CENTRE_MESSAGE_IDS], live))}
      locales={languageOptions(locale)}
      live={live}
    />
  );
}
