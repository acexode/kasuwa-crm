import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * The small half of the custom-value code (T-0091): what EVERY record screen
 * needs even when a tenant has defined no field at all — the key paths, the
 * list-filter query, and the translated meaning of a refusal. Kept apart from
 * `custom-values-model.ts` (formatting, encoding, patching) so that a screen
 * with nothing to show ships only this, and the rest is fetched when a
 * definition exists (PRD 2.13: every byte is paid for at 256 kbps).
 */

/** `custom.<key>`: how `withheldFields` and error details name a custom key. */
export function customPath(key: string): string {
  return `custom.${key}`;
}

export function isCustomWithheld(withheldFields: readonly string[], key: string): boolean {
  return withheldFields.includes(customPath(key));
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

interface Refusal {
  readonly details?: readonly { readonly path: string; readonly code: string }[];
}

/** What a screen says when a typed custom value is not a value of its type, before anything is sent. */
export const CUSTOM_INVALID: MessageId = 'custom.error.invalid_value';

const REASONS: Readonly<Record<string, MessageId>> = {
  invalid_value: 'custom.error.invalid_value',
  unknown_value: 'custom.error.invalid_value',
  currency_mismatch: 'custom.error.invalid_value',
  custom_too_large: 'custom.error.custom_too_large',
  unknown_field: 'custom.error.unknown_field',
  field_not_editable: 'custom.error.field_not_editable',
  // On a write the key is one the caller cannot see: its own sentence (the filter's says "filter").
  field_withheld: 'custom.error.withheld_write',
};

function aboutCustom(path: string): boolean {
  return path === 'custom' || path.startsWith('custom.') || path === 'customEmpty';
}

/** The translated message for the custom-field refusal an error carries, or `null` when it carries none. */
export function customErrorId(error: Refusal | null | undefined): MessageId | null {
  for (const detail of error?.details ?? []) {
    const id = REASONS[detail.code];
    if (id !== undefined && aboutCustom(detail.path)) return id;
  }
  return null;
}

/** The keys a refusal named `field_not_editable`: read-only from now on, and never sent again. */
export function notEditableKeys(error: Refusal | null | undefined): string[] {
  const keys: string[] = [];
  for (const detail of error?.details ?? []) {
    const match = detail.code === 'field_not_editable' ? /^custom\.([^.]+)$/.exec(detail.path) : null;
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

/** A refusal that says a custom field is not there: the definitions this screen holds are stale and are read again. */
export function namesUnknownField(error: Refusal | null | undefined): boolean {
  return error?.details?.some((detail) => detail.code === 'unknown_field' && aboutCustom(detail.path)) === true;
}
