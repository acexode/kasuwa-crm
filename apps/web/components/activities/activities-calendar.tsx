'use client';

import { useId, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON } from '../auth/button-classes';
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS } from '../records/list-classes';
import { withheld, type MyActivity } from '../../lib/activities-api';
import {
  addDays,
  dayKey,
  eventStart,
  leadingBlanks,
  placeEvents,
  shiftView,
  startOfDay,
  windowOf,
  type CalendarRange,
  type CalendarView,
} from './activities-model';
import { formatClockTime, formatDay, formatDayHeader, formatMonth } from './activity-format';
import { Related, Subject } from './activity-parts';
import type { CalendarState } from './use-activities';

/**
 * P07/03–05 — the calendar: a week or a month of the caller's own Kasuwa
 * events (D-P22: nothing external, no holidays). Loaded when first opened, so
 * My tasks' first paint does not carry it.
 *
 * The days are local days in the browser's zone; each event sits on the day
 * it starts (one that began before the window, on the first day shown), and
 * one with a withheld time is not placed at all — a slot would be a guess.
 * A meeting shows both its times. Rescheduling is the form, not a drag
 * (WCAG 2.2 SC 2.5.7). No count anywhere (D-P13).
 */

const EVENT_BUTTON = `flex w-full min-w-0 flex-col items-start gap-0 rounded-md border px-2 py-1 text-start text-caption min-h-touch ${FOCUS}`;
const ACTION = `flex min-h-touch items-center justify-center gap-1 rounded-md border border-border bg-surface px-2 text-caption font-semibold text-text hover:bg-surface-sunken disabled:opacity-60 ${FOCUS}`;

export interface CalendarActions {
  readonly offline: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onComplete: (item: MyActivity) => void;
  readonly onReschedule: (item: MyActivity) => void;
}

function Completion({ t, item }: { t: Translator; item: MyActivity }) {
  if (item.type !== 'task') return null;
  if (withheld(item, 'completedAt')) {
    return (
      <span className="inline-flex items-center gap-1 text-text-2">
        <Icon name="lock" size="sm" />
        <span className="sr-only">{t.t('activities.completion.locked')}</span>
      </span>
    );
  }
  if (item.completedAt === null || item.completedAt === undefined) return null;
  return (
    <span className="inline-flex items-center gap-1 text-success-text">
      <Icon name="check_circle" size="sm" />
      <span className="sr-only">{t.t('record.activity.done')}</span>
    </span>
  );
}

function Event({
  t,
  locale,
  item,
  open,
  onToggle,
  actions,
}: {
  t: Translator;
  locale: string;
  item: MyActivity;
  open: boolean;
  onToggle: () => void;
  actions: CalendarActions;
}) {
  const detailId = useId();
  const start = eventStart(item) ?? '';
  const end = item.type === 'meeting' ? (item.endsAt ?? '') : '';
  const completionKnown = item.type === 'task' && !withheld(item, 'completedAt');
  const completed = completionKnown && item.completedAt !== null && item.completedAt !== undefined;
  const busy = actions.busy.has(item.id);
  return (
    <li
      data-calendar-event={item.id}
      data-activity-type={item.type}
      data-completed={completionKnown ? String(completed) : undefined}
      className="flex min-w-0 flex-col gap-1"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className={`${EVENT_BUTTON} ${item.type === 'meeting' ? 'border-primary bg-primary-soft text-primary-text' : 'border-border bg-surface text-text'} ${completed ? 'line-through' : ''}`}
      >
        <span className="flex w-full min-w-0 items-center gap-1 font-semibold">
          <Icon name={item.type === 'meeting' ? 'event' : 'task_alt'} size="sm" />
          <span className="sr-only">{t.t(`record.activity.type.${item.type}` as MessageId)}</span>
          <time dateTime={start}>{formatClockTime(locale, start)}</time>
          {item.type === 'meeting' ? (
            <>
              <span aria-hidden="true">{'–'}</span>
              <time dateTime={end}>{formatClockTime(locale, end)}</time>
            </>
          ) : null}
          <Completion t={t} item={item} />
        </span>
        <Subject t={t} item={item} className="w-full truncate" />
      </button>
      {open ? (
        <div id={detailId} data-testid="event-detail" className="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-2 text-caption">
          <span className="font-semibold text-text-2">{t.t(`record.activity.type.${item.type}` as MessageId)}</span>
          <Related t={t} item={item} />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              data-action="reschedule"
              data-requires-connection=""
              disabled={actions.offline || busy}
              onClick={() => actions.onReschedule(item)}
              className={ACTION}
            >
              <Icon name="edit" size="sm" />
              {t.t('activities.reschedule')}
            </button>
            {completionKnown && !completed ? (
              <button
                type="button"
                data-action="complete-task"
                data-requires-connection=""
                disabled={actions.offline || busy}
                onClick={() => actions.onComplete(item)}
                className={ACTION}
              >
                <Icon name="check_circle" size="sm" />
                {t.t('record.activity.complete')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Day({
  t,
  locale,
  day,
  today,
  items,
  expanded,
  setExpanded,
  actions,
  compact,
}: {
  t: Translator;
  locale: string;
  day: Date;
  today: string;
  items: readonly MyActivity[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  actions: CalendarActions;
  compact: boolean;
}) {
  const key = dayKey(day);
  const isToday = key === today;
  return (
    <li
      data-calendar-day={key}
      aria-current={isToday ? 'date' : undefined}
      className={`flex min-w-0 flex-col gap-1 rounded-md border p-2 ${compact ? 'md:min-h-24' : 'md:min-h-48'} ${isToday ? 'border-primary bg-primary-soft' : 'border-border bg-surface'}`}
    >
      <h3 className={`text-caption font-bold ${isToday ? 'text-primary-text' : 'text-text-2'}`}>
        <time dateTime={key}>{formatDayHeader(locale, day)}</time>
      </h3>
      {items.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {items.map((item) => (
            <Event
              key={item.id}
              t={t}
              locale={locale}
              item={item}
              open={expanded === item.id}
              onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
              actions={actions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ActivitiesCalendar({
  t,
  locale,
  view,
  state,
  actions,
  onShow,
  onRetry,
}: {
  t: Translator;
  locale: string;
  view: CalendarView;
  state: CalendarState;
  actions: CalendarActions;
  onShow: (view: CalendarView) => void;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const headingId = useId();
  const window = windowOf(view);
  const today = dayKey(new Date());
  const last = addDays(window.to, -1);
  const byDay = placeEvents(state.items, window);
  const blanks = view.range === 'month' ? leadingBlanks(window) : 0;
  const drawn = [...byDay.values()].some((items) => items.length > 0);

  const range = (next: CalendarRange) => onShow({ range: next, anchor: view.anchor });

  return (
    <section data-testid="calendar" data-range={view.range} aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-h5 font-bold">
          {view.range === 'month' ? (
            <time dateTime={dayKey(window.from).slice(0, 7)}>{formatMonth(locale, window.from)}</time>
          ) : (
            <>
              <time dateTime={dayKey(window.from)}>{formatDay(locale, window.from)}</time>
              <span className="text-body-sm font-semibold text-text-2">{t.t('activities.calendar.rangeTo')}</span>
              <time dateTime={dayKey(last)}>{formatDay(locale, last)}</time>
            </>
          )}
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-action="calendar-prev"
            aria-label={t.t('activities.calendar.prev')}
            onClick={() => onShow(shiftView(view, -1))}
            className={`${QUIET_BUTTON} min-w-touch`}
          >
            <Icon name="chevron_left" />
          </button>
          <button
            type="button"
            data-action="calendar-today"
            onClick={() => onShow({ ...view, anchor: startOfDay(new Date()) })}
            className={QUIET_BUTTON}
          >
            {t.t('activities.calendar.today')}
          </button>
          <button
            type="button"
            data-action="calendar-next"
            aria-label={t.t('activities.calendar.next')}
            onClick={() => onShow(shiftView(view, 1))}
            className={`${QUIET_BUTTON} min-w-touch`}
          >
            <Icon name="chevron_right" />
          </button>
        </div>
        <div role="group" aria-label={t.t('activities.calendar.range')} className="flex gap-1">
          {(['week', 'month'] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-action={`calendar-${option}`}
              aria-pressed={view.range === option}
              onClick={() => range(option)}
              className={`${CHIP} ${view.range === option ? CHIP_ON : CHIP_OFF}`}
            >
              {t.t(`activities.calendar.${option}` as MessageId)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-caption text-text-2">{t.t('activities.calendar.kasuwaOnly')}</p>

      {state.phase === 'loading' || state.phase === 'idle' ? (
        <div data-testid="calendar-skeleton" aria-busy="true" className="grid grid-cols-1 gap-2 md:grid-cols-7">
          <span role="status" className="sr-only">
            {t.t('activities.calendar.loading')}
          </span>
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} aria-hidden="true" className="h-24 rounded-md bg-surface-sunken" />
          ))}
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div
          role="alert"
          data-testid="calendar-error"
          className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
        >
          <p className="flex items-center gap-2 font-bold">
            <Icon name="error" size="sm" />
            {t.t('activities.calendar.error')}
          </p>
          <p>{t.t(`records.error.${state.error?.code ?? 'network'}` as MessageId)}</p>
          <button type="button" data-requires-connection="" disabled={actions.offline} onClick={onRetry} className={QUIET_BUTTON}>
            {t.t('records.retry')}
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {drawn ? null : (
            <p data-testid="calendar-empty" className="rounded-lg border border-dashed border-border px-3 py-3 text-body-sm text-text-2">
              {t.t('activities.calendar.empty')}
            </p>
          )}
          <ol className="grid grid-cols-1 gap-2 md:grid-cols-7">
            {Array.from({ length: blanks }, (_, index) => (
              <li key={`blank-${index}`} aria-hidden="true" className="hidden md:block" />
            ))}
            {window.days.map((day) => (
              <Day
                key={dayKey(day)}
                t={t}
                locale={locale}
                day={day}
                today={today}
                items={byDay.get(dayKey(day)) ?? []}
                expanded={expanded}
                setExpanded={setExpanded}
                actions={actions}
                compact={view.range === 'month'}
              />
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
