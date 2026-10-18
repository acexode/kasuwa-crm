import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * The strings the custom-value screens need (T-0091), resolved on the SERVER.
 *
 * **No `'use client'` in this file, ever** (see `components/admin/message-ids.ts`).
 * They are added to a screen's bundle ONLY where the custom-fields flag is on
 * (`withCustomMessages`), and a screen takes only the half it draws: a list
 * its filters and the one refusal a filter can meet, a record its slots,
 * inputs and every refusal. Nothing here is sent where the feature is off:
 * PRD 2.13, every byte at 256 kbps.
 */
const REFUSALS: readonly MessageId[] = [
  'custom.error.invalid_value',
  'custom.error.custom_too_large',
  'custom.error.unknown_field',
  'custom.error.field_not_editable',
  'custom.error.field_withheld',
];

const BOOLEAN: readonly MessageId[] = ['custom.boolean.true', 'custom.boolean.false'];

/** A record, its edit form and its activity form. */
export const CUSTOM_RECORD_MESSAGE_IDS: readonly MessageId[] = [
  'custom.section.title',
  'custom.noValue',
  'custom.readOnly',
  'custom.currencyHint',
  ...BOOLEAN,
  ...REFUSALS,
  'records.locked',
  'records.cell.empty',
];

/** A list's custom filters. */
export const CUSTOM_LIST_MESSAGE_IDS: readonly MessageId[] = [
  'custom.filter.any',
  'custom.filter.isEmpty',
  'custom.filter.group',
  ...BOOLEAN,
  'custom.error.field_withheld',
];

export function withCustomMessages(
  ids: readonly MessageId[],
  enabled: boolean,
  kind: 'record' | 'list' = 'record',
): readonly MessageId[] {
  if (!enabled) return ids;
  return [...new Set([...ids, ...(kind === 'list' ? CUSTOM_LIST_MESSAGE_IDS : CUSTOM_RECORD_MESSAGE_IDS)])];
}
