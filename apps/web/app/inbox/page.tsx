import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bundleMessages, createTranslator } from '@kasuwa/i18n';
import { InboxScreen } from '../../components/inbox/inbox-screen';
import { INBOX_MESSAGE_IDS } from '../../components/inbox/message-ids';
import { withShellMessages } from '../../components/crm/shell-messages';
import { crmInboxEnabled, crmLiveNav, inboxPlaceholders } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/** P08 inbox (T-0192), behind `crm_inbox`. */
export async function generateMetadata(): Promise<Metadata> {
  if (!(await crmInboxEnabled())) return {};
  const { locale } = await activeLocale();
  return { title: createTranslator(locale).t('inbox.title') };
}

export default async function InboxPage() {
  if (!(await crmInboxEnabled())) notFound();
  const { locale } = await activeLocale();
  const live = await crmLiveNav();
  const placeholders = await inboxPlaceholders();

  return (
    <InboxScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages([...INBOX_MESSAGE_IDS], live))}
      locales={languageOptions(locale)}
      live={live}
      placeholders={placeholders}
    />
  );
}
