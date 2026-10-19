'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from '../admin/dialog';
import { StillConnecting } from '../admin/panel';
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { createContactMerge, getContactMergePreview, listContactMerges, undoContactMerge } from '../../lib/duplicates-api';
import { mergeRefusal, undoRefusal } from './duplicates-model';
import { findOwnMerge, mergeBody, mergeReducer, startMerge } from './merge-model';
import { PersonName, Skeleton } from './duplicates-parts';
import { MergeCompare } from './merge-compare';
import { MergeResult } from './merge-result';
import { useStillConnecting } from './use-still-connecting';

/**
 * C1 — the side-by-side merge of one pair. Pick the main record (the survivor),
 * read its preview the other way round whenever that changes, pick per field,
 * confirm, and keep an Undo for the 30 days the API allows.
 *
 * ONE REQUEST PER CONFIRMATION. The send is guarded synchronously, so two
 * activations in one tick (a double click) are one merge. Every state change
 * the API causes is in `mergeReducer` (`merge-model.ts`), which is where
 * it is tested; this file wires it to the network and draws it.
 *
 * Leaving cancels the preview read in flight. A merge or an undo already sent
 * is not cancelled (a half-cancelled write is worse than a late one); its
 * answer is simply not drawn once the screen has gone.
 */
export function MergeView({
  t,
  locale,
  pair,
  onBack,
  onMessage,
}: {
  t: Translator;
  locale: string;
  pair: readonly [string, string];
  /** `dirty`: a merge or an undo happened, so the sets and the history are read again. */
  onBack: (dirty: boolean) => void;
  onMessage: (message: MessageId | null) => void;
}) {
  const [view, dispatch] = useReducer(mergeReducer, pair, startMerge);
  const [confirming, setConfirming] = useState(false);
  const sending = useRef(false);
  /** A merge's answer was lost in this view: a later already_merged may be our own merge (B1). */
  const lostAnswer = useRef(false);
  const mounted = useRef(true);
  const say = useRef(onMessage);
  say.current = onMessage;
  const slow = useStillConnecting(view.load === 'loading');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The preview, for this ordered pair. A swap, a stale write and a retry each read it again.
  useEffect(() => {
    if (view.load !== 'loading') return undefined;
    const controller = new AbortController();
    void getContactMergePreview(view.mainId, view.otherId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: 'loaded', preview: result.value });
      } else {
        dispatch({ type: 'loadFailed' });
        say.current(`records.error.${result.error.code}` as MessageId);
      }
    });
    return () => controller.abort();
  }, [view.load, view.mainId, view.otherId]);

  const send = useCallback(async () => {
    if (sending.current || view.preview === null) return;
    sending.current = true;
    setConfirming(false);
    say.current(null);
    dispatch({ type: 'merging' });
    const body = mergeBody(view.preview, view.overrides, view.refused);
    const result = await createContactMerge(body);
    if (!mounted.current) {
      sending.current = false;
      return;
    }
    if (result.ok) {
      sending.current = false;
      dispatch({ type: 'merged', merge: result.value });
      return;
    }
    // A lost answer, or a refusal that may be our own merge arriving twice: ask the history before saying anything (B1).
    const unsure = result.error.code === 'network' || (result.error.code === 'already_merged' && lostAnswer.current);
    if (unsure) {
      lostAnswer.current = true;
      const history = await listContactMerges();
      sending.current = false;
      if (!mounted.current) return;
      const own = history.ok ? findOwnMerge(history.value.data, [body.survivorId, body.mergedId]) : null;
      if (own !== null) {
        dispatch({ type: 'merged', merge: own });
        return;
      }
      say.current(mergeRefusal(result.error).message);
      dispatch({ type: 'lost' });
      return;
    }
    sending.current = false;
    const refusal = mergeRefusal(result.error);
    say.current(refusal.message);
    dispatch({ type: 'mergeFailed', refusal });
  }, [view.preview, view.overrides, view.refused]);

  const undo = useCallback(async () => {
    if (sending.current || view.merge === null) return;
    sending.current = true;
    say.current(null);
    dispatch({ type: 'undoing' });
    const result = await undoContactMerge(view.merge.id);
    sending.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      dispatch({ type: 'undone', merge: result.value });
      return;
    }
    const refusal = undoRefusal(result.error);
    say.current(refusal.message);
    dispatch({ type: 'undoFailed', refusal });
  }, [view.merge]);

  const comparing = view.step === 'compare' || view.step === 'merging';
  const preview = view.preview;
  const busy = view.step !== 'compare';

  return (
    <section data-testid="merge-view" aria-labelledby="merge-title" className="flex min-w-0 flex-col gap-4">
      <div>
        <button type="button" data-testid="merge-back" disabled={view.step === 'merging' || view.step === 'undoing'} onClick={() => onBack(view.dirty)} className={QUIET_BUTTON}>
          <Icon name="arrow_back" size="sm" />
          {t.t('duplicates.merge.back')}
        </button>
      </div>
      <header className="flex flex-col gap-1">
        <h2 id="merge-title" className="text-h3">
          {t.t('duplicates.merge.title')}
        </h2>
        <p className="text-body-sm text-text-2">{t.t('duplicates.merge.intro')}</p>
      </header>

      {comparing && view.load === 'loading' ? (
        <div className="flex flex-col gap-3">
          {slow ? <StillConnecting t={t} /> : null}
          <Skeleton t={t} label="duplicates.merge.loading" rows={5} />
        </div>
      ) : null}

      {comparing && view.load === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-body-md text-text-2">{t.t('duplicates.merge.failed')}</p>
          <button type="button" onClick={() => dispatch({ type: 'reread' })} className={SECONDARY_BUTTON}>
            {t.t('duplicates.retry')}
          </button>
        </div>
      ) : null}

      {comparing && Object.keys(view.names).length > 0 ? (
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-body-md font-semibold">{t.t('duplicates.merge.mainLegend')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.pair.map((id) => (
              <label key={id} className={`flex min-h-touch min-w-0 cursor-pointer items-center gap-3 rounded-md border p-3 ${id === view.mainId ? 'border-primary bg-primary-soft' : 'border-border bg-surface'}`}>
                <input
                  type="radio"
                  name={`main-${view.pair.join('-')}`}
                  data-main={id}
                  checked={id === view.mainId}
                  disabled={busy}
                  onChange={() => dispatch({ type: 'main', id })}
                  className="h-5 w-5 shrink-0 accent-primary"
                />
                <PersonName t={t} name={view.names[id] ?? null} />
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {comparing && preview !== null ? (
        <>
          <MergeCompare t={t} preview={preview} overrides={view.overrides} refused={view.refused} disabled={busy} onPick={(field, side) => dispatch({ type: 'pick', field, side })} />

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" data-testid="merge-submit" disabled={busy || view.blocked} onClick={() => setConfirming(true)} className={PRIMARY_BUTTON}>
              {t.t('duplicates.merge.submit')}
            </button>
            {view.step === 'merging' ? (
              <span role="status" className="text-body-sm text-text-2">
                {t.t('duplicates.merging')}
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {!comparing ? <MergeResult t={t} locale={locale} view={view} onUndo={() => void undo()} /> : null}

      {confirming && preview !== null ? (
        <Dialog
          testId="merge-confirm"
          title={t.t('duplicates.confirm.title')}
          body={t.t('duplicates.confirm.body')}
          icon="warning"
          tone="warning"
          closeLabel={t.t('duplicates.confirm.close')}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" data-testid="merge-confirm-cancel" onClick={() => setConfirming(false)} className={SECONDARY_BUTTON}>
                {t.t('duplicates.confirm.cancel')}
              </button>
              <button type="button" data-testid="merge-confirm-yes" onClick={() => void send()} className={PRIMARY_BUTTON}>
                {t.t('duplicates.confirm.yes')}
              </button>
            </>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
            <dt className="text-text-2">{t.t('duplicates.role.kept')}</dt>
            <dd className="min-w-0">
              <PersonName t={t} name={preview.survivor.displayName ?? null} />
            </dd>
            <dt className="text-text-2">{t.t('duplicates.role.merged')}</dt>
            <dd className="min-w-0">
              <PersonName t={t} name={preview.merged.displayName ?? null} />
            </dd>
          </dl>
        </Dialog>
      ) : null}
    </section>
  );
}
