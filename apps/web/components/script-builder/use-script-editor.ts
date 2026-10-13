'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SCRIPT_LOCALES, type ScriptGraph, type ScriptVersion } from '../../lib/script-graph';
import {
  getScript,
  getScriptVersion,
  listAuthorDispositions,
  publishScript,
  putScriptTranslation,
  updateScript,
  type AuthorDisposition,
  type Script,
} from '../../lib/scripting-api';
import type { ScriptingError } from '../../lib/scripting-http';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import {
  changedFields,
  changedLocales,
  hasChanges,
  publishProblems,
  rebase,
  translationBody,
  type DraftState,
  type PublishProblem,
  type TranslationEdits,
} from './builder-model';
import { useOnline } from './use-online';

/**
 * One script's draft as the builder holds it (T-0115), IN MEMORY ONLY: never
 * on the device, and never saved behind the author's back (R4).
 *
 *   served — the script as the server last answered it: the base every save
 *            is judged against (D-L102) and the `revision` it carries.
 *   draft  — the author's edits, name and graph.
 *   edits  — translated wording typed per locale, laid over the served
 *            translations and PUT whole for each locale that changed (R10).
 *
 * A 409 re-reads the script and REBASES: the fresh draft with this person's
 * edits re-applied node by node, a field both people changed keeping the
 * typed value and named in `conflicts`. Nothing is retried by itself.
 */

export type EditorPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';

export type EditorNotice =
  | { readonly kind: 'error'; readonly error: ScriptingError }
  | { readonly kind: 'invalid'; readonly problems: readonly PublishProblem[] }
  | { readonly kind: 'saved' }
  | { readonly kind: 'published'; readonly number: number };

export interface ScriptEditorState {
  readonly phase: EditorPhase;
  readonly slow: boolean;
  readonly online: boolean;
  readonly syncedAt: Date | null;
  readonly served: Script | null;
  readonly draft: DraftState | null;
  readonly edits: TranslationEdits;
  readonly conflicts: Readonly<Record<string, readonly string[]>>;
  readonly latest: ScriptVersion | null;
  readonly dispositions: readonly AuthorDisposition[];
  readonly busy: 'save' | 'publish' | null;
  readonly notice: EditorNotice | null;
  readonly invalid: ReadonlySet<string>;
  readonly dirty: boolean;
  readonly reload: () => void;
  readonly setName: (name: string) => void;
  readonly setGraph: (change: (graph: ScriptGraph) => ScriptGraph) => void;
  readonly setTranslation: (locale: string, nodeId: string, text: string) => void;
  readonly save: () => Promise<void>;
  readonly publish: (changes: readonly string[]) => Promise<boolean>;
  readonly dismiss: () => void;
}

function draftOf(script: Script): DraftState {
  return { name: script.name, graph: script.draft.graph };
}

export function useScriptEditor(id: string): ScriptEditorState {
  const online = useOnline();
  const [phase, setPhase] = useState<EditorPhase>('loading');
  const [slow, setSlow] = useState(false);
  const [served, setServed] = useState<Script | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [edits, setEdits] = useState<TranslationEdits>({});
  const [conflicts, setConflicts] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [latest, setLatest] = useState<ScriptVersion | null>(null);
  const [dispositions, setDispositions] = useState<readonly AuthorDisposition[]>([]);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Read synchronously by a save that follows another write in the same press.
  const servedRef = useRef<Script | null>(null);
  const draftRef = useRef<DraftState | null>(null);
  const editsRef = useRef<TranslationEdits>({});

  const acceptServed = useCallback((script: Script) => {
    servedRef.current = script;
    setServed(script);
    setSyncedAt(new Date());
  }, []);

  const setDraftBoth = useCallback((next: DraftState) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const setEditsBoth = useCallback((next: TranslationEdits) => {
    editsRef.current = next;
    setEdits(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    void (async () => {
      const result = await getScript(id, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        window.clearTimeout(timer);
        setPhase(result.error.code === 'not_found' ? 'not-found' : 'unavailable');
        return;
      }
      const script = result.value;
      // The compliance diff's base and the end nodes' dispositions, together.
      const [version, live] = await Promise.all([
        script.latestVersion === null ? Promise.resolve(null) : getScriptVersion(script.id, script.latestVersion.id, controller.signal),
        listAuthorDispositions(script.programmeId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      window.clearTimeout(timer);
      setLatest(version !== null && version.ok ? version.value : null);
      setDispositions(live.ok ? live.value : []);
      acceptServed(script);
      setDraftBoth(draftOf(script));
      setEditsBoth({});
      setConflicts({});
      setPhase('ready');
    })();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, attempt, acceptServed, setDraftBoth, setEditsBoth]);

  /** After a 409: the fresh draft, this person's edits re-applied (D-L102). */
  const rebaseOnto = useCallback(async (): Promise<void> => {
    const base = servedRef.current;
    const local = draftRef.current;
    const fresh = await getScript(id);
    if (!fresh.ok || base === null || local === null) return;
    const rebased = rebase(draftOf(base), local, draftOf(fresh.value));
    acceptServed(fresh.value);
    setDraftBoth(rebased.draft);
    setConflicts(rebased.conflicts);
  }, [id, acceptServed, setDraftBoth]);

  const save = useCallback(async () => {
    if (busy !== null || !navigator.onLine) return;
    const start = servedRef.current;
    const local = draftRef.current;
    if (start === null || local === null) return;
    setBusy('save');
    setNotice(null);
    let current = start;
    const changed = changedFields(local, draftOf(start));
    if (hasChanges(changed)) {
      const result = await updateScript(start.id, { revision: start.revision, ...changed });
      if (!result.ok) {
        setNotice({ kind: 'error', error: result.error });
        if (result.error.status === 409) await rebaseOnto();
        setBusy(null);
        return;
      }
      current = result.value;
      acceptServed(current);
      // What the author typed while the save was in flight stays theirs.
      if (draftRef.current === local) setDraftBoth(draftOf(current));
      setConflicts({});
      setInvalid(new Set());
    }
    for (const locale of changedLocales(SCRIPT_LOCALES, current.draft.translations, editsRef.current)) {
      if (locale === current.sourceLocale) continue;
      const texts = translationBody(current.draft.translations[locale], editsRef.current[locale]);
      const result = await putScriptTranslation(current.id, locale as (typeof SCRIPT_LOCALES)[number], { revision: current.revision, texts });
      if (!result.ok) {
        setNotice({ kind: 'error', error: result.error });
        if (result.error.status === 409) await rebaseOnto();
        setBusy(null);
        return;
      }
      current = result.value;
      acceptServed(current);
      const rest: Record<string, Readonly<Record<string, string>>> = { ...editsRef.current };
      delete rest[locale];
      setEditsBoth(rest);
    }
    setNotice({ kind: 'saved' });
    setBusy(null);
  }, [busy, acceptServed, rebaseOnto, setDraftBoth, setEditsBoth]);

  const publish = useCallback(
    async (changes: readonly string[]): Promise<boolean> => {
      const current = servedRef.current;
      if (busy !== null || current === null || !navigator.onLine) return false;
      setBusy('publish');
      setNotice(null);
      const result = await publishScript(current.id, changes.length === 0 ? { revision: current.revision } : { revision: current.revision, changes });
      setBusy(null);
      if (result.ok) {
        const version = result.value;
        setLatest(version);
        acceptServed({
          ...current,
          hasUnpublishedChanges: false,
          latestVersion: { id: version.id, number: version.number, publishedAt: version.publishedAt, publishedBy: version.publishedBy },
        });
        setInvalid(new Set());
        setNotice({ kind: 'published', number: version.number });
        return true;
      }
      if (result.error.code === 'script_invalid') {
        const problems = publishProblems(result.error.details);
        setInvalid(new Set(problems.flatMap((problem) => (problem.nodeId === null ? [] : [problem.nodeId]))));
        setNotice({ kind: 'invalid', problems });
        return false;
      }
      setNotice({ kind: 'error', error: result.error });
      if (result.error.status === 409) await rebaseOnto();
      return false;
    },
    [busy, acceptServed, rebaseOnto],
  );

  const dirty =
    served !== null &&
    draft !== null &&
    (hasChanges(changedFields(draft, draftOf(served))) || changedLocales(SCRIPT_LOCALES, served.draft.translations, edits).length > 0);

  return {
    phase,
    slow,
    online,
    syncedAt,
    served,
    draft,
    edits,
    conflicts,
    latest,
    dispositions,
    busy,
    notice,
    invalid,
    dirty,
    reload: () => setAttempt((value) => value + 1),
    setName: (name) => {
      const current = draftRef.current;
      if (current !== null) setDraftBoth({ ...current, name });
    },
    setGraph: (change) => {
      const current = draftRef.current;
      if (current !== null) setDraftBoth({ ...current, graph: change(current.graph) });
    },
    setTranslation: (locale, nodeId, text) => {
      setEditsBoth({ ...editsRef.current, [locale]: { ...(editsRef.current[locale] ?? {}), [nodeId]: text } });
    },
    save,
    publish,
    dismiss: () => setNotice(null),
  };
}
