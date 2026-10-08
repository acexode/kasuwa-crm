import type { MessageId } from '@kasuwa/i18n/bundle';
import { ConsentState, ContactSource, ContactStatus, PreferredChannel, RecordsErrorCode } from '../../lib/records-api';
import { ActivityType } from '../../lib/contact-record-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { DETAILS, LANGUAGE_CODES, fieldLabel } from './record-model';

/**
 * The strings P05/01 needs, resolved on the SERVER (T-0062).
 *
 * **No `'use client'` in this file, ever** — the same rule as
 * `components/contacts/message-ids.ts`: a server component importing a client
 * module's array gets a proxy, which fails at request time and not at compile
 * time. Only these strings cross the wire; the catalogues stay on the server.
 */

/** Every field the timeline can name (the contract's two `field` enums), plus consent. */
const TIMELINE_FIELDS = [
  'status',
  'source',
  'preferredChannel',
  'preferredLanguage',
  'whatsappOptIn',
  'state',
  'lga',
  'tags',
  'displayName',
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'ownerUserId',
  'accountId',
  'consentState',
] as const;

export const CONTACT_RECORD_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'records.title',
  'notFound.title',
  'notFound.body',
  'record.section.details',
  'record.section.related',
  'record.section.activity',
  'record.sections',
  ...DETAILS.map((spec) => spec.label),
  ...TIMELINE_FIELDS.flatMap((field) => {
    const id = fieldLabel(field);
    return id === null ? [] : [id];
  }),
  ...LANGUAGE_CODES.map((code) => `record.language.${code}` as MessageId),
  ...ContactStatus.options.map((value) => `records.status.${value}` as MessageId),
  ...ContactSource.options.map((value) => `records.source.${value}` as MessageId),
  ...ConsentState.options.map((value) => `records.consent.${value}` as MessageId),
  ...PreferredChannel.options.map((value) => `records.channel.${value}` as MessageId),
  ...ActivityType.options.map((value) => `record.activity.type.${value}` as MessageId),
  'records.filter.dnd.on',
  'records.filter.dnd.off',
  'records.filter.wa.on',
  'records.filter.wa.off',
  'records.wa.in',
  'records.cell.empty',
  'records.locked',
  'records.owner.unassigned',
  'records.account.none',
  'records.loadingMore',
  'records.retry',
  'records.offline.title',
  'records.offline.never',
  'record.offline',
  'record.loading',
  'record.unavailable',
  'record.system',
  'record.assignToMe',
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
  'record.sheet.title',
  'record.sheet.close',
  'record.sheet.save',
  'record.sheet.phonesHint',
  'record.sheet.emailsHint',
  'record.sheet.tagsHint',
  'record.error.invalid',
  'record.error.stale',
  'record.conflict.otherChange',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  // The "still connecting" state is the admin console's, word for word: the
  // same NFR, the same sentence, already translated.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];
