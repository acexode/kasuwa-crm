import type { MessageId } from '@kasuwa/i18n/bundle';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';

/** P08 inbox (T-0192): strings resolved on the server. */
export const INBOX_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'records.nav.soon',
  'records.offline.title',
  'records.offline.never',
  'records.retry',
  'inbox.title',
  'inbox.subtitle',
  'inbox.queue.title',
  'inbox.queue.empty',
  'inbox.queue.emptyBody',
  'inbox.thread.empty',
  'inbox.thread.emptyBody',
  'inbox.composer.placeholder',
  'inbox.composer.send',
  'inbox.composer.template',
  'inbox.composer.ai',
  'inbox.composer.payment',
  'inbox.composer.note',
  'inbox.composer.channel',
  'inbox.pane.contact',
  'inbox.pane.empty',
  'inbox.window.closed',
  'inbox.window.closedBody',
];
