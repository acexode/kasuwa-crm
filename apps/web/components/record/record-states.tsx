'use client';

import Link from 'next/link';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Banner } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { StillConnecting } from '../admin/panel';
import { QUIET_BUTTON } from '../auth/button-classes';
import type { RecordsError } from '../../lib/records-api';
import { formatClock } from './record-core';

/**
 * The states every P05 record draws the same way, whichever record it is
 * (the contact, T-0062; the account, T-0063): offline, loading, not found and
 * a failed read. One copy, so a fix to how a record says "you are offline"
 * lands on every record at once.
 */

/**
 * P05/05 offline: the record is still here, in memory only (D-L64), and says
 * when it was read. The export's inverse band, 48px, 10px radius. No queue
 * count and no "View queue": nothing is queued (D-P21).
 */
export function RecordOfflineBanner({ t, locale, syncedAt }: { t: Translator; locale: string; syncedAt: Date | null }) {
  return (
    <div data-testid="offline-banner">
      <Banner tone="offline" title={t.t('records.offline.title')}>
        {syncedAt === null ? t.t('records.offline.never') : t.t('record.offline', { time: formatClock(locale, syncedAt) })}
      </Banner>
    </div>
  );
}

const SKELETON_CARD = 'flex flex-col gap-3 rounded-lg border border-border bg-surface p-4';

/**
 * P05/06 loading: skeletons in the final layout — the header with three chip
 * pills, then the three columns at 1440 (5 x 44 / 120 + 4 x 64 / 140 + 64 +
 * 2 x 44), the centre and the rail at 1024, the centre alone at 360 — then a
 * sentence and an offer of lite mode. Never a bare spinner.
 */
export function RecordLoading({ t, slow, label }: { t: Translator; slow: boolean; label: MessageId }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 lg:gap-5">
      {slow ? <StillConnecting t={t} /> : null}
      <span role="status" className="sr-only">
        {t.t(label)}
      </span>
      <div data-testid="record-skeleton" aria-hidden="true" className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 lg:p-5">
        <span className="size-16 shrink-0 rounded-full bg-surface-sunken" />
        <span className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="h-6 w-5/12 rounded-6 bg-surface-sunken" />
          <span className="h-3 w-3/5 rounded-sm bg-surface-sunken" />
          <span className="flex flex-wrap gap-1.5">
            <span className="h-6 w-24 rounded-full bg-surface-sunken" />
            <span className="h-6 w-16 rounded-full bg-surface-sunken" />
            <span className="h-6 w-28 rounded-full bg-surface-sunken" />
          </span>
        </span>
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        <div data-testid="record-skeleton" aria-hidden="true" className={`${SKELETON_CARD} hidden xl:flex`}>
          <span className="h-4 w-1/2 rounded-sm bg-surface-sunken" />
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className="h-11 rounded-md bg-surface-sunken" />
          ))}
        </div>
        <div data-testid="record-skeleton" aria-hidden="true" className={SKELETON_CARD}>
          <span className="h-4 w-1/2 rounded-sm bg-surface-sunken" />
          <span className="h-[120px] rounded-md bg-surface-sunken" />
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} className={`h-16 rounded-md bg-surface-sunken ${index > 1 ? 'hidden lg:block' : ''}`} />
          ))}
        </div>
        <div data-testid="record-skeleton" aria-hidden="true" className={`${SKELETON_CARD} hidden lg:flex`}>
          <span className="h-4 w-1/2 rounded-sm bg-surface-sunken" />
          <span className="h-[140px] rounded-md bg-surface-sunken" />
          <span className="h-16 rounded-md bg-surface-sunken" />
          <span className="h-11 rounded-md bg-surface-sunken" />
          <span className="h-11 rounded-md bg-surface-sunken" />
        </div>
      </div>
    </div>
  );
}

/**
 * The GENERIC not-found (D-L69, D-L195), in the design's centred not-found
 * styling. Identical for another tenant, another programme and an id that
 * names nothing: no id, no programme, no owner, no lock, no "request access"
 * — P05/06's access-denied frame is an existence oracle across the BPO
 * isolation boundary (CLAUDE.md 6.4).
 */
export function RecordNotFound({ t, back }: { t: Translator; back?: { readonly href: string; readonly label: MessageId } }) {
  return (
    <div className="flex flex-1 items-center justify-center px-5 py-10">
      <section data-testid="record-not-found" className="flex w-full max-w-[480px] flex-col items-start gap-3.5">
        <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-full bg-surface-sunken text-text-2">
          <Icon name="search_off" size={28} />
        </span>
        <h1 className="text-title-sm font-bold">{t.t('notFound.title')}</h1>
        <p className="text-label font-normal text-text-2">{t.t('notFound.body')}</p>
        {back === undefined ? null : (
          <Link
            href={back.href}
            className="inline-flex h-control-lg items-center rounded-md bg-primary px-4.5 text-label text-on-primary is-hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-focus"
          >
            {t.t(back.label)}
          </Link>
        )}
        <p className="text-meta text-text-muted">{t.t('record.notFound.hint')}</p>
      </section>
    </div>
  );
}

/** A failed read says the server could not be reached, and offers a retry. It is never "not found". */
export function RecordUnavailable({
  t,
  heading,
  error,
  offline,
  onRetry,
}: {
  t: Translator;
  heading: MessageId;
  error: RecordsError | null;
  offline: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="record-unavailable"
      className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
    >
      <p className="flex items-center gap-2 font-bold">
        <Icon name="error" size="sm" />
        {t.t(heading)}
      </p>
      <p>{t.t(`records.error.${error?.code ?? 'network'}` as MessageId)}</p>
      <button type="button" data-requires-connection="" disabled={offline} onClick={onRetry} className={QUIET_BUTTON}>
        {t.t('records.retry')}
      </button>
    </div>
  );
}
