'use client';

import { useEffect, useState } from 'react';
import { loadMyCapabilities, mayInAnyProgramme, type Capabilities } from './capabilities-api';

/**
 * The caller's capabilities, or `null` while the read is in flight or when it
 * failed. A screen draws its write controls on `null` (the API's 403 is the
 * gate); it hides them only on an answer that says no.
 */
export function useCapabilities(): Capabilities | null {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => {
    let live = true;
    void loadMyCapabilities().then((value) => {
      if (live) setCapabilities(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return capabilities;
}

/** False only when the API said the caller holds `action` nowhere they reach. */
export function useMayInAnyProgramme(action: string): boolean {
  const capabilities = useCapabilities();
  return capabilities === null ? true : mayInAnyProgramme(capabilities, action);
}
