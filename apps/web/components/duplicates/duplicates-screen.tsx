'use client';

import { useEffect, useId, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { SECONDARY_BUTTON, FIELD } from '../auth/button-classes';
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
export function DuplicatesScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
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

  const sets = useDuplicateSets(programmeId === '' ? null : programmeId);
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

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div data-screen="P28" className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-h2">{t.t('duplicates.title')}</h1>
          <p className="text-body-md text-text-2">{t.t('duplicates.subtitle')}</p>
        </header>

        {shown === null ? null : <Banner t={t} message={shown} />}

        {pair === null ? (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor={selectId} className="text-body-sm font-semibold">
                {t.t('duplicates.programme.label')}
              </label>
              {programmes.phase === 'loading' ? <Skeleton t={t} label="duplicates.sets.loading" rows={1} /> : null}
              {programmes.phase === 'error' ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-body-sm text-text-2">{t.t('duplicates.programme.failed')}</p>
                  <button type="button" onClick={programmes.reload} className={SECONDARY_BUTTON}>
                    {t.t('duplicates.retry')}
                  </button>
                </div>
              ) : null}
              {programmes.phase === 'loaded' && programmes.programmes.length === 0 ? <p className="text-body-md text-text-2">{t.t('duplicates.programme.none')}</p> : null}
              {programmes.programmes.length === 0 ? null : (
                <select
                  id={selectId}
                  data-testid="duplicates-programme"
                  value={programmeId}
                  onChange={(event) => {
                    setMessage(null);
                    setProgrammeId(event.target.value);
                  }}
                  className={`${FIELD} max-w-sm`}
                >
                  {programmes.programmes.map((programme) => (
                    <option key={programme.id} value={programme.id}>
                      {programme.name}
                    </option>
                  ))}
                </select>
              )}
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
          <MergeView key={pair.join('-')} t={t} locale={locale} pair={pair} onBack={back} onMessage={setMessage} />
        )}
      </div>
    </CrmShell>
  );
}

function SetsSection({ t, locale, sets, onReview }: { t: Translator; locale: string; sets: DuplicateSets; onReview: (pair: readonly [string, string]) => void }) {
  const waiting = sets.phase === 'loading' && sets.throttle === null;
  const slow = useStillConnecting(waiting);
  return (
    <section aria-labelledby="duplicate-sets-title" className="flex flex-col gap-3">
      <h2 id="duplicate-sets-title" className="text-h3">
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
          <button type="button" onClick={sets.reload} className={SECONDARY_BUTTON}>
            {t.t('duplicates.retry')}
          </button>
        </div>
      ) : null}
      {sets.throttle === null ? null : <Throttled t={t} locale={locale} throttle={sets.throttle} onRetry={sets.retry} />}
      {sets.phase === 'loaded' && sets.sets.length === 0 ? (
        <p data-testid="duplicates-empty" className="text-body-md text-text-2">
          {t.t('duplicates.sets.empty')}
        </p>
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
    <div role="status" data-testid="duplicates-throttled" className="flex flex-col items-start gap-2 rounded-lg border border-warning bg-warning-soft p-3 text-body-sm text-warning-text">
      <p>{t.t('records.error.too_many_requests')}</p>
      {throttle.manual ? (
        <button type="button" data-testid="duplicates-retry" disabled={!throttle.ready} onClick={onRetry} className={SECONDARY_BUTTON}>
          {t.t('duplicates.retry')}
        </button>
      ) : (
        <p>{t.t('duplicates.retry.auto', { seconds: formatCount(locale, throttle.seconds) })}</p>
      )}
    </div>
  );
}
