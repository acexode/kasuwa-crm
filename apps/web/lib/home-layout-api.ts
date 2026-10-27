import * as z from 'zod/mini';
import { SPANS, WIDGET_TYPES } from '../components/home/home-model';
import { requestRecords, type RecordsResult } from './records-request';

/**
 * The caller's own Home layout (T-0159, D-L196): `getHomeLayout`,
 * `putHomeLayout` and `deleteHomeLayout` in `docs/api/records.openapi.yaml`.
 *
 * Apart from the other records clients so that only Home ships it. The session
 * decides whose layout it is: there is no user, tenant or programme argument
 * anywhere here, and the body is exactly `{ role, items }`.
 *
 * What is held is widget types and widths, nothing read from a record. The
 * widget list and the widths are `home-model.ts`'s, the one copy on this side.
 */
export const HOME_LAYOUT_PATH = '/api/v1/me/home-layout';

const HomeLayoutWire = z.object({
  role: z.enum(['rep', 'manager', 'support', 'bpo', 'exec']),
  items: z.array(
    z.object({
      type: z.enum(WIDGET_TYPES),
      span: z.union([z.literal(SPANS[0]), z.literal(SPANS[1]), z.literal(SPANS[2]), z.literal(SPANS[3])]),
    }),
  ),
});
export type HomeLayoutWire = z.infer<typeof HomeLayoutWire>;

/** 200 with the saved layout; `not_found` when nothing is saved. */
export function getHomeLayout(): Promise<RecordsResult<HomeLayoutWire>> {
  return requestRecords(HOME_LAYOUT_PATH, HomeLayoutWire);
}

/** Replaces the saved layout. */
export function putHomeLayout(layout: HomeLayoutWire): Promise<RecordsResult<HomeLayoutWire>> {
  return requestRecords(HOME_LAYOUT_PATH, HomeLayoutWire, {
    method: 'PUT',
    body: { role: layout.role, items: layout.items.map((item) => ({ type: item.type, span: item.span })) },
  });
}

/** Reset: deletes the saved layout; 204 whether or not one existed. */
export function deleteHomeLayout(): Promise<RecordsResult<null>> {
  return requestRecords(HOME_LAYOUT_PATH, z.null(), { method: 'DELETE' });
}
