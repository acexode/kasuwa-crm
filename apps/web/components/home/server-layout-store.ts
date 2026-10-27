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
 * NEVER THROWS, as the browser store never does. "Nothing saved" (404) is told
 * apart from "could not read" (network error, 5xx): after a failed read Home
 * draws the default but this store does NOT write over the server until a read
 * has succeeded, or it would replace the person's real layout with the default
 * plus one edit. A save after a failed read retries the read first, and skips
 * the write if that fails too. Reset (clear) is an explicit choice and always goes.
 * Nothing here logs.
 */
export function createServerLayoutStore(): HomeLayoutStore {
  let readSucceeded = false;

  async function read() {
    const result = await getHomeLayout();
    if (result.ok) {
      readSucceeded = true;
      return result.value;
    }
    if (result.error.code === 'not_found') readSucceeded = true;
    return null;
  }

  return {
    async load(_userId, role) {
      const saved = await read();
      return saved !== null && saved.role === role ? saved.items : null;
    },
    async save(_userId, role, layout) {
      if (!readSucceeded) {
        await read();
        if (!readSucceeded) return;
      }
      await putHomeLayout({ role, items: layout.map((item) => ({ type: item.type, span: item.span })) });
    },
    async clear() {
      await deleteHomeLayout();
    },
  };
}

export const serverLayoutStore: HomeLayoutStore = createServerLayoutStore();
