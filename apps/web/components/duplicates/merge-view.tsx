'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from '../admin/dialog';
import { StillConnecting } from '../admin/still-connecting';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { Button } from '@kasuwa/ui/components';
import type { IconName } from '@kasuwa/ui';
import type { MessageId as Id } from '@kasuwa/i18n/bundle';
import { BackLink, DataHeader } from '../data/data-shell';
import { createContactMerge, getContactMergePreview, listContactMerges, undoContactMerge } from '../../lib/duplicates-api';
import { mergeRefusal, undoRefusal } from './duplicates-model';
import { findOwnMerge, mergeBody, mergeReducer, startMerge } from './merge-model';
import { PersonName } from './duplicates-parts';
import { MergeCompare, type CompareColumn } from './merge-compare';
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
/** What the API moves to the main record (activities and deals as primary contact); the preview serves no counts, so none is drawn. */
const MOVES: readonly (readonly [IconName, Id])[] = [
  ['handshake', 'duplicates.moves.deals'],
  ['event', 'duplicates.moves.activities'],
];

export function MergeView({
  t,
  locale,
  pair,
  threeWay,
  onBack,
  onMessage,
}: {
  t: Translator;
  locale: string;
  pair: readonly [string, string];
  /** `merge_three_way`: the compare draws its disabled third slot. */
  threeWay: boolean;
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
  const columns = view.pair.map((id) => ({ id, side: id === view.mainId ? ('survivor' as const) : ('merged' as const) })) as unknown as readonly [CompareColumn, CompareColumn];

  return (
    <section data-testid="merge-view" aria-labelledby="merge-title" className="flex min-w-0 flex-col gap-5">
      <DataHeader
        back={
          <BackLink testId="merge-back" disabled={view.step === 'merging' || view.step === 'undoing'} onClick={() => onBack(view.dirty)}>
            {t.t('duplicates.merge.back')}
          </BackLink>
        }
        title={<span id="merge-title">{t.t('duplicates.merge.title')}</span>}
        lede={t.t('duplicates.merge.intro')}
      />

      {comparing && view.load === 'loading' && slow ? <StillConnecting t={t} /> : null}
      {comparing && view.load === 'loading' ? (
        <span role="status" className="sr-only">
          {t.t('duplicates.merge.loading')}
        </span>
      ) : null}

      {comparing && view.load === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="m-0 text-body-md text-text-2">{t.t('duplicates.merge.failed')}</p>
          <Button icon="refresh" onClick={() => dispatch({ type: 'reread' })}>
            {t.t('duplicates.retry')}
          </Button>
        </div>
      ) : null}

      {comparing && view.load !== 'failed' ? (
        <>
          <MergeCompare
            t={t}
            locale={locale}
            preview={preview}
            columns={columns}
            names={view.names}
            mainId={view.mainId}
            mainName={`main-${view.pair.join('-')}`}
            overrides={view.overrides}
            refused={view.refused}
            disabled={busy || view.load !== 'ready'}
            threeWay={threeWay}
            onMain={(id) => dispatch({ type: 'main', id })}
            onPick={(field, side) => dispatch({ type: 'pick', field, side })}
          />

          <div className="grid gap-3 xl:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5">
              <b className="text-body-sm font-bold">{t.t('duplicates.moves.title')}</b>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {MOVES.map(([icon, label]) => (
                  <li key={label} className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 text-meta font-semibold">
                    <Icon name={icon} size={16} className="text-text-2" />
                    {t.t(label)}
                  </li>
                ))}
              </ul>
            </div>
            <p data-testid="merge-compliance-note" className="m-0 flex gap-2.5 rounded-lg bg-info-soft px-4 py-3.5 text-meta text-text">
              <Icon name="verified_user" size={20} className="shrink-0 text-info-text" />
              <span>
                <b className="font-bold">{t.t('duplicates.compliance.title')}. </b>
                {t.t('duplicates.compliance.note')}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {view.step === 'merging' ? (
              <span role="status" className="me-auto text-body-sm text-text-2">
                {t.t('duplicates.merging')}
              </span>
            ) : null}
            <Button variant="primary" icon="join" data-testid="merge-submit" disabled={busy || view.blocked || preview === null} onClick={() => setConfirming(true)}>
              {t.t('duplicates.merge.submit')}
            </Button>
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
