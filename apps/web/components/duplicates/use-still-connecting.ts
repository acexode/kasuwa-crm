'use client';

import { useEffect, useState } from 'react';
import { STILL_CONNECTING_MS } from '../admin/use-resource';

/**
 * "Still connecting" (the 256 kbps NFR made visible): true once `active` has
 * been true for four seconds without a break. A sentence and an offer of
 * low-bandwidth mode, never a bare spinner.
 */
export function useStillConnecting(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return slow;
}
