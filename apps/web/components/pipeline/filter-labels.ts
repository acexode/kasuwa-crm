import type { ClosePreset } from './pipeline-model';

/**
 * The close-date presets' labels, for the desktop filter card and the phone's
 * sheet, which loads on demand (T-0145). Board-only, apart from the model the
 * deal shares, so the deal's bundle is not asked for them.
 */
export const CLOSE_PRESET_LABELS = {
  any: 'pipeline.filter.close.any',
  month: 'pipeline.filter.close.month',
  next60: 'pipeline.filter.close.next60',
  overdue: 'pipeline.filter.close.overdue',
  custom: 'pipeline.filter.close.custom',
} as const satisfies Record<ClosePreset, string>;
