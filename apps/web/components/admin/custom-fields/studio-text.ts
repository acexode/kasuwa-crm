import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import type { ScreenError } from '../../../lib/admin-api';
import type { Classification, CustomFieldObject, CustomFieldType } from '../../../lib/custom-fields-api';
import { errorMessageId } from '../panel';
import { formatDayFirst } from '../../../lib/date-locale';

/**
 * The studio's labels, by the closed sets the contract names. One table per
 * set, every id written out whole: a computed id (`...type.${type}`) cannot be
 * found by the tooling that checks every catalogue has it, and a missing one
 * only throws at request time, in the language somebody chose.
 */

export const OBJECT_LABEL: Readonly<Record<CustomFieldObject, MessageId>> = {
  contact: 'admin.studio.custom.object.contact',
  account: 'admin.studio.custom.object.account',
  activity: 'admin.studio.custom.object.activity',
  deal: 'admin.studio.custom.object.deal',
};

export const TYPE_LABEL: Readonly<Record<CustomFieldType, MessageId>> = {
  text: 'admin.studio.custom.type.text',
  number: 'admin.studio.custom.type.number',
  currency: 'admin.studio.custom.type.currency',
  date: 'admin.studio.custom.type.date',
  picklist: 'admin.studio.custom.type.picklist',
  boolean: 'admin.studio.custom.type.boolean',
};

export const CLASSIFICATION_LABEL: Readonly<Record<Classification, MessageId>> = {
  none: 'admin.studio.custom.class.none',
  pii: 'admin.fls.class.pii',
  sensitive: 'admin.fls.class.sensitive',
};

/** A custom-field write's `details[].code`, each drawn by its own label. */
const DETAIL_LABEL: Readonly<Record<string, MessageId>> = {
  invalid_api_name: 'admin.studio.custom.error.invalid_api_name',
  unsupported_type: 'admin.studio.custom.error.unsupported_type',
  invalid_config: 'admin.studio.custom.error.invalid_config',
  unknown_currency: 'admin.studio.custom.error.unknown_currency',
  duplicate_value: 'admin.studio.custom.error.duplicate_value',
  not_a_picklist: 'admin.studio.custom.error.not_a_picklist',
  unknown_value: 'admin.studio.custom.error.unknown_value',
  field_retired: 'admin.studio.custom.error.field_retired',
  duplicate: 'admin.studio.custom.error.duplicate',
  field_limit_reached: 'admin.studio.custom.error.field_limit_reached',
  picklist_limit_reached: 'admin.studio.custom.error.picklist_limit_reached',
};

/** The localised sentence for a refusal: the detail's own label if it has one, else `admin.error.<code>`. Never the code, never the API's English. */
export function errorText(t: Translator, error: ScreenError): string {
  const detail = error.details?.[0]?.code;
  const own = detail !== undefined && Object.hasOwn(DETAIL_LABEL, detail) ? DETAIL_LABEL[detail] : undefined;
  return t.t(own ?? errorMessageId(error));
}

/** Each type's glyph, from the export's type list (T-0142). `boolean` is not in the export: `toggle_on`. */
export const TYPE_ICON: Readonly<Record<CustomFieldType, IconName>> = {
  text: 'short_text',
  number: 'pin',
  currency: 'payments',
  date: 'event',
  picklist: 'arrow_drop_down_circle',
  boolean: 'toggle_on',
};

/** The export's thirteen types, plus the contract's `boolean`, which the export does not draw. */
export type DesignedType =
  | CustomFieldType
  | 'multi'
  | 'lookup'
  | 'formula'
  | 'rollup'
  | 'phone'
  | 'email'
  | 'secure'
  | 'file';

export interface TypeCard {
  readonly id: DesignedType;
  readonly icon: IconName;
  readonly label: MessageId;
  readonly description: MessageId;
  /** A type the contract accepts. The rest are drawn disabled behind `custom_field_types_extended` (D-L194). */
  readonly supported: boolean;
}

/**
 * The type picker's cards, in the export's order, with `boolean` after the
 * picklist: the contract's six first, so the cards an admin can choose are
 * never scattered between disabled ones.
 */
export const TYPE_CARDS: readonly TypeCard[] = [
  { id: 'text', icon: 'short_text', label: 'admin.studio.custom.type.text', description: 'admin.studio.type.text.desc', supported: true },
  { id: 'number', icon: 'pin', label: 'admin.studio.custom.type.number', description: 'admin.studio.type.number.desc', supported: true },
  { id: 'currency', icon: 'payments', label: 'admin.studio.custom.type.currency', description: 'admin.studio.type.currency.desc', supported: true },
  { id: 'date', icon: 'event', label: 'admin.studio.custom.type.date', description: 'admin.studio.type.date.desc', supported: true },
  { id: 'picklist', icon: 'arrow_drop_down_circle', label: 'admin.studio.custom.type.picklist', description: 'admin.studio.type.picklist.desc', supported: true },
  { id: 'boolean', icon: 'toggle_on', label: 'admin.studio.custom.type.boolean', description: 'admin.studio.type.boolean.desc', supported: true },
  { id: 'multi', icon: 'checklist', label: 'admin.studio.type.multi', description: 'admin.studio.type.multi.desc', supported: false },
  { id: 'lookup', icon: 'link', label: 'admin.studio.type.lookup', description: 'admin.studio.type.lookup.desc', supported: false },
  { id: 'formula', icon: 'function', label: 'admin.studio.type.formula', description: 'admin.studio.type.formula.desc', supported: false },
  { id: 'rollup', icon: 'functions', label: 'admin.studio.type.rollup', description: 'admin.studio.type.rollup.desc', supported: false },
  { id: 'phone', icon: 'call', label: 'admin.studio.type.phone', description: 'admin.studio.type.phone.desc', supported: false },
  { id: 'email', icon: 'mail', label: 'admin.studio.type.email', description: 'admin.studio.type.email.desc', supported: false },
  { id: 'secure', icon: 'shield_lock', label: 'admin.studio.type.secure', description: 'admin.studio.type.secure.desc', supported: false },
  { id: 'file', icon: 'attach_file', label: 'admin.studio.type.file', description: 'admin.studio.type.file.desc', supported: false },
];

/** The four contract currencies' names, from the catalogue (CLDR's own names in each language). */
const CURRENCY_NAME: Readonly<Record<string, MessageId>> = {
  NGN: 'admin.studio.custom.currency.name.NGN',
  GHS: 'admin.studio.custom.currency.name.GHS',
  KES: 'admin.studio.custom.currency.name.KES',
  ZAR: 'admin.studio.custom.currency.name.ZAR',
};

/**
 * "<symbol> Nigerian naira (NGN)": the symbol from Intl (never hard-coded), the name
 * from the catalogue. The name was Intl's until T-0149, which in a language
 * ICU knows no names for falls back to English, the one thing a translated
 * menu must never do; the catalogue carries CLDR's names instead.
 */
export function currencyOptionLabel(t: Translator, locale: string, code: string): string {
  const id = Object.hasOwn(CURRENCY_NAME, code) ? CURRENCY_NAME[code] : undefined;
  const name = id === undefined ? code : t.t(id);
  let symbol = '';
  try {
    symbol =
      new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? '';
  } catch {
    symbol = '';
  }
  const named = name === code ? code : `${name} (${code})`;
  return symbol === '' || symbol === code ? named : `${symbol} ${named}`;
}

/**
 * "2 Oct 2026": the export's day-first date. Plain `en` writes the month
 * first, which no desk Kasuwa serves reads that way, so only the bare tag is
 * read as en-NG (the same rule as P03's `home-format.ts`). Shown in the
 * reader's own zone.
 */
export function modifiedDate(locale: string, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // Day first, "Sep" not "Sept", as every Kasuwa date (T-0143's lib/date-locale.ts).
  return formatDayFirst(locale, date, { day: 'numeric', month: 'short', year: 'numeric' });
}
