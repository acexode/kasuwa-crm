'use client';

import * as customModel from '../../lib/custom-values-model';

type CustomModel = typeof customModel;

/**
 * The heavy half of the custom-value code (formatting, encoding, patching).
 * Only the forms that edit a value use it (the edit sheets, the activity forms
 * and the composer), and each of those is itself loaded when opened, so a
 * screen nobody has opened an editor on never ships it (PRD 2.13). Never
 * `null`: the forms render their inputs the moment they open.
 */
export function useCustomModel(_needed: boolean): CustomModel {
  return customModel;
}
