'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import type { MyActivity } from '../../lib/activities-api';
import { Icon } from '../icon';
import { formatClock, minutesBetween } from './home-format';

/**
 * "Today's agenda" (P03 frame 01): the caller's own tasks due today and
 * meetings that overlap today, from listCalendar, in the browser's zone.
 *
 * Each row is the design's 52px time column, the title with its glyph and a
 * meta line, and a 44px action square: an open task is marked done there
 * (`updateActivity`, nothing optimistic), a done task shows its check, and a
 * meeting opens Activities. A red NOW rule sits before the first item still
 * ahead. Past items are muted and a done task is struck through.
 *
 * Not drawn, because nothing on the wire carries them (D-L195): the meeting
 * link, place or attendees ("Google Meet · Emeka Obi joining"), and calls.
 */

const SQUARE =
  'flex size-touch shrink-0 items-center justify-center rounded-md border outline-none focus-visible:ring-focus';

function startOf(item: MyActivity): string | null {
  return (item.type === 'meeting' ? item.startsAt : item.dueAt) ?? null;
}

function related(t: Translator, item: MyActivity): string | null {
  if (item.account !== null && item.account !== undefined) return item.account.name;
  if (item.contact !== null && item.contact !== undefined) return item.contact.displayName ?? t.t('home.agenda.contactHidden');
  return null;
}

export function AgendaWidget({
  t,
  locale,
  items,
  now,
  busy,
  done,
  activitiesLive,
  onComplete,
}: {
  t: Translator;
  locale: string;
  items: readonly MyActivity[];
  now: Date;
  busy: ReadonlySet<string>;
  done: ReadonlySet<string>;
  activitiesLive: boolean;
  onComplete: (item: MyActivity) => void;
}) {
  const nowAt = now.getTime();
  const firstAhead = items.findIndex((item) => {
    const start = startOf(item);
    return start !== null && new Date(start).getTime() > nowAt;
  });
  const nowIndex = firstAhead === -1 ? items.length : firstAhead;

  const nowRule = (
    <div aria-label={t.t('home.agenda.nowLabel')} role="separator" className="flex items-center gap-2 py-1">
      <span className="font-mono text-micro font-semibold text-danger-text">
        {t.t('home.agenda.now', { time: formatClock(locale, now) })}
      </span>
      <span className="h-0.5 flex-1 bg-danger" />
    </div>
  );

  return (
    <div className="flex flex-col">
      {items.map((item, index) => {
        const start = startOf(item);
        const at = start === null ? null : new Date(start);
        const past = at !== null && at.getTime() <= nowAt;
        const completed = item.type === 'task' && ((item.completedAt ?? null) !== null || done.has(item.id));
        const muted = past || completed;
        const meeting = item.type === 'meeting';
        const next = index === firstAhead && meeting;
        const minutes = meeting ? minutesBetween(item.startsAt, item.endsAt) : null;
        const who = related(t, item);
        const meta = [
          completed
            ? t.t('home.agenda.done')
            : meeting
              ? minutes === null
                ? null
                : t.t('home.agenda.minutes', { minutes })
              : past
                ? t.t('home.agenda.overdue')
                : t.t('home.agenda.due'),
          who,
        ]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ');
        const subject = item.subject ?? null;
        return (
          <Fragment key={item.id}>
            {index === nowIndex ? nowRule : null}
            <div className="grid min-h-14 grid-cols-[var(--k-layout-home-time)_minmax(0,1fr)_var(--k-space-touch)] items-center gap-2.5 border-t border-border">
              <span className={`font-mono text-meta ${muted ? 'text-text-muted' : 'text-text'}`}>
                {at === null ? null : <time dateTime={start ?? undefined}>{formatClock(locale, at)}</time>}
              </span>
              <div className="flex min-w-0 flex-col gap-px py-1.5">
                <b
                  className={`flex items-center gap-1.5 text-body-sm font-bold ${muted ? 'text-text-2' : 'text-text'} ${
                    completed ? 'line-through' : ''
                  }`}
                >
                  <span className={`flex shrink-0 ${muted ? 'text-text-muted' : 'text-primary-text'}`}>
                    <Icon name={meeting ? 'groups' : 'task_alt'} size={18} />
                  </span>
                  <span className="min-w-0 truncate">{subject ?? t.t('home.agenda.noSubject')}</span>
                </b>
                {meta === '' ? null : <span className="text-caption font-normal text-text-2">{meta}</span>}
              </div>
              {completed ? (
                <span
                  role="img"
                  aria-label={t.t('home.agenda.done')}
                  className={`${SQUARE} border-border-strong bg-surface text-success-text`}
                >
                  <Icon name="check" size={20} />
                </span>
              ) : meeting ? (
                activitiesLive ? (
                  <Link
                    href="/activities"
                    aria-label={t.t('home.agenda.open', { title: subject ?? t.t('home.agenda.noSubject') })}
                    className={`${SQUARE} ${
                      next
                        ? 'border-transparent bg-primary text-on-primary is-hover:bg-primary-hover'
                        : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken'
                    }`}
                  >
                    <Icon name="event" size={20} />
                  </Link>
                ) : (
                  <span />
                )
              ) : (
                <button
                  type="button"
                  aria-label={t.t('home.agenda.markDone', { title: subject ?? t.t('home.agenda.noSubject') })}
                  disabled={busy.has(item.id)}
                  onClick={() => onComplete(item)}
                  className={`${SQUARE} border-border-strong bg-surface text-text is-hover:bg-surface-sunken disabled:text-disabled-text`}
                >
                  <Icon name="check_box_outline_blank" size={20} />
                </button>
              )}
            </div>
          </Fragment>
        );
      })}
      {nowIndex === items.length ? nowRule : null}
    </div>
  );
}
