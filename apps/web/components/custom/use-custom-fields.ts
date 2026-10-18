'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { listActiveCustomFields, type CustomField, type CustomObject } from '../../lib/custom-values-api';

/**
 * The custom-field definitions one screen holds, read once when it opens and
 * only where the server page said the feature is on (`enabled`, a prop: no
 * client module evaluates a flag).
 *
 * A failed read leaves `fields` EMPTY: the record stays on screen and no custom
 * value is drawn, because a value with no definition has no type, label or
 * currency (C9). Definitions live in memory only (D-P21). `reload` reads them
 * again, for a screen told `unknown_field` (a definition retired meanwhile).
 *
 * `readOnly` is what the API has told this session is not editable. There is
 * no capability read (D-L84), so a key becomes read-only only after a
 * `403 field_not_editable`, and it is never sent again (C4). It lives in a
 * `ReadOnlyStore` the SCREEN owns, so it survives a form being closed and
 * opened again.
 */
export interface ReadOnlyStore {
  readonly readOnly: ReadonlySet<string>;
  readonly markReadOnly: (keys: readonly string[]) => void;
}

export interface CustomContext extends ReadOnlyStore {
  readonly fields: readonly CustomField[];
  readonly reload: () => void;
}

const NONE: readonly CustomField[] = [];

export function useReadOnlyKeys(): ReadOnlyStore {
  const [readOnly, setReadOnly] = useState<ReadonlySet<string>>(new Set());
  const markReadOnly = useCallback((keys: readonly string[]) => {
    if (keys.length === 0) return;
    setReadOnly((held) => new Set([...held, ...keys]));
  }, []);
  return useMemo(() => ({ readOnly, markReadOnly }), [readOnly, markReadOnly]);
}

export function useCustomFields(object: CustomObject, enabled: boolean, shared?: ReadOnlyStore): CustomContext {
  const [fields, setFields] = useState<readonly CustomField[]>(NONE);
  const [attempt, setAttempt] = useState(0);
  const own = useReadOnlyKeys();
  const store = shared ?? own;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    void listActiveCustomFields(object, controller.signal).then((list) => {
      if (!controller.signal.aborted) setFields(list ?? NONE);
    });
    return () => controller.abort();
  }, [object, enabled, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return useMemo(() => ({ fields, readOnly: store.readOnly, markReadOnly: store.markReadOnly, reload }), [fields, store, reload]);
}
