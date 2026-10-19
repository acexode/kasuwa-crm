import type { MessageId } from '@kasuwa/i18n/bundle';
import { ConsentState, ContactSource, ContactStatus, DuplicatesErrorCode, PreferredChannel, RecordsErrorCode } from '../../lib/records-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { COMPLIANCE_LABELS, DRAWN_FIELDS, FIELD_LABELS } from './merge-model';

/**
 * The strings the P28 duplicates screen needs (T-0097), resolved on the SERVER.
 *
 * **No `'use client'` in this file, ever** (see `components/admin/message-ids.ts`):
 * a server component importing a client module's array gets a proxy that fails
 * at request time. Only these strings cross the wire; the catalogues stay on
 * the server.
 *
 * Every id the screen draws is here, including the ones it builds from a
 * served value (a status, a consent state, a refusal's code): an id missing
 * from this list is not an English fallback, it is a thrown error in the
 * browser, in whichever language the person chose.
 */
export const DUPLICATES_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'duplicates.title',
  'duplicates.subtitle',
  'duplicates.programme.label',
  'duplicates.programme.failed',
  'duplicates.programme.none',
  'duplicates.sets.title',
  'duplicates.sets.loading',
  'duplicates.sets.empty',
  'duplicates.match.phone',
  'duplicates.match.email',
  'duplicates.withheld',
  'duplicates.updated',
  'duplicates.pick.legend',
  'duplicates.pick.hint',
  'duplicates.review',
  'duplicates.more',
  'duplicates.retry',
  'duplicates.retry.auto',
  'duplicates.history.title',
  'duplicates.history.note',
  'duplicates.history.loading',
  'duplicates.history.failed',
  'duplicates.history.empty',
  'duplicates.history.mergedAt',
  'duplicates.role.kept',
  'duplicates.role.merged',
  'duplicates.undo',
  'duplicates.undoUntil',
  'duplicates.undo.unavailable',
  'duplicates.undone',
  'duplicates.undone.body',
  'duplicates.expired',
  'duplicates.keptEdits',
  'duplicates.merge.title',
  'duplicates.merge.intro',
  'duplicates.merge.back',
  'duplicates.merge.mainLegend',
  'duplicates.merge.compare',
  'duplicates.merge.loading',
  'duplicates.merge.failed',
  'duplicates.merge.submit',
  'duplicates.merging',
  'duplicates.col.field',
  'duplicates.col.value',
  'duplicates.col.main',
  'duplicates.col.other',
  'duplicates.locked',
  'duplicates.compliance.title',
  'duplicates.compliance.note',
  'duplicates.dnd.off',
  'duplicates.confirm.title',
  'duplicates.confirm.body',
  'duplicates.confirm.yes',
  'duplicates.confirm.cancel',
  'duplicates.confirm.close',
  'duplicates.done.title',
  'duplicates.done.body',
  'duplicates.done.open',
  'duplicates.error.staleWrite',
  'duplicates.error.fieldNotEditable',
  'duplicates.error.alreadyMerged',
  // The comparison's rows and the words of the values it draws.
  ...DRAWN_FIELDS.map((field) => FIELD_LABELS[field]),
  ...Object.values(COMPLIANCE_LABELS),
  ...ContactStatus.options.map((value) => `records.status.${value}` as MessageId),
  ...ContactSource.options.map((value) => `records.source.${value}` as MessageId),
  ...PreferredChannel.options.map((value) => `records.channel.${value}` as MessageId),
  ...ConsentState.options.map((value) => `records.consent.${value}` as MessageId),
  'records.cell.empty',
  'records.dnd.label',
  'records.wa.in',
  'records.wa.out',
  'records.loadingMore',
  // Every refusal the five operations answer, and the transport's own.
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  ...DuplicatesErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  // The "still connecting" state is the admin console's, word for word.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];
