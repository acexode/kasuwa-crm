'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { notificationHref } from '../../lib/notification-href';
import { ACTOR_MARK, OBJECT_MARK, formatDay, formatTime, groupByDay, relativeDay, dayKey, sentenceKey, sentenceParts, sentenceVariant, SENTENCE_IDS } from '../../lib/notification-model';
import type { ViewState } from '../../lib/notification-view';
import type { NotificationItem } from '../../lib/notifications-api';
import { Icon } from '../icon';
import { DAY_HEADING, FOCUS } from './classes';
import { KIND_LOOK, OBJECT_LOOK } from './kinds';
import { errorMessageId } from './message-ids';

/**
 * The rows and day groups the dropdown and the centre share (T-0101, drawn to
 * the P26 export by T-0137): a tinted type tile, the translated sentence as
 * the row's title, the object line, the time on the right and the read dot at
 * the far end. Names are drawn as text; a link only where `notificationHref`
 * allows one. Loaded on demand with whichever of the two opens first, never in
 * a shell's first load.
 *
 * The design's rows also carry a body line and inline actions (Approve,
 * Reject, Open ticket, Reply). The three served kinds have neither: a
 * notification stores no text (D-P29), and the design draws no action on an
 * assignment or an import row. So neither is drawn.
 */

/** How long a first read may take before it says so (the P01 number, kept). */
export const STILL_CONNECTING_MS = 4_000;

/** `page`: the centre's row (40px tile, 15/21 title). `panel`: the bell's (36px tile, 14/20). */
export type RowSize = 'page' | 'panel';

/** The sentence, with each name as its own text node in `[data-record-text]`: markup in a name is text. */
function Sentence({ item, t }: { item: NotificationItem; t: Translator }) {
  const formatted = t.t(SENTENCE_IDS[sentenceKey(item.kind, item.objectType)], {
    variant: sentenceVariant(item),
    actor: ACTOR_MARK,
    object: OBJECT_MARK,
  });
  const parts = sentenceParts(formatted);
  return (
    <span data-notification-sentence className="block min-w-0 break-words">
      {parts.map((part, index) => {
        if (part.kind === 'text') return <Fragment key={index}>{part.text}</Fragment>;
        const name = part.kind === 'actor' ? item.actorName : item.objectName;
        if (name === null || name === '') return null;
        return part.kind === 'actor' ? (
          <span key={index} data-notification-actor="" data-record-text="">
            {name}
          </span>
        ) : (
          <span key={index} data-notification-object="" data-record-text="">
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
  readonly size: RowSize;
  readonly onToggle: (item: NotificationItem) => void;
  readonly onOpen: (item: NotificationItem) => void;
}

export function NotificationRow({ item, t, locale, live, busy, size, onToggle, onOpen }: RowProps) {
  const unread = item.readAt === null;
  const href = notificationHref(item, live);
  const look = KIND_LOOK[item.kind];
  const object = OBJECT_LOOK[item.objectType];
  const page = size === 'page';
  const sentence = <Sentence item={item} t={t} />;
  return (
    <li
      data-notification={item.id}
      data-read={unread ? 'false' : 'true'}
      data-kind={item.kind}
      className={`flex gap-3 rounded-10 border border-transparent ${page ? 'p-2.5 md:p-3' : 'p-2.5'}`}
    >
      <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-10 ${look.tile} ${page ? 'size-9 md:size-10' : 'size-9'}`}>
        <Icon name={look.icon} size={page ? 22 : 20} />
      </span>
      <div className={`flex min-w-0 flex-1 flex-col ${page ? 'gap-0.75' : 'gap-0.5'}`}>
        <div className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 text-text ${page ? 'text-label' : 'text-body-sm'} ${unread ? 'font-bold' : 'font-medium'}`}>
            {href === null ? (
              sentence
            ) : (
              <Link href={href} prefetch={false} data-notification-link="" onClick={() => onOpen(item)} className={`block rounded-sm text-text underline-offset-2 is-hover:underline ${FOCUS}`}>
                {sentence}
              </Link>
            )}
          </span>
          <time dateTime={item.createdAt} className={`shrink-0 whitespace-nowrap text-caption font-normal text-text-muted ${page ? 'pt-0.5' : 'pt-0.5'}`}>
            {formatTime(item.createdAt, locale)}
          </time>
        </div>
        <span className="flex min-w-0 items-center gap-1.5 text-caption font-normal text-text-muted">
          <Icon name={object.icon} size={15} />
          <span className="shrink-0">{t.t(object.label)}</span>
          {item.objectName === null || item.objectName === '' ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-record-text="" className="min-w-0 truncate">
                {item.objectName}
              </span>
            </>
          )}
        </span>
      </div>
      {/* The read dot: 10px, primary when unread, a border-strong ring when read; a 44px target drawn in a 28px slot. */}
      <button
        type="button"
        data-notification-toggle=""
        aria-label={t.t(unread ? 'notifications.toggle.markRead' : 'notifications.toggle.markUnread')}
        aria-disabled={busy}
        onClick={() => onToggle(item)}
        className={`-my-2 -me-2 flex size-touch shrink-0 items-center justify-center rounded-6 is-hover:bg-surface-sunken ${FOCUS}`}
      >
        <span aria-hidden="true" className={`block size-2.5 rounded-full ${unread ? 'bg-primary' : 'border-2 border-border-strong bg-transparent'}`} />
      </button>
    </li>
  );
}

/**
 * Items grouped by the reader's local day: a caps heading per day and, on the
 * right, how many of that day's items are unread. The count is drawn only for
 * a day whose items are all drawn (a later day follows it, or the list has
 * ended): a day still being paged would undercount.
 */
export function NotificationGroups({
  items,
  headingLevel,
  final,
  ...row
}: Omit<RowProps, 'item' | 'busy'> & {
  readonly items: readonly NotificationItem[];
  readonly headingLevel: 2 | 3;
  /** The list has ended (`nextCursor` is null): the last day is complete. */
  readonly final: boolean;
  readonly busyIds: readonly string[];
  /** A mark-all is in flight: every dot waits (N4). */
  readonly allBusy: boolean;
}) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const today = dayKey(Date.now());
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const page = row.size === 'page';
  return (
    <>
      {groups.map((group, index) => {
        const relative = relativeDay(group.day, today);
        const complete = final || index < groups.length - 1;
        const unread = group.items.filter((entry) => entry.readAt === null).length;
        return (
          <section key={group.day} data-day-group="" data-day={group.day} className={`flex flex-col gap-0.5 ${page ? 'px-1.5 pb-1.5 pt-0.5 md:px-2 md:pb-2 md:pt-1' : 'px-1.5 pb-1.5 pt-0.5'}`}>
            <div className={`${DAY_HEADING} ${page ? 'pb-0.5 pt-3 md:pb-1' : 'pb-0.5 pt-2.5'}`}>
              <Heading className="min-w-0 flex-1">
                <time dateTime={group.day}>
                  {relative === 'today' ? row.t.t('notifications.day.today') : relative === 'yesterday' ? row.t.t('notifications.day.yesterday') : formatDay(group.day, row.locale)}
                </time>
              </Heading>
              {page && complete && unread > 0 ? (
                <span className="shrink-0 font-medium normal-case tracking-normal text-text-muted">{row.t.t('notifications.unreadCount', { count: unread })}</span>
              ) : null}
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  busy={row.allBusy || row.busyIds.includes(item.id)}
                  size={row.size}
                  t={row.t}
                  locale={row.locale}
                  live={row.live}
                  onToggle={row.onToggle}
                  onOpen={row.onOpen}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** A skeleton in the rows' own shape, and after `STILL_CONNECTING_MS` a sentence about the connection: "still connecting" is a state, not a spinner. */
export function LoadingNotifications({ t, size }: { t: Translator; size: RowSize }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    return () => clearTimeout(timer);
  }, []);
  const page = size === 'page';
  return (
    <div data-testid="notifications-loading" role="status" aria-busy="true" className={`flex flex-col gap-0.5 ${page ? 'p-2' : 'p-1.5'}`}>
      <span className="sr-only">{t.t('notifications.loading')}</span>
      {[0, 1, 2].map((row) => (
        <span key={row} aria-hidden="true" className={`flex gap-3 ${page ? 'p-3' : 'p-2.5'}`}>
          <span className={`block shrink-0 animate-pulse rounded-10 bg-surface-sunken ${page ? 'size-10' : 'size-9'}`} />
          <span className="flex flex-1 flex-col gap-2 pt-1">
            <span className="block h-3.5 w-3/4 animate-pulse rounded-sm bg-surface-sunken" />
            <span className="block h-3 w-1/3 animate-pulse rounded-sm bg-surface-sunken" />
          </span>
        </span>
      ))}
      {slow ? <p className="px-3 pb-2 text-body-sm text-text-2">{t.t('notifications.slow')}</p> : null}
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
        <p data-testid="notifications-throttled" role="status" className="flex items-start gap-2 rounded-10 bg-warning-soft px-3 py-2.5 text-body-sm text-warning-text">
          <Icon name="schedule" size={20} />
          <span className="min-w-0 flex-1">{t.t('records.error.too_many_requests')}</span>
        </p>
      ) : null}
      {failure !== null ? (
        <div data-testid="notifications-error" role="status" className="flex items-start gap-2 rounded-10 bg-danger-soft px-3 py-2.5 text-body-sm text-danger-text">
          <Icon name="error" size={20} />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <p className="font-semibold">{t.t('notifications.error.title')}</p>
            <p>{t.t(failure === 'network' && state.readError === null ? 'notifications.error.write' : errorMessageId(failure))}</p>
            {state.readError !== null ? (
              <button type="button" onClick={onRetry} className={`-ms-2 flex min-h-touch items-center rounded-md px-2 font-bold text-primary-text is-hover:bg-surface ${FOCUS}`}>
                {t.t('records.retry')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
