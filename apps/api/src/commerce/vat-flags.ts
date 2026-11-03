export const VAT_MULTITAX_ENABLED_TOKEN = Symbol('VAT_MULTITAX_ENABLED');

/** `vat_multitax` (T-0173): anything but an explicit true is off. */
export function vatMultitaxEnabled(options: { vatMultitaxEnabled?: boolean }): boolean {
  return options.vatMultitaxEnabled === true;
}
