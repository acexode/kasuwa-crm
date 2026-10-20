'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../../lib/api-fetch';

/**
 * The signed-in person's display name, for the shells' avatar (T-0130).
 *
 * Read once per page load from `/api/v1/auth/me` and kept in this module, so a
 * client-side move between screens (each mounts its own shell) does not ask
 * again or flash the fallback. Until it arrives, or if it never does on a
 * dropped link, the avatar draws a person glyph instead of initials: never a
 * made-up name. The name is the person's own and is never logged.
 */
const Me = z.object({ displayName: z.string() });

let known: string | null = null;
let pending: Promise<string | null> | null = null;

function load(): Promise<string | null> {
  if (pending === null) {
    pending = apiFetch('/api/v1/auth/me')
      .then(async (response) => (response.ok ? Me.parse(await response.json()).displayName : null))
      .catch(() => null)
      .then((name) => {
        known = name;
        // A failed read is retried by the next shell that mounts.
        if (name === null) pending = null;
        return name;
      });
  }
  return pending;
}

export function useShellUserName(): string | null {
  const [name, setName] = useState<string | null>(known);
  useEffect(() => {
    if (known !== null) {
      setName(known);
      return undefined;
    }
    let mounted = true;
    void load().then((value) => {
      if (mounted) setName(value);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return name;
}
