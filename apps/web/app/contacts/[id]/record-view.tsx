'use client';

import { useEffect, useState } from 'react';
import type { MessageBundle } from '@kasuwa/i18n';
import { createBundleTranslator } from '@kasuwa/i18n';

/**
 * A record route, and the first one in `apps/web`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS, BECAUSE IT IS NOT A DESIGNED SCREEN
 *
 * T-0008 wrote a tenancy e2e test that tampers with three URLs and asserts
 * three byte-identical 404s — but it could only do it against the API origin,
 * because `apps/web` had one page and no id anywhere in a URL. It said so in
 * writing and handed the other half to whoever landed the first screens.
 *
 * The half that was missing is the one that matters. The leak this guards
 * against is a CLIENT router that fetches a record by id and renders it before
 * the server has checked scope: every server-side test passes, and a user who
 * edits the address bar sees another tenant's customer. So the fetch here is
 * exactly the naive one — `GET /api/v1/contacts/{id}` straight from the
 * browser, with whatever identity the session carries — and the assertion is
 * that the server refuses it identically whether the record belongs to another
 * tenant, to another programme in the SAME tenant, or to nobody at all.
 *
 * It renders NOTHING about a record it could not fetch. Not the id, not a
 * "this record is in another workspace" — that sentence is the existence leak
 * `CLAUDE.md` section 6.4 forbids, spelled out in a friendly tone.
 *
 * This is scaffolding until M4 builds the real contact screen, and it should be
 * replaced rather than extended.
 * ---------------------------------------------------------------------------
 */
export function RecordView({
  id,
  locale,
  messages,
}: {
  id: string;
  locale: string;
  messages: MessageBundle;
}) {
  const t = createBundleTranslator(locale, messages);
  const [state, setState] = useState<'loading' | 'found' | 'missing'>('loading');
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/v1/contacts/${encodeURIComponent(id)}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          setState('missing');
          return;
        }
        const payload: unknown = await response.json();
        // `GET /contacts/:id` returns the record itself; the collection wraps
        // its rows in `data`. Both shapes are read rather than assumed,
        // because getting it wrong here fails as a BLANK page rather than as
        // an error, which is the hardest kind of wrong to see in a screenshot.
        const record =
          typeof payload === 'object' && payload !== null && 'data' in payload
            ? (payload as { data?: unknown }).data
            : payload;
        const name =
          typeof record === 'object' && record !== null
            ? (record as { displayName?: unknown }).displayName
            : undefined;

        if (typeof name !== 'string' || name === '') {
          setState('missing');
          return;
        }
        setDisplayName(name);
        setState('found');
      } catch {
        setState('missing');
      }
    })();

    return () => controller.abort();
  }, [id]);

  if (state === 'loading') {
    return (
      <p role="status" data-testid="record-loading" className="text-body-md text-text-2">
        {t.t('auth.slow.loading')}
      </p>
    );
  }

  if (state === 'missing') {
    // Identical for "another tenant", "another programme" and "never existed".
    // The e2e test compares the rendered text of all three.
    return (
      <section data-testid="record-not-found" className="flex flex-col gap-3">
        <h1 className="text-h3 text-text">{t.t('notFound.title')}</h1>
        <p className="text-body-md text-text-2">{t.t('notFound.body')}</p>
      </section>
    );
  }

  return (
    <section data-testid="record" className="flex flex-col gap-3">
      <h1 className="text-h3 text-text">{displayName}</h1>
    </section>
  );
}
