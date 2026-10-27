import { deleteHomeLayout, getHomeLayout, putHomeLayout } from '../../lib/home-layout-api';
import type { HomeLayoutStore } from './layout-store';

/**
 * The Home layout kept per user on the server (T-0159, D-L196), behind the
 * same `HomeLayoutStore` interface as the browser's storage, chosen by the flag
 * `home_layout_server` (read on the server and passed to the screen as a boolean).
 *
 * The session decides whose layout it is, so `userId` is not sent: it is only
 * part of the interface, which the browser store needs for its key. A layout
 * saved under another role is not this person's layout for this one, as in the
 * browser store.
 *
 * NEVER THROWS, as the browser store never does: a refusal or a dropped
 * connection loads nothing (Home draws the role's default) and saves nothing
 * (the layout lasts for this visit). Nothing here logs.
 */
export const serverLayoutStore: HomeLayoutStore = {
  async load(_userId, role) {
    const result = await getHomeLayout();
    return result.ok && result.value.role === role ? result.value.items : null;
  },
  async save(_userId, role, layout) {
    await putHomeLayout({ role, items: layout.map((item) => ({ type: item.type, span: item.span })) });
  },
  async clear() {
    await deleteHomeLayout();
  },
};
