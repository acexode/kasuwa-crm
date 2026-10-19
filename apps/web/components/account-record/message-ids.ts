import type { MessageId } from '@kasuwa/i18n/bundle';
import { AccountTier } from '../../lib/accounts-api';
import { AccountTimelineField } from '../../lib/account-record-api';
import { ActivityKind } from '../../lib/contact-record-api';
import { RecordsErrorCode } from '../../lib/records-api';
import { tierLabel } from '../accounts/accounts-model';
import { ACCOUNT_EDIT_SHEET_MESSAGE_IDS } from '../accounts/message-ids';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { ACCOUNT_DETAILS, accountFieldLabel } from './account-record-model';

/**
 * The strings P05/04 needs, resolved on the SERVER (T-0063).
 *
 * **No `'use client'` in this file, ever** — a server component importing a
 * client module's array gets a proxy, which fails at request time and not at
 * compile time (`app/client-boundary.test.ts`). Only these strings cross the
 * wire; the catalogues stay on the server.
 *
 * `message-ids.test.ts` checks every id the screen's sources name is here.
 */
export const ACCOUNT_RECORD_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  // The record opens T-0057's sheet to EDIT only: nothing of the create flow ships here.
  ...ACCOUNT_EDIT_SHEET_MESSAGE_IDS,
  'accounts.title',
  'notFound.title',
  'notFound.body',
  'account.loading',
  'account.unavailable',
  'account.hierarchy',
  'account.hierarchy.partial',
  'account.hierarchy.limit',
  'account.hierarchy.cycle',
  'account.field.parentAccountId',
  'account.section.contacts',
  'account.contacts.empty',
  'account.contacts.withheld',
  'account.contacts.error',
  'record.section.details',
  'record.section.activity',
  ...ACCOUNT_DETAILS.map((spec) => spec.label),
  ...AccountTimelineField.options.flatMap((field) => {
    const id = accountFieldLabel(field);
    return id === null ? [] : [id];
  }),
  ...AccountTier.options.map(tierLabel),
  // Every type a timeline may show, meetings included (T-0082).
  ...ActivityKind.options.map((value) => `record.activity.type.${value}` as MessageId),
  'records.cell.empty',
  'records.locked',
  'records.name.withheld',
  'records.owner.unassigned',
  'records.loadMore',
  'records.loadingMore',
  'records.retry',
  'records.offline.title',
  'records.offline.never',
  'record.offline',
  'record.system',
  'record.edit',
  'record.saved',
  'record.saving',
  'record.timeline.zone',
  'record.timeline.changed',
  'record.timeline.to',
  'record.timeline.redacted',
  'record.timeline.empty',
  'record.timeline.error',
  'record.timeline.loadOlder',
  'record.activity.due',
  'record.activity.done',
  'record.activity.complete',
  'record.log.group',
  'record.log.title.note',
  'record.log.title.task',
  'record.log.title.call',
  'record.form.subject',
  'record.form.body',
  'record.form.hint',
  'record.form.save',
  'record.form.cancel',
  'record.error.invalid',
  'record.error.stale',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  // The "still connecting" state is the admin console's, word for word: the
  // same NFR, the same sentence, already translated.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];
