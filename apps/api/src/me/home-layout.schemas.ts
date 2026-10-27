import { z } from 'zod';

/**
 * The boundary schema for `PUT /api/v1/me/home-layout` (T-0159;
 * `HomeLayout` in docs/api/records.openapi.yaml).
 *
 * CLOSED, at both levels: a key the contract does not name (a `userId`,
 * `tenantId`, `programmeId`, a colour) is a ZodError, which the admin filter
 * answers as `400 validation_failed`. Details name a path and a reason code,
 * never the submitted value.
 *
 * THE VOCABULARY LIVES IN TWO PLACES. The web's `home-model.ts` owns the widget
 * list and the grid widths (the design's own tables); an API cannot import from
 * an app, so the same two lists are repeated here and `home-layout.schemas.test.ts`
 * pins them to the web's copy. If the web adds a widget and not this list, that
 * test fails and so does the CI run, not a user's save.
 */
export const HOME_WIDGET_TYPES = [
  'nba',
  'agenda',
  'deals',
  'quota',
  'wa',
  'pipeline',
  'forecast',
  'leader',
  'approvals',
  'tickets',
  'queues',
  'csat',
  'programme',
  'schedule',
  'news',
  'revenue',
  'cost',
  'profit',
  'sla',
  'ai',
] as const;

/** The widths of a 12-column grid. */
export const HOME_SPANS = [4, 6, 8, 12] as const;

export const HOME_ROLES = ['rep', 'manager', 'support', 'bpo', 'exec'] as const;

/** At most this many slots (the contract's `maxItems`, and the table's CHECK). */
export const HOME_LAYOUT_MAX_ITEMS = 19;

const Span = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(12)]);

export const HomeLayoutBody = z
  .object({
    role: z.enum(HOME_ROLES),
    items: z
      .array(z.object({ type: z.enum(HOME_WIDGET_TYPES), span: Span }).strict())
      .max(HOME_LAYOUT_MAX_ITEMS),
  })
  .strict();
export type HomeLayoutBody = z.infer<typeof HomeLayoutBody>;
