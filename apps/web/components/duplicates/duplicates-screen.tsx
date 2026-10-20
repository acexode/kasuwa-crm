'use client';

import { useEffect, useId, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button, EmptyState } from '@kasuwa/ui/components';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { DataHeader, DataShell, type DataLive } from '../data/data-shell';
import { NativeSelect } from '../data/parts';
import { StillConnecting } from '../admin/panel';
import { formatCount } from '../import/import-text';
import { Banner, Skeleton } from './duplicates-parts';
import { HistoryList } from './history-list';
import { MergeView } from './merge-view';
import { MoreButton, SetsList } from './sets-list';
import { useStillConnecting } from './use-still-connecting';
import type { Throttle } from './duplicate-scanner';
import { useDuplicateSets, useProgrammes, type DuplicateSets } from './use-duplicate-sets';
import { useMergeHistory } from './use-merge-history';

/**
 * `P28` frames C and C1 and the merges history — the duplicates and merge screen
 * (T-0097), behind its feature flag, which only the server page reads.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUTE, TWO VIEWS. The landing is the programme's duplicate sets over the
 * merges history; Review swaps it for the merge of one pair, and back swaps it
 * again. Both hooks live HERE, so going to a merge and coming back costs no
 * read, except where the merge changed something (a merge, an undo, a pair
 * found already merged): then the sets and the history are read again, because
 * a stale list offering a merged-away contact is worse than one more read.
 *
 * SCOPE IS THE SESSION'S. The programme is chosen from the caller's own list and
 * named in the path of the scan; no request carries a scope of its own.
 *
 * CONTROLS ARE SHOWN, AND THE API'S 403 IS THE GATE (D-L84): there is no
 * capability read, so an agent sees Merge and is told, in words, that it is not
 * permitted.
 *
 * NOTHING ABOUT A PERSON LEAVES THE PAGE. Names are drawn as text; no name,
 * number or address is put in a URL, the title, history state, the console or
 * on the device (D-P21).
 * ---------------------------------------------------------------------------
 */
/** How long a programme choice must stand before it is scanned. */
const PROGRAMME_SETTLE_MS = 300;

export type DuplicatesFrame =
  | { readonly kind: 'crm'; readonly live: readonly string[] }
  | { readonly kind: 'data'; readonly bell: boolean; readonly sections: DataLive; readonly threeWay: boolean };

export function DuplicatesScreen({
  locale,
  messages,
  locales,
  frame,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  frame: DuplicatesFrame;
}) {
  const designed = frame.kind === 'data';
  const t = createBundleTranslator(locale, messages);
  const programmes = useProgrammes();
  const [programmeId, setProgrammeId] = useState('');
  const [message, setMessage] = useState<MessageId | null>(null);
  const [pair, setPair] = useState<readonly [string, string] | null>(null);
  const selectId = useId();

  // The first programme the session reaches is the landing's scan; the select changes it.
  useEffect(() => {
    if (programmeId === '' && programmes.programmes[0] !== undefined) setProgrammeId(programmes.programmes[0].id);
  }, [programmes.programmes, programmeId]);

  // A scan is a whole-programme scan and an aborted one still holds a server slot (D-L163): scan the programme
  // the person settled on, not each one they pass while choosing.
  const [scanned, setScanned] = useState('');
  useEffect(() => {
    if (programmeId === '' || scanned === '') {
      setScanned(programmeId);
      return undefined;
    }
    const timer = setTimeout(() => setScanned(programmeId), PROGRAMME_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [programmeId, scanned]);
  const sets = useDuplicateSets(scanned === '' ? null : scanned);
  const history = useMergeHistory({ onUndone: sets.reload, onMessage: setMessage });
  const shown = message ?? sets.failure;

  const back = (dirty: boolean) => {
    setMessage(null);
    setPair(null);
    if (dirty) {
      sets.reload();
      history.reload();
    }
  };

  const body = (
    <div data-screen="P28" className="flex min-w-0 flex-col gap-5">
      {pair === null ? (
        <DataHeader
          title={t.t('duplicates.title')}
          lede={t.t('duplicates.subtitle')}
          action={
            designed ? (
              <Button icon="tune" disabled title={t.t('records.nav.soon')}>
                {t.t('duplicates.rules')}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {shown === null ? null : <Banner t={t} message={shown} />}

      {pair === null ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span aria-current="true" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-meta font-bold text-on-primary">
              {t.t('import.object.contacts')}
            </span>
            {designed
              ? (['accounts', 'leads'] as const).map((object) => (
                  <span
                    key={object}
                    aria-disabled="true"
                    title={t.t('records.nav.soon')}
                    className="inline-flex h-9 cursor-not-allowed items-center rounded-full border border-border bg-surface px-3.5 text-meta font-semibold text-disabled-text"
                  >
                    {t.t(`import.object.${object}` as MessageId)}
                  </span>
                ))
              : null}
            <span className="flex-1" />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <label htmlFor={selectId} className="text-meta font-semibold">
                {t.t('duplicates.programme.label')}
              </label>
              {programmes.phase === 'loading' ? <Skeleton t={t} label="duplicates.sets.loading" rows={1} /> : null}
              {programmes.phase === 'error' ? (
                <div className="flex items-center gap-2">
                  <p className="m-0 text-body-sm text-text-2">{t.t('duplicates.programme.failed')}</p>
                  <Button size="compact" onClick={programmes.reload}>
                    {t.t('duplicates.retry')}
                  </Button>
                </div>
              ) : null}
              {programmes.phase === 'loaded' && programmes.programmes.length === 0 ? <p className="m-0 text-body-sm text-text-2">{t.t('duplicates.programme.none')}</p> : null}
              {programmes.programmes.length === 0 ? null : (
                <NativeSelect
                  id={selectId}
                  data-testid="duplicates-programme"
                  value={programmeId}
                  onChange={(event) => {
                    setMessage(null);
                    setProgrammeId(event.target.value);
                  }}
                  className="w-full sm:w-64"
                >
                  {programmes.programmes.map((programme) => (
                    <option key={programme.id} value={programme.id}>
                      {programme.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
          </div>

          {programmeId === '' ? null : (
            <SetsSection
              t={t}
              locale={locale}
              sets={sets}
              onReview={(next) => {
                setMessage(null);
                setPair(next);
              }}
            />
          )}
          <HistoryList t={t} locale={locale} history={history} />
        </>
      ) : (
        <MergeView key={pair.join('-')} t={t} locale={locale} pair={pair} threeWay={frame.kind === 'data' && frame.threeWay} onBack={back} onMessage={setMessage} />
      )}
    </div>
  );

  if (frame.kind === 'crm') {
    return (
      <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={frame.live}>
        {body}
      </CrmShell>
    );
  }
  return (
    <DataShell t={t} locale={locale} messages={messages} locales={locales} bell={frame.bell} current="duplicates" live={frame.sections}>
      {body}
    </DataShell>
  );
}

function SetsSection({ t, locale, sets, onReview }: { t: Translator; locale: string; sets: DuplicateSets; onReview: (pair: readonly [string, string]) => void }) {
  const waiting = sets.phase === 'loading' && sets.throttle === null;
  const slow = useStillConnecting(waiting);
  return (
    <section aria-labelledby="duplicate-sets-title" className="flex flex-col gap-3">
      <h2 id="duplicate-sets-title" className="sr-only">
        {t.t('duplicates.sets.title')}
      </h2>
      {waiting ? (
        <div className="flex flex-col gap-3">
          {slow ? <StillConnecting t={t} /> : null}
          <Skeleton t={t} label="duplicates.sets.loading" />
        </div>
      ) : null}
      {sets.phase === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <Button icon="refresh" onClick={sets.reload}>
            {t.t('duplicates.retry')}
          </Button>
        </div>
      ) : null}
      {sets.throttle === null ? null : <Throttled t={t} locale={locale} throttle={sets.throttle} onRetry={sets.retry} />}
      {sets.phase === 'loaded' && sets.sets.length === 0 ? (
        <div data-testid="duplicates-empty" className="rounded-lg border border-border bg-surface px-5 py-6">
          <EmptyState icon="join" tone="neutral" headingLevel={3} title={t.t('duplicates.sets.empty')} body={t.t('duplicates.sets.empty.body')} />
        </div>
      ) : null}
      {sets.sets.length === 0 ? null : <SetsList t={t} locale={locale} sets={sets.sets} onReview={onReview} />}
      {sets.nextCursor === null ? null : <MoreButton t={t} testId="duplicates-more" loading={sets.loadingMore} disabled={sets.throttle !== null} onClick={sets.more} />}
    </section>
  );
}

/**
 * A 429 is a wait, said in words: neither a failed connection nor "no
 * duplicates". The sets already drawn stay. The screen asks again by itself
 * once; after repeated refusals it stops and the button is the way on.
 */
function Throttled({ t, locale, throttle, onRetry }: { t: Translator; locale: string; throttle: Throttle; onRetry: () => void }) {
  return (
    <div role="status" data-testid="duplicates-throttled" className="flex flex-col items-start gap-2 rounded-lg bg-warning-soft px-5 py-4 text-body-sm text-warning-text">
      <p>{t.t('records.error.too_many_requests')}</p>
      {throttle.manual ? (
        <Button size="compact" data-testid="duplicates-retry" disabled={!throttle.ready} onClick={onRetry}>
          {t.t('duplicates.retry')}
        </Button>
      ) : (
        <p>{t.t('duplicates.retry.auto', { seconds: formatCount(locale, throttle.seconds) })}</p>
      )}
    </div>
  );
}
