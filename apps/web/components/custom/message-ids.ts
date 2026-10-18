import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * The strings the custom-value screens need (T-0091), resolved on the SERVER.
 *
 * **No `'use client'` in this file, ever** (see `components/admin/message-ids.ts`).
 * They are added to a screen's bundle ONLY where the custom-fields flag is on
 * (`withCustomMessages`), so a process without the feature sends none of its
 * words to a 256 kbps user.
 */
export const CUSTOM_VALUES_MESSAGE_IDS: readonly MessageId[] = [
  'custom.section.title',
  'custom.noValue',
  'custom.boolean.true',
  'custom.boolean.false',
  'custom.readOnly',
  'custom.currencyHint',
  'custom.filter.any',
  'custom.filter.isEmpty',
  'custom.filter.group',
  'custom.error.invalid_value',
  'custom.error.custom_too_large',
  'custom.error.unknown_field',
  'custom.error.field_not_editable',
  'custom.error.field_withheld',
  'records.locked',
  'records.cell.empty',
];

export function withCustomMessages(ids: readonly MessageId[], enabled: boolean): readonly MessageId[] {
  return enabled ? [...new Set([...ids, ...CUSTOM_VALUES_MESSAGE_IDS])] : ids;
}
