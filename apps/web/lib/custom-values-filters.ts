import type { MessageId } from '@kasuwa/i18n/bundle';
import type { CustomField } from './custom-values-api';

/**
 * The half of the custom-value code a LIST needs (T-0091): the filter query and
 * the one refusal a filter can meet. Apart from `custom-values-core.ts` (the
 * forms' half) so a list ships nothing it does not use: PRD 2.13.
 */

/** The option value that means "no value" on a custom filter; a picklist value can never contain `-`. */
export const IS_EMPTY = 'is-empty';

/** One value per key: a picklist value, `true`/`false`, or `is-empty`. */
export type CustomFilters = Readonly<Record<string, string>>;

export const NO_CUSTOM_FILTERS: CustomFilters = {};

/** The fields a list can filter on: picklist and boolean (D-L128 Q4). */
export function filterableFields(fields: readonly CustomField[]): readonly CustomField[] {
  return fields.filter((field) => field.type === 'picklist' || field.type === 'boolean');
}

/** Adds the custom filters to a query: `custom[key]=value`, or `customEmpty=key`. */
export function appendCustomFilters(params: URLSearchParams, filters: CustomFilters | undefined): void {
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === IS_EMPTY) params.append('customEmpty', key);
    else if (value !== '') params.set(`custom[${key}]`, value);
  }
}

export function setCustomFilter(filters: CustomFilters, key: string, value: string): CustomFilters {
  const next = { ...filters };
  if (value === '') delete next[key];
  else next[key] = value;
  return next;
}

/**
 * `400 field_withheld` at `custom.<key>` on a filter: a key withheld in a
 * programme the caller reaches. Its own sentence, not the generic one. Any
 * other refusal is the list's usual copy.
 */
export function listRefusalId(error: { readonly details?: readonly { readonly path: string; readonly code: string }[] } | null | undefined): MessageId | null {
  const refused = error?.details?.some((detail) => detail.code === 'field_withheld' && detail.path.startsWith('custom.')) === true;
  return refused ? 'custom.error.field_withheld' : null;
}
