'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON } from '../auth/button-classes';
import { listContactScripts, startScriptRun, type RunnableScript } from '../../lib/script-runs-api';
import type { ScriptingError } from '../../lib/scripting-http';

/**
 * `P10/04` — the contact's runnable scripts, read when the start control
 * opens (R2), keyset paged on `nextCursor` (a short page is not the last),
 * with no count (D-P13). Choosing one starts the run with exactly
 * `{ scriptId, contactId }`: the server pins the version and the programme,
 * and answers 200 with the run already in progress when there is one (the
 * idempotent resume). The run then has its own route (R1).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MenuState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly RunnableScript[];
  readonly cursor: string | null;
  readonly more: boolean;
}

export function ScriptMenu({
  t,
  contactId,
  offline,
  onClose,
}: {
  t: Translator;
  contactId: string;
  offline: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<MenuState>({ phase: 'loading', rows: [], cursor: null, more: false });
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<ScriptingError | null>(null);
  const reading = useRef(false);

  const read = (cursor: string | null, rows: readonly RunnableScript[]) => {
    if (reading.current) return;
    reading.current = true;
    setState((current) => ({ ...current, more: cursor !== null }));
    void listContactScripts(contactId, cursor).then((result) => {
      reading.current = false;
      if (!result.ok) {
        setState({ phase: 'error', rows, cursor, more: false });
        return;
      }
      const seen = new Set(rows.map((row) => row.id));
      setState({
        phase: 'ready',
        rows: [...rows, ...result.value.data.filter((row) => !seen.has(row.id))],
        cursor: result.value.nextCursor,
        more: false,
      });
    });
  };

  useEffect(() => {
    // Read once, when the menu opens.
    read(null, []);
  }, []);

  const start = async (scriptId: string) => {
    setStarting(scriptId);
    setError(null);
    const result = await startScriptRun(scriptId, contactId);
    if (result.ok && UUID.test(result.value.id)) {
      router.push(`/script-runs/${result.value.id}`);
      return;
    }
    setStarting(null);
    setError(result.ok ? { code: 'network', status: 0, details: [] } : result.error);
  };

  return (
    <section
      data-testid="script-menu"
      aria-label={t.t('scripting.start.menu')}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body-md font-bold">{t.t('scripting.start.menu')}</h2>
        <button type="button" onClick={onClose} className={QUIET_BUTTON} aria-label={t.t('scripting.start.close')}>
          <Icon name="close" size="sm" />
        </button>
      </div>
      {state.phase === 'loading' ? (
        <p role="status" className="text-body-sm text-text-2">
          {t.t('scripting.start.loading')}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t('scripting.start.failed')}
        </p>
      ) : null}
      {state.phase === 'ready' && state.rows.length === 0 ? (
        <p data-testid="script-menu-empty" className="text-body-sm text-text-2">
          {t.t('scripting.start.empty')}
        </p>
      ) : null}
      {state.rows.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {state.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                data-runnable-script={row.id}
                data-requires-connection=""
                disabled={offline || starting !== null}
                aria-busy={starting === row.id}
                onClick={() => void start(row.id)}
                className="flex min-h-touch w-full flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-start text-body-md hover:bg-surface-sunken disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span data-script-text="" className="min-w-0 break-words font-semibold">
                  {row.name}
                </span>
                <span className="text-caption text-text-muted">{t.t('scripting.start.version', { number: row.latestVersion.number })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.cursor !== null && state.phase === 'ready' ? (
        <button
          type="button"
          data-testid="script-menu-more"
          disabled={state.more}
          onClick={() => read(state.cursor, state.rows)}
          className={`${QUIET_BUTTON} self-start disabled:opacity-60`}
        >
          {t.t('scripting.start.more')}
        </button>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-2 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(`scripting.error.${error.code}` as MessageId)}
        </p>
      )}
    </section>
  );
}
