import { z } from 'zod';
import { SPANS, WIDGET_TYPES, type HomeRole, type Layout } from './home-model';

/**
 * Where a person's customised Home layout is kept (T-0132).
 *
 * D-L196 names a per-user, tenant-scoped table. Until it exists this is the
 * browser's own storage, keyed by the user's id, behind this small interface
 * so the table replaces it without the screen changing: `load` and `save` are
 * already asynchronous, as a server round trip will be.
 *
 * WHAT IS KEPT. Widget types and widths only: no record, name, number or
 * anything else read from the API. The key is the user's id from
 * getCurrentUser, so two people on one shared phone keep their own layouts and
 * neither sees the other's. The stored value is parsed, never cast: a value
 * from an older shape, another tab or a hand edit is ignored and the role's
 * default is drawn instead.
 */
export interface HomeLayoutStore {
  load(userId: string, role: HomeRole): Promise<Layout | null>;
  save(userId: string, role: HomeRole, layout: Layout): Promise<void>;
  clear(userId: string, role: HomeRole): Promise<void>;
}

const Stored = z.object({
  version: z.literal(1),
  role: z.enum(['rep', 'manager', 'support', 'bpo', 'exec']),
  items: z
    .array(
      z.object({
        type: z.enum(WIDGET_TYPES),
        span: z.union([z.literal(SPANS[0]), z.literal(SPANS[1]), z.literal(SPANS[2]), z.literal(SPANS[3])]),
      }),
    )
    .max(WIDGET_TYPES.length),
});

const KEY_PREFIX = 'kasuwa.home.layout:';

function key(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** Storage can be absent, full or refused (a private window); Home then simply keeps the layout for this visit. */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const browserLayoutStore: HomeLayoutStore = {
  load(userId, role) {
    const raw = storage()?.getItem(key(userId)) ?? null;
    if (raw === null) return Promise.resolve(null);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return Promise.resolve(null);
    }
    const parsed = Stored.safeParse(value);
    // A layout saved under another role is not this person's layout for this one.
    return Promise.resolve(parsed.success && parsed.data.role === role ? parsed.data.items : null);
  },
  save(userId, role, layout) {
    try {
      storage()?.setItem(key(userId), JSON.stringify({ version: 1, role, items: layout }));
    } catch {
      // Full or refused: the layout lasts for this visit only.
    }
    return Promise.resolve();
  },
  clear(userId) {
    try {
      storage()?.removeItem(key(userId));
    } catch {
      // Nothing to clear.
    }
    return Promise.resolve();
  },
};
