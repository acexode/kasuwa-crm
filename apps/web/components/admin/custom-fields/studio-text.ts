import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { ScreenError } from '../../../lib/admin-api';
import type { Classification, CustomFieldObject, CustomFieldType } from '../../../lib/custom-fields-api';
import { errorMessageId } from '../panel';

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
  const own = detail === undefined ? undefined : DETAIL_LABEL[detail];
  return t.t(own ?? errorMessageId(error));
}
