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

/**
 * One read of the name. A refusal's body is cancelled, never left unread: an
 * unread body keeps the request open in the browser, so the page never
 * settles (every shell page's byte budget waited on it forever, T-0148).
 */
export async function readShellUserName(): Promise<string | null> {
  const response = await apiFetch('/api/v1/auth/me');
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return Me.parse(await response.json()).displayName;
}

function load(): Promise<string | null> {
  if (pending === null) {
    pending = readShellUserName()
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
