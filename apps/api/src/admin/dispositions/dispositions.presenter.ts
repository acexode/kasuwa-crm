import type { Disposition } from '@kasuwa/domain-core';

/**
 * Domain records -> `Disposition` and `DispositionList`
 * (docs/api/admin.openapi.yaml).
 *
 * `usageCount90d` is `null`, never `0`: it is an aggregate over interactions
 * (M10/M16) and no interactions table exists yet. The spec is explicit that
 * null makes the delete dialog omit its sentence, whereas `0` would tell an
 * admin a busy code is unused — the one wrong answer that gets it deleted.
 */

export const USAGE_WINDOW_DAYS = 90;

export interface DispositionResponse {
  id: string;
  code: string;
  label: string;
  category: Disposition['category'];
  noteRequired: boolean;
  followUpRequired: boolean;
  active: boolean;
  position: number;
  usageCount90d: null;
}

export interface DispositionListResponse {
  items: DispositionResponse[];
  usageWindowDays: number;
}

export function toDispositionResponse(disposition: Disposition): DispositionResponse {
  return {
    id: disposition.id,
    code: disposition.code,
    label: disposition.label,
    category: disposition.category,
    noteRequired: disposition.noteRequired,
    followUpRequired: disposition.followUpRequired,
    active: disposition.active,
    position: disposition.position,
    usageCount90d: null,
  };
}

export function toDispositionListResponse(
  dispositions: readonly Disposition[],
): DispositionListResponse {
  return {
    items: dispositions.map(toDispositionResponse),
    usageWindowDays: USAGE_WINDOW_DAYS,
  };
}
