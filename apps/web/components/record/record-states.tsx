'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
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

/** P05/05 offline: the record is still here, in memory only (D-L64), and says when it was read. */
export function RecordOfflineBanner({ t, locale, syncedAt }: { t: Translator; locale: string; syncedAt: Date | null }) {
  return (
    <div role="status" data-testid="offline-banner" className="flex items-start gap-3 rounded-lg bg-inverse p-3 text-body-sm text-on-inverse">
      <Icon name="cloud_off" size="sm" />
      <p>
        <b>{t.t('records.offline.title')}</b>{' '}
        {syncedAt === null ? t.t('records.offline.never') : t.t('record.offline', { time: formatClock(locale, syncedAt) })}
      </p>
    </div>
  );
}

/** P05/06: skeletons in the final layout, then a sentence and an offer of lite mode. Never a bare spinner. */
export function RecordLoading({ t, slow, label }: { t: Translator; slow: boolean; label: MessageId }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      {slow ? <StillConnecting t={t} /> : null}
      <span role="status" className="sr-only">
        {t.t(label)}
      </span>
      <div data-testid="record-skeleton" aria-hidden="true" className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4">
        <span className="h-16 w-16 shrink-0 rounded-full bg-surface-sunken" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-6 w-1/2 rounded-sm bg-surface-sunken" />
          <span className="h-4 w-1/3 rounded-sm bg-surface-sunken" />
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[5, 4].map((rows, column) => (
          <div
            key={column}
            data-testid="record-skeleton"
            aria-hidden="true"
            className={`flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 ${column === 1 ? 'md:col-span-2' : ''}`}
          >
            {Array.from({ length: rows }, (_, index) => (
              <span key={index} className="h-10 rounded-md bg-surface-sunken" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The GENERIC not-found (D-L69). Identical for another tenant, another
 * programme and an id that names nothing: no id, no programme, no lock, no
 * "request access" — P05/06's access-denied frame is an existence oracle
 * across the BPO isolation boundary (CLAUDE.md 6.4).
 */
export function RecordNotFound({ t }: { t: Translator }) {
  return (
    <section data-testid="record-not-found" className="flex flex-col items-start gap-3 py-8">
      <h1 className="text-h2">{t.t('notFound.title')}</h1>
      <p className="text-body-lg text-text-2">{t.t('notFound.body')}</p>
    </section>
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
