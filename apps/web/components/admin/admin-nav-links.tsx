'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The settings-menu entries whose route exists but is gated by a flag this
 * process has ON. The server layout (`app/admin/layout.tsx`) reads the flags and
 * passes down ids only: a `'use client'` module never evaluates a flag, and the
 * browser can never switch one on.
 *
 * Context rather than a prop on `AdminShell`, because six screens render the
 * shell and each one would otherwise have to remember to thread it through —
 * and the one that forgot would draw a menu that disagrees with its neighbours.
 * The default is "none linked", so an entry is a link only when something said
 * it is safe to be one.
 */
const LinkedSettings = createContext<readonly string[]>([]);

export function AdminNavLinksProvider({
  settingIds,
  children,
}: {
  settingIds: readonly string[];
  children: ReactNode;
}) {
  return <LinkedSettings.Provider value={settingIds}>{children}</LinkedSettings.Provider>;
}

export function useFlaggedSettingIds(): readonly string[] {
  return useContext(LinkedSettings);
}
