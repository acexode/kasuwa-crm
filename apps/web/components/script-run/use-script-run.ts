'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScriptLocale, ScriptVersion } from '../../lib/script-graph';
import {
  acknowledgeScriptRunNode,
  advanceScriptRun,
  getMe,
  getRunContact,
  getScriptRun,
  getScriptRunScript,
  recordScriptRunAnswers,
  type AnswerValue,
  type Me,
  type RunContact,
  type ScriptRun,
} from '../../lib/script-runs-api';
import type { ScriptingError, ScriptingResult } from '../../lib/scripting-http';
import { STILL_CONNECTING_MS } from '../admin/use-resource';

/**
 * One run, as the agent's screen holds it (T-0116), IN MEMORY ONLY.
 *
 * The run and the version it is pinned to are read together; the contact and
 * the signed-in agent too, for the wording's variables. A reload resumes from
 * the server (R1): nothing about a run, its answers above all (D-L93), is
 * ever put on the device, in the address bar or in a log.
 *
 * NOTHING OPTIMISTIC. The run on screen is the one the server last served. A
 * write's answer replaces it; a refusal leaves it as it was, and a 409
 * re-reads it so the next attempt carries a real revision (R7). Nothing is
 * retried by itself, and offline nothing is sent or queued (D-P21).
 */

export type RunPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';

export interface ScriptRunState {
  readonly phase: RunPhase;
  readonly slow: boolean;
  readonly online: boolean;
  readonly run: ScriptRun | null;
  readonly version: ScriptVersion | null;
  readonly contact: RunContact | null;
  readonly me: Me | null;
  readonly busy: boolean;
  readonly error: ScriptingError | null;
  /** When the run on screen was last read or written: what the offline banner says. */
  readonly syncedAt: Date | null;
  readonly reload: () => void;
  readonly reread: () => Promise<ScriptRun | null>;
  readonly accept: (run: ScriptRun) => void;
  readonly clearError: () => void;
  readonly advance: (choiceKey?: string) => Promise<ScriptingResult<ScriptRun>>;
  readonly acknowledge: (nodeId: string, locale: ScriptLocale) => Promise<ScriptingResult<ScriptRun>>;
  readonly answer: (nodeId: string, values: Readonly<Record<string, AnswerValue>>) => Promise<ScriptingResult<ScriptRun>>;
}

const OFFLINE: ScriptingResult<never> = { ok: false, error: { code: 'network', status: 0, details: [] } };

export function useScriptRun(id: string): ScriptRunState {
  const [phase, setPhase] = useState<RunPhase>('loading');
  const [slow, setSlow] = useState(false);
  const [online, setOnline] = useState(true);
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [version, setVersion] = useState<ScriptVersion | null>(null);
  const [contact, setContact] = useState<RunContact | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScriptingError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  // The run a write that follows another reads its revision from, synchronously.
  const current = useRef<ScriptRun | null>(null);
  const writing = useRef(false);

  const accept = useCallback((next: ScriptRun) => {
    current.current = next;
    setRun(next);
    setSyncedAt(new Date());
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    void (async () => {
      const [runResult, scriptResult, meResult] = await Promise.all([
        getScriptRun(id, controller.signal),
        getScriptRunScript(id, controller.signal),
        getMe(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (meResult.ok) setMe(meResult.value);
      if (!runResult.ok || !scriptResult.ok) {
        window.clearTimeout(timer);
        const missing = (!runResult.ok && runResult.error.code === 'not_found') || (!scriptResult.ok && scriptResult.error.code === 'not_found');
        setPhase(missing ? 'not-found' : 'unavailable');
        return;
      }
      const contactResult = await getRunContact(runResult.value.contactId, controller.signal);
      if (controller.signal.aborted) return;
      window.clearTimeout(timer);
      setContact(contactResult.ok ? contactResult.value : null);
      setVersion(scriptResult.value);
      accept(runResult.value);
      setPhase('ready');
    })();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, attempt, accept]);

  const reread = useCallback(async (): Promise<ScriptRun | null> => {
    const result = await getScriptRun(id);
    if (result.ok) {
      accept(result.value);
      return result.value;
    }
    return null;
  }, [id, accept]);

  /** One run write: the revision last served, the answer accepted, a 409 re-read. */
  const write = useCallback(
    async (send: (run: ScriptRun) => Promise<ScriptingResult<ScriptRun>>): Promise<ScriptingResult<ScriptRun>> => {
      const held = current.current;
      if (held === null || writing.current || !navigator.onLine) return OFFLINE;
      writing.current = true;
      setBusy(true);
      setError(null);
      const result = await send(held);
      if (result.ok) {
        accept(result.value);
      } else {
        setError(result.error);
        if (result.error.status === 409) await reread();
      }
      writing.current = false;
      setBusy(false);
      return result;
    },
    [accept, reread],
  );

  const advance = useCallback(
    (choiceKey?: string) =>
      write((held) => advanceScriptRun(held.id, choiceKey === undefined ? { revision: held.revision } : { revision: held.revision, choiceKey })),
    [write],
  );

  const acknowledge = useCallback(
    (nodeId: string, locale: ScriptLocale) => write((held) => acknowledgeScriptRunNode(held.id, { revision: held.revision, nodeId, locale })),
    [write],
  );

  const answer = useCallback(
    (nodeId: string, values: Readonly<Record<string, AnswerValue>>) =>
      write((held) => recordScriptRunAnswers(held.id, { revision: held.revision, nodeId, values })),
    [write],
  );

  return {
    phase,
    slow,
    online,
    run,
    version,
    contact,
    me,
    busy,
    error,
    syncedAt,
    reload: () => setAttempt((value) => value + 1),
    reread,
    accept,
    clearError: () => setError(null),
    advance,
    acknowledge,
    answer,
  };
}
