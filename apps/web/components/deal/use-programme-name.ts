'use client';

import { useEffect, useState } from 'react';
import { listMyProgrammes } from '../../lib/my-programmes-api';

/**
 * The name of one of the caller's own programmes (T-0161, D-L204), for the deal
 * breadcrumb: two pipelines can share a name in different programmes, and the
 * detail never lists pipelines, so the breadcrumb says which programme this
 * one belongs to. Read once from `listMyProgrammes`, which the session scopes:
 * there is no way to ask for a programme the caller is not in.
 *
 * `null` until it is known, and for good if the read fails or the programme is
 * not among the caller's own (a deal can be reached through a programme the
 * caller has since left). The breadcrumb then names the pipeline alone, as
 * before: a missing name never blocks the screen and is never an id.
 */
export function useProgrammeName(programmeId: string): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void listMyProgrammes().then((result) => {
      if (!current) return;
      setName(result.ok ? (result.value.find((programme) => programme.id === programmeId)?.name ?? null) : null);
    });
    return () => {
      current = false;
    };
  }, [programmeId]);

  return name;
}
