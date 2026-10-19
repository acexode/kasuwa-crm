'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { notificationHref } from '../../lib/notification-href';
import { ACTOR_MARK, OBJECT_MARK, formatDay, formatTime, groupByDay, relativeDay, dayKey, sentenceKey, sentenceParts, sentenceVariant, SENTENCE_IDS } from '../../lib/notification-model';
import type { ViewState } from '../../lib/notification-view';
import type { NotificationItem } from '../../lib/notifications-api';
import { FOCUS } from '../records/list-classes';
import { errorMessageId } from './message-ids';

/**
 * The rows and day groups the dropdown and the centre share (T-0101): one
 * translated sentence per kind and object type, names drawn as text, a link
 * only where `notificationHref` allows one, and a dot to mark one read or
 * unread. Loaded on demand with whichever of the two opens first, never in a
 * shell's first load.
 */

/** How long a first read may take before it says so (the P01 number, kept). */
export const STILL_CONNECTING_MS = 4_000;

/** The sentence, with each name as its own text node in `[data-record-text]`: markup in a name is text. */
function Sentence({ item, t }: { item: NotificationItem; t: Translator }) {
  const formatted = t.t(SENTENCE_IDS[sentenceKey(item.kind, item.objectType)], {
    variant: sentenceVariant(item),
    actor: ACTOR_MARK,
    object: OBJECT_MARK,
  });
  const parts = sentenceParts(formatted);
  return (
    <span data-notification-sentence className="block min-w-0 break-words text-body-sm">
      {parts.map((part, index) => {
        if (part.kind === 'text') return <Fragment key={index}>{part.text}</Fragment>;
        const name = part.kind === 'actor' ? item.actorName : item.objectName;
        if (name === null || name === '') return null;
        return part.kind === 'actor' ? (
          <span key={index} data-notification-actor="" data-record-text="" className="font-semibold">
            {name}
          </span>
        ) : (
          <span key={index} data-notification-object="" data-record-text="" className="font-semibold">
            {name}
          </span>
        );
      })}
    </span>
  );
}

export interface RowProps {
  readonly item: NotificationItem;
  readonly t: Translator;
  readonly locale: string;
  /** The object types whose route is on in this process (`liveObjectTypes`). */
  readonly live: readonly string[];
  readonly busy: boolean;
  readonly onToggle: (item: NotificationItem) => void;
  readonly onOpen: (item: NotificationItem) => void;
}

export function NotificationRow({ item, t, locale, live, busy, onToggle, onOpen }: RowProps) {
  const unread = item.readAt === null;
  const href = notificationHref(item, live);
  const sentence = <Sentence item={item} t={t} />;
  return (
    <li
      data-notification={item.id}
      data-read={unread ? 'false' : 'true'}
      data-kind={item.kind}
      className={`flex items-start gap-1 rounded-md ${unread ? 'bg-primary-soft' : ''}`}
    >
      <button
        type="button"
        data-notification-toggle=""
        aria-label={t.t(unread ? 'notifications.toggle.markRead' : 'notifications.toggle.markUnread')}
        aria-disabled={busy}
        onClick={() => onToggle(item)}
        className={`flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md ${FOCUS}`}
      >
        <span aria-hidden="true" className={`block h-3 w-3 rounded-full border-2 ${unread ? 'border-primary bg-primary' : 'border-text-muted bg-transparent'}`} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-2">
        {href === null ? (
          sentence
        ) : (
          <Link
            href={href}
            prefetch={false}
            data-notification-link=""
            onClick={() => onOpen(item)}
            className={`min-w-0 rounded-sm text-text underline-offset-2 hover:underline ${FOCUS}`}
          >
            {sentence}
          </Link>
        )}
        <time dateTime={item.createdAt} className="text-caption text-text-muted">
          {formatTime(item.createdAt, locale)}
        </time>
      </div>
    </li>
  );
}

/** Items grouped by the reader's local day, a heading per day. */
export function NotificationGroups({
  items,
  headingLevel,
  ...row
}: Omit<RowProps, 'item' | 'busy'> & {
  readonly items: readonly NotificationItem[];
  readonly headingLevel: 2 | 3;
  readonly busyIds: readonly string[];
  /** A mark-all is in flight: every dot waits (N4). */
  readonly allBusy: boolean;
}) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const today = dayKey(Date.now());
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <>
      {groups.map((group) => {
        const relative = relativeDay(group.day, today);
        return (
          <section key={group.day} data-day-group="" data-day={group.day} className="flex flex-col gap-1">
            <Heading className="px-1 text-caption font-bold uppercase text-text-muted">
              <time dateTime={group.day}>
                {relative === 'today' ? row.t.t('notifications.day.today') : relative === 'yesterday' ? row.t.t('notifications.day.yesterday') : formatDay(group.day, row.locale)}
              </time>
            </Heading>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <NotificationRow key={item.id} item={item} busy={row.allBusy || row.busyIds.includes(item.id)} t={row.t} locale={row.locale} live={row.live} onToggle={row.onToggle} onOpen={row.onOpen} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** A skeleton, and after `STILL_CONNECTING_MS` a sentence about the connection: "still connecting" is a state, not a spinner. */
export function LoadingNotifications({ t }: { t: Translator }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div data-testid="notifications-loading" role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">{t.t('notifications.loading')}</span>
      {[0, 1, 2].map((row) => (
        <span key={row} aria-hidden="true" className="block h-12 rounded-md bg-surface-sunken" />
      ))}
      {slow ? <p className="text-body-sm text-text-2">{t.t('notifications.slow')}</p> : null}
    </div>
  );
}

/**
 * What a view says besides its rows: a wait after a 429 (translated, never "nothing here" and never a connection
 * error), a failed read with its retry, and a write that could not be confirmed. Drawn rows are never replaced by these.
 */
export function ViewStatus({ t, state, onRetry }: { t: Translator; state: ViewState; onRetry: () => void }) {
  const waiting = state.listWaitUntil !== null || state.writeWaitUntil !== null;
  const failure = state.readError ?? state.writeError;
  return (
    <>
      {waiting ? (
        <p data-testid="notifications-throttled" role="status" className="rounded-md bg-warning-soft p-2 text-body-sm text-warning-text">
          {t.t('records.error.too_many_requests')}
        </p>
      ) : null}
      {failure !== null ? (
        <div data-testid="notifications-error" role="status" className="flex flex-col items-start gap-2 rounded-md bg-danger-soft p-2 text-body-sm text-danger-text">
          <p className="font-semibold">{t.t('notifications.error.title')}</p>
          <p>{t.t(failure === 'network' && state.readError === null ? 'notifications.error.write' : errorMessageId(failure))}</p>
          {state.readError !== null ? (
            <button type="button" onClick={onRetry} className={`flex min-h-touch items-center rounded-md px-3 font-semibold text-primary-text hover:bg-surface-sunken ${FOCUS}`}>
              {t.t('records.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
