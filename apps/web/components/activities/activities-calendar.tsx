'use client';

import { useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Banner, Button, IconButton, SegmentedControl, type SegmentedOption } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { withheld, type MyActivity } from '../../lib/activities-api';
import {
  addDays,
  dayKey,
  eventStart,
  gridHours,
  leadingBlanks,
  overlapping,
  placeEvents,
  placeOnDay,
  shiftView,
  startOfDay,
  weekStart,
  windowOf,
  type CalendarRange,
  type CalendarView,
  type PlacedEvent,
} from './activities-model';
import {
  formatClockTime,
  formatDay,
  formatDayLong,
  formatDayMonth,
  formatDayNumber,
  formatDayShort,
  formatMonth,
  formatWeekday,
  zoneSuffix,
} from './activity-format';
import { Related, Subject } from './activity-parts';
import type { CalendarState } from './use-activities';

/**
 * P07/09–18 — the calendar (T-0083, T-0136): a day or a week as a time grid
 * with the event panel beside it, or a month, of the caller's own Kasuwa
 * events (D-P22: nothing external, no holidays). Loaded when first opened, so
 * My tasks' first paint does not carry it. On a phone it is the design's day
 * strip and agenda, or the month with dots.
 *
 * The days are local days in the browser's zone; each event sits on the day
 * it starts (one that began before the window, on the first day shown), and
 * one with a withheld time is not placed at all — a slot would be a guess.
 * A meeting shows both its times; a task, which has a due time and no
 * length, is drawn as half an hour. Rescheduling is the form, not a drag
 * (WCAG 2.2 SC 2.5.7). No count anywhere (D-P13).
 *
 * With `calendar_sync` on (D-L194), the design's not-connected state: the
 * "connect your work calendar" banner with its buttons disabled, the "Kasuwa
 * only" chip, the overlap banner for Kasuwa's own events, and an empty
 * attendee list in the panel. Off, none of it is drawn.
 */

/** The design's hour height on the grid. */
const HOUR_PX = 46;

export interface CalendarActions {
  readonly offline: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onComplete: (item: MyActivity) => void;
  readonly onReschedule: (item: MyActivity) => void;
}

/** Each listed type's colour, from the chart palette as the design keys its types. */
const TONE = {
  meeting: { tint: 'bg-chart-1-tint', edge: 'border-chart-1', solid: 'bg-chart-1' },
  task: { tint: 'bg-chart-3-tint', edge: 'border-chart-3', solid: 'bg-chart-3' },
} as const;

const NARROW = '(max-width: 767px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** One layout at a time (the grid or the agenda), so no event is drawn twice. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

function completion(item: MyActivity): { known: boolean; done: boolean } {
  const known = item.type === 'task' && !withheld(item, 'completedAt');
  return { known, done: known && item.completedAt !== null && item.completedAt !== undefined };
}

function eventEnd(item: MyActivity): string {
  return item.type === 'meeting' ? (item.endsAt ?? '') : '';
}

/** "10:00–10:45" in `<time>`s, a task's due time alone. */
/**
 * "10:00–11:00", and with `zone` "10:00–11:00 WAT". The zone is written inside
 * the last <time>, as My tasks writes "12:00 WAT" (`DueTime`): it is part of
 * the time, the same abbreviation in every locale, never a word to translate.
 */
function TimeSpan({
  locale,
  item,
  className = '',
  startOnly = false,
  zone = '',
}: {
  locale: string;
  item: MyActivity;
  className?: string;
  startOnly?: boolean;
  zone?: string;
}) {
  const start = eventStart(item) ?? '';
  const end = eventEnd(item);
  const suffix = zone === '' ? '' : ` ${zone}`;
  return (
    <span className={className}>
      <time dateTime={start}>
        {formatClockTime(locale, start)}
        {end === '' ? suffix : null}
      </time>
      {end === '' ? null : (
        <span className={startOnly ? 'sr-only' : ''}>
          {'–'}
          <time dateTime={end}>
            {formatClockTime(locale, end)}
            {suffix}
          </time>
        </span>
      )}
    </span>
  );
}

function CompletionMark({ t, item }: { t: Translator; item: MyActivity }) {
  if (item.type !== 'task') return null;
  if (withheld(item, 'completedAt')) {
    return (
      <span className="inline-flex shrink-0 items-center text-text-2">
        <Icon name="lock" size={14} />
        <span className="sr-only">{t.t('activities.completion.locked')}</span>
      </span>
    );
  }
  if (!completion(item).done) return null;
  return (
    <span className="inline-flex shrink-0 items-center text-success-text">
      <Icon name="check_circle" size={14} />
      <span className="sr-only">{t.t('record.activity.done')}</span>
    </span>
  );
}

/** The attributes every drawn event carries (the e2e hooks), whatever its shape. */
function eventAttributes(item: MyActivity) {
  const { known, done } = completion(item);
  return {
    'data-calendar-event': item.id,
    'data-activity-type': item.type,
    'data-completed': known ? String(done) : undefined,
  };
}

/** One block on the time grid, placed by its hours and lane. */
function GridEvent({
  t,
  locale,
  event,
  first,
  selected,
  clash,
  onSelect,
}: {
  t: Translator;
  locale: string;
  event: PlacedEvent;
  first: number;
  selected: boolean;
  clash: boolean;
  onSelect: () => void;
}) {
  const { item } = event;
  const tone = TONE[item.type];
  const hours = event.end - event.start;
  const short = hours <= 0.5;
  const width = 100 / event.lanes;
  const style: CSSProperties = {
    top: (event.start - first) * HOUR_PX + 1,
    height: Math.max(hours * HOUR_PX - 2, 20),
    insetInlineStart: `calc(${event.lane * width}% + 3px)`,
    width: `calc(${width}% - 6px)`,
  };
  const { done } = completion(item);
  return (
    <button
      type="button"
      {...eventAttributes(item)}
      aria-pressed={selected}
      onClick={onSelect}
      style={style}
      className={`absolute z-[2] flex flex-col gap-px overflow-hidden rounded-6 px-1.5 py-[3px] text-start text-text is-focus-visible:ring-focus ${tone.tint} ${tone.edge} ${
        selected ? 'border-2 shadow-2' : 'border'
      } ${done ? 'line-through' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-0.75 text-caption font-bold leading-[15px]">
        {clash ? <Icon name="warning" size={14} className="shrink-0 text-warning-text" /> : null}
        <span className="sr-only">{t.t(`record.activity.type.${item.type}` as MessageId)}</span>
        {short ? (
          <TimeSpan locale={locale} item={item} startOnly className="shrink-0 font-mono text-[10px] font-semibold text-text-2" />
        ) : null}
        <Subject t={t} item={item} className={`min-w-0 ${hours >= 1.5 ? 'line-clamp-2' : 'truncate'}`} />
        <CompletionMark t={t} item={item} />
      </span>
      {short ? null : <TimeSpan locale={locale} item={item} className="shrink-0 whitespace-nowrap font-mono text-[10px] leading-[13px] text-text-2" />}
    </button>
  );
}

/** P07/09–11: the week's or the day's time grid. */
function TimeGrid({
  t,
  locale,
  days,
  byDay,
  today,
  selected,
  clashes,
  onSelect,
}: {
  t: Translator;
  locale: string;
  days: readonly Date[];
  byDay: Map<string, MyActivity[]>;
  today: string;
  selected: string | null;
  clashes: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const placed = days.map((day) => placeOnDay(byDay.get(dayKey(day)) ?? [], day));
  const { first, last } = gridHours(placed);
  const hours = Array.from({ length: last - first }, (_, index) => first + index);
  const height = (last - first) * HOUR_PX;
  const now = new Date();
  const nowHours = now.getHours() + now.getMinutes() / 60;
  const columns = `52px repeat(${days.length}, minmax(0, 1fr))`;
  const zone = zoneSuffix();

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <ol className="grid" style={{ gridTemplateColumns: columns }}>
        <li aria-hidden="true" className="flex flex-col">
          <span className="flex h-[66px] items-end justify-center border-b border-border p-1.5 font-mono text-[10px] font-semibold text-text-muted">
            {zone}
          </span>
          <span className="flex h-[34px] items-center justify-center border-b border-border text-[10px] font-semibold text-text-muted">
            {t.t('activities.calendar.allDay')}
          </span>
          <span className="relative" style={{ height }}>
            {hours.map((hour, index) =>
              index === 0 ? null : (
                <span
                  key={hour}
                  className="absolute end-1.5 -translate-y-1.5 font-mono text-[10px] leading-3 text-text-muted"
                  style={{ top: index * HOUR_PX }}
                >
                  {`${String(hour).padStart(2, '0')}:00`}
                </span>
              ),
            )}
          </span>
        </li>
        {days.map((day, index) => {
          const key = dayKey(day);
          const isToday = key === today;
          const weekend = days.length > 1 && (day.getDay() === 0 || day.getDay() === 6);
          const events = placed[index] ?? [];
          return (
            <li
              key={key}
              data-calendar-day={key}
              aria-current={isToday ? 'date' : undefined}
              className="flex min-w-0 flex-col border-s border-border"
            >
              <h3 className="flex h-[66px] flex-col items-center justify-center gap-0.5 border-b border-border px-1 py-2">
                <time dateTime={key} className="contents">
                  <span className="text-[11px] font-bold uppercase leading-4 tracking-[.05em] text-text-2">{formatWeekday(locale, day)}</span>
                  <span
                    className={`flex size-8 items-center justify-center rounded-full text-body-md font-bold ${
                      isToday ? 'bg-primary text-on-primary' : 'text-text'
                    }`}
                  >
                    {formatDayNumber(locale, day)}
                  </span>
                </time>
              </h3>
              <span aria-hidden="true" className="h-[34px] border-b border-border" />
              <div className={`relative ${weekend ? 'bg-surface-sunken' : ''}`} style={{ height }}>
                {hours.map((hour, row) =>
                  row === 0 ? null : (
                    <span key={hour} aria-hidden="true" className="absolute inset-x-0 border-t border-border" style={{ top: row * HOUR_PX }} />
                  ),
                )}
                {isToday && nowHours >= first && nowHours <= last ? (
                  <span aria-hidden="true" className="absolute inset-x-0 z-[3] h-0.5 bg-danger" style={{ top: (nowHours - first) * HOUR_PX }}>
                    <span className="absolute -start-1 -top-[3px] size-2 rounded-full bg-danger" />
                  </span>
                ) : null}
                {events.map((event) => (
                  <GridEvent
                    key={event.item.id}
                    t={t}
                    locale={locale}
                    event={event}
                    first={first}
                    selected={selected === event.item.id}
                    clash={clashes.has(event.item.id)}
                    onSelect={() => onSelect(event.item.id)}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** P07/12, 16: the month, chips on a desk and dots on a phone. */
function MonthGrid({
  t,
  locale,
  days,
  blanks,
  byDay,
  today,
  narrow,
  selected,
  onSelect,
  onDay,
}: {
  t: Translator;
  locale: string;
  days: readonly Date[];
  blanks: number;
  byDay: Map<string, MyActivity[]>;
  today: string;
  narrow: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onDay: (day: Date) => void;
}) {
  const monday = weekStart(new Date(2026, 0, 5));
  const heads = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  const trailing = (7 - ((blanks + days.length) % 7)) % 7;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div aria-hidden="true" className="grid grid-cols-7 border-b border-border">
        {heads.map((day) => (
          <span
            key={dayKey(day)}
            className={`p-2 text-[11px] font-bold uppercase leading-4 tracking-[.05em] text-text-2 ${narrow ? 'text-center' : 'text-start'}`}
          >
            {narrow ? formatWeekday(locale, day).slice(0, 1) : formatWeekday(locale, day)}
          </span>
        ))}
      </div>
      <ol className="grid grid-cols-7">
        {Array.from({ length: blanks }, (_, index) => (
          <li key={`blank-${index}`} aria-hidden="true" className="border-b border-e border-border bg-surface-sunken" />
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const isToday = key === today;
          const items = byDay.get(key) ?? [];
          return (
            <li
              key={key}
              data-calendar-day={key}
              aria-current={isToday ? 'date' : undefined}
              className={`flex min-w-0 flex-col gap-[3px] border-b border-e border-border p-1.5 ${narrow ? 'min-h-16 items-center' : 'min-h-[112px]'}`}
            >
              <button
                type="button"
                onClick={() => onDay(day)}
                aria-label={formatDayLong(locale, day)}
                className={`flex size-[26px] shrink-0 items-center justify-center rounded-full text-meta is-focus-visible:ring-focus ${
                  isToday ? 'bg-primary font-extrabold text-on-primary' : 'font-medium text-text is-hover:bg-surface-sunken'
                }`}
              >
                <time dateTime={key}>{formatDayNumber(locale, day)}</time>
              </button>
              {narrow ? (
                <span className="flex flex-wrap justify-center gap-0.5">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      {...eventAttributes(item)}
                      onClick={() => onSelect(item.id)}
                      aria-label={t.t(`record.activity.type.${item.type}` as MessageId)}
                      className={`relative size-1.5 rounded-full before:absolute before:-inset-2 ${TONE[item.type].solid}`}
                    >
                      <time dateTime={eventStart(item) ?? ''} className="sr-only">
                        {formatClockTime(locale, eventStart(item) ?? '')}
                      </time>
                    </button>
                  ))}
                </span>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    {...eventAttributes(item)}
                    aria-pressed={selected === item.id}
                    onClick={() => onSelect(item.id)}
                    className={`flex min-w-0 items-center gap-1 rounded-sm px-[5px] text-start text-[11px] leading-4 text-text is-focus-visible:ring-focus ${TONE[item.type].tint} ${
                      selected === item.id ? 'ring-1 ring-primary' : ''
                    } ${completion(item).done ? 'line-through' : ''}`}
                  >
                    <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE[item.type].solid}`} />
                    <TimeSpan locale={locale} item={item} className="sr-only" />
                    <Subject t={t} item={item} className="min-w-0 truncate" />
                  </button>
                ))
              )}
            </li>
          );
        })}
        {Array.from({ length: trailing }, (_, index) => (
          <li key={`after-${index}`} aria-hidden="true" className="border-b border-e border-border bg-surface-sunken" />
        ))}
      </ol>
    </div>
  );
}

/** P07/13–15: the phone's week strip and the chosen day's agenda. */
function Agenda({
  t,
  locale,
  days,
  byDay,
  today,
  day,
  clashes,
  onDay,
  onSelect,
}: {
  t: Translator;
  locale: string;
  days: readonly Date[];
  byDay: Map<string, MyActivity[]>;
  today: string;
  day: Date;
  clashes: ReadonlySet<string>;
  onDay: (day: Date) => void;
  onSelect: (id: string) => void;
}) {
  const chosen = dayKey(day);
  const items = byDay.get(chosen) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-7 gap-1">
        {days.map((entry) => {
          const key = dayKey(entry);
          const on = key === chosen;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onDay(entry)}
              className={`flex h-[60px] flex-col items-center justify-center gap-0.5 rounded-10 is-focus-visible:ring-focus ${
                on ? 'bg-primary text-on-primary' : key === today ? 'bg-primary-soft text-text' : 'bg-surface text-text'
              }`}
            >
              <time dateTime={key} className="contents">
                <span className="text-[11px] font-bold leading-4">{formatWeekday(locale, entry).slice(0, 2)}</span>
                <b className="text-[17px] leading-6">{formatDayNumber(locale, entry)}</b>
              </time>
            </button>
          );
        })}
      </div>
      <ol data-calendar-day={chosen} aria-current={chosen === today ? 'date' : undefined} className="flex flex-col gap-2">
        {items.map((item) => {
          const tone = TONE[item.type];
          const start = eventStart(item) ?? '';
          const end = eventEnd(item);
          return (
            <li key={item.id}>
              <button
                type="button"
                {...eventAttributes(item)}
                onClick={() => onSelect(item.id)}
                className="grid w-full grid-cols-[52px_minmax(0,1fr)] items-stretch gap-2.5 text-start text-text is-focus-visible:ring-focus"
              >
                <span className="flex flex-col pt-2.5 font-mono text-caption text-text-2">
                  <time dateTime={start}>{formatClockTime(locale, start)}</time>
                  {end === '' ? null : (
                    <time dateTime={end} className="text-[10px] text-text-muted">
                      {formatClockTime(locale, end)}
                    </time>
                  )}
                </span>
                <span className={`flex min-h-14 flex-col gap-0.75 rounded-10 border px-3 py-2.5 ${tone.tint} ${tone.edge}`}>
                  <b className={`flex items-center gap-1 text-body-sm font-bold ${completion(item).done ? 'line-through' : ''}`}>
                    {clashes.has(item.id) ? <Icon name="warning" size={15} className="text-warning-text" /> : null}
                    <Subject t={t} item={item} className="min-w-0" />
                    <CompletionMark t={t} item={item} />
                  </b>
                  <span className="text-caption text-text-2">{t.t(`record.activity.type.${item.type}` as MessageId)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {items.length === 0 ? <p className="px-3 py-5 text-center text-body-sm text-text-2">{t.t('activities.calendar.dayEmpty')}</p> : null}
    </div>
  );
}

/** The selected event (P07/09 side panel; below the month and on a phone). */
function EventDetail({
  t,
  locale,
  item,
  sync,
  actions,
}: {
  t: Translator;
  locale: string;
  item: MyActivity;
  sync: boolean;
  actions: CalendarActions;
}) {
  const start = eventStart(item) ?? '';
  const { known, done } = completion(item);
  const busy = actions.busy.has(item.id);
  return (
    <aside data-testid="event-detail" aria-label={t.t('activities.calendar.detail')} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={`mt-1.5 size-3 shrink-0 rounded-[3px] ${TONE[item.type].solid}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Subject t={t} item={item} className={`text-h5 font-bold ${done ? 'line-through' : ''}`} />
          <span className="text-meta text-text-2">
            <time dateTime={start}>{formatDayShort(locale, start)}</time>
            {' · '}
            <TimeSpan locale={locale} item={item} zone={zoneSuffix(new Date(start))} />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex h-[26px] items-center gap-1 rounded-full bg-surface-sunken px-2.25 text-caption font-semibold text-text-2">
          {t.t('activities.calendar.source', { type: t.t(`record.activity.type.${item.type}` as MessageId) })}
        </span>
        {known && done ? (
          <span className="inline-flex h-[26px] items-center gap-1 rounded-full bg-success-soft px-2.25 text-caption font-semibold text-success-text">
            <Icon name="check_circle" size={14} />
            {t.t('record.activity.done')}
          </span>
        ) : null}
        {withheld(item, 'completedAt') ? <CompletionMark t={t} item={item} /> : null}
      </div>
      {item.contact || item.account || withheld(item, 'contact') || withheld(item, 'account') ? (
        <span className="flex flex-wrap items-center gap-1.5 text-meta [&_a]:underline [&_a]:underline-offset-[3px]">
          <Icon name="link" size={16} className="text-text-2" />
          <Related t={t} item={item} />
        </span>
      ) : null}
      {sync ? (
        <div data-stub="attendees" className="flex flex-col gap-1.5">
          <span className="text-overline text-text-muted">{t.t('activities.calendar.attendees')}</span>
          <span className="text-meta text-text-2">{t.t('activities.calendar.attendees.none')}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {known && !done ? (
          <Button
            variant="primary"
            icon="check_circle"
            data-action="complete-task"
            data-requires-connection=""
            disabled={actions.offline || busy}
            onClick={() => actions.onComplete(item)}
            className="flex-[1_1_auto] !text-body-sm"
          >
            {t.t('record.activity.complete')}
          </Button>
        ) : null}
        <Button
          data-action="reschedule"
          data-requires-connection=""
          disabled={actions.offline || busy}
          onClick={() => actions.onReschedule(item)}
          className="!text-body-sm"
        >
          {t.t('activities.reschedule')}
        </Button>
      </div>
    </aside>
  );
}

function NoSelection({ t }: { t: Translator }) {
  return (
    <aside className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-meta text-text-2">
      <Icon name="event" size={22} className="text-text-muted" />
      {t.t('activities.calendar.pick')}
    </aside>
  );
}

/** P07/17–18: the work calendar is not connected (D-P22). Its buttons are drawn disabled: nothing connects yet. */
function NotConnected({ t }: { t: Translator }) {
  const connect = (letter: string, label: MessageId) => (
    <Button disabled title={t.t('activities.unavailable')} className="!gap-2 !px-3.5 !text-body-sm">
      <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-sm border-[1.5px] border-current text-[11px] font-extrabold">
        {letter}
      </span>
      {t.t(label)}
    </Button>
  );
  return (
    <div data-stub="calendar-sync" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-primary bg-primary-soft px-4 py-3.5">
      <Icon name="event_available" size={28} className="text-primary-text" />
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
        <b className="text-label font-bold">{t.t('activities.sync.title')}</b>
        <span className="text-meta text-text-2">{t.t('activities.sync.body')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {connect('G', 'activities.sync.google')}
        {connect('M', 'activities.sync.microsoft')}
      </div>
    </div>
  );
}

export function ActivitiesCalendar({
  t,
  locale,
  view,
  state,
  actions,
  sync = false,
  onShow,
  onRetry,
}: {
  t: Translator;
  locale: string;
  view: CalendarView;
  state: CalendarState;
  actions: CalendarActions;
  /** `calendar_sync` (D-L194): the not-connected furniture. */
  sync?: boolean;
  onShow: (view: CalendarView) => void;
  onRetry: () => void;
}) {
  const narrow = useNarrow();
  const [selected, setSelected] = useState<string | null>(null);
  const [agendaDay, setAgendaDay] = useState<Date | null>(null);
  const headingId = useId();
  const window = windowOf(view);
  const today = dayKey(new Date());
  const last = addDays(window.to, -1);
  const byDay = placeEvents(state.items, window);
  const blanks = view.range === 'month' ? leadingBlanks(window) : 0;
  const drawn = [...byDay.values()].some((items) => items.length > 0);
  // As the design opens: the panel shows today's first event until another is chosen.
  const todaysFirst = narrow ? null : (byDay.get(today)?.[0] ?? null);
  const selectedItem = selected === null ? todaysFirst : (state.items.find((item) => item.id === selected) ?? null);
  const grid = view.range !== 'month';

  // Kasuwa's own events that overlap one another (D-L194: only with calendar_sync).
  const clashes = new Set<string>();
  if (sync && grid) {
    for (const day of window.days) for (const id of overlapping(placeOnDay(byDay.get(dayKey(day)) ?? [], day))) clashes.add(id);
  }

  // The phone's strip is the week around the chosen day; a "week" on a phone is that strip.
  const chosenDay = (() => {
    const inWindow = (day: Date | null) => day !== null && day >= window.from && day < window.to;
    if (inWindow(agendaDay)) return agendaDay as Date;
    const now = startOfDay(new Date());
    return inWindow(now) ? now : window.from;
  })();
  const strip = Array.from({ length: 7 }, (_, index) => addDays(weekStart(chosenDay), index));

  const ranges: readonly CalendarRange[] = narrow ? ['day', 'month'] : ['day', 'week', 'month'];
  const segments: SegmentedOption[] = ranges.map((range) => ({
    value: range,
    label: t.t(`activities.calendar.${range}` as MessageId),
    attributes: { 'data-action': `calendar-${range}` },
  }));
  const segmentValue = narrow && view.range === 'week' ? 'day' : view.range;

  const title: ReactNode =
    view.range === 'month' ? (
      <time dateTime={dayKey(window.from).slice(0, 7)}>{formatMonth(locale, window.from)}</time>
    ) : view.range === 'day' ? (
      <time dateTime={dayKey(window.from)}>{formatDayLong(locale, window.from)}</time>
    ) : (
      <>
        <time dateTime={dayKey(window.from)}>{formatDayMonth(locale, window.from)}</time>
        <span className="sr-only">{` ${t.t('activities.calendar.rangeTo')} `}</span>
        <span aria-hidden="true">{' – '}</span>
        <time dateTime={dayKey(last)}>{formatDay(locale, last)}</time>
      </>
    );

  const firstClash = state.items.find((item) => clashes.has(item.id)) ?? null;

  return (
    <section data-testid="calendar" data-range={view.range} aria-labelledby={headingId} className="flex flex-col gap-3 md:gap-4">
      {sync ? <NotConnected t={t} /> : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-0.5">
          <IconButton
            variant="ghost"
            icon="chevron_left"
            label={t.t('activities.calendar.prev')}
            data-action="calendar-prev"
            onClick={() => onShow(shiftView(view, -1))}
            className="!size-10 rtl:-scale-x-100"
          />
          <IconButton
            variant="ghost"
            icon="chevron_right"
            label={t.t('activities.calendar.next')}
            data-action="calendar-next"
            onClick={() => onShow(shiftView(view, 1))}
            className="!size-10 rtl:-scale-x-100"
          />
        </div>
        <h2 id={headingId} className="text-body-md font-bold md:text-h5 md:font-bold">
          {title}
        </h2>
        <Button
          size="compact"
          data-action="calendar-today"
          aria-label={t.t('activities.calendar.today')}
          onClick={() => {
            setAgendaDay(startOfDay(new Date()));
            onShow({ ...view, anchor: startOfDay(new Date()) });
          }}
          className="md:!px-3"
        >
          {t.t('activities.calendar.todayShort')}
        </Button>
        <span className="hidden flex-1 md:block" />
        <SegmentedControl
          aria-label={t.t('activities.calendar.range')}
          options={segments}
          value={segmentValue}
          onValueChange={(next) => onShow({ range: next as CalendarRange, anchor: narrow && next === 'day' ? chosenDay : view.anchor })}
          className="!gap-0.5 !rounded-10 max-md:basis-full max-md:[&]:w-fit [&>button]:!rounded-[7px]"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-caption text-text-2">
        {(['meeting', 'task'] as const).map((type) => (
          <span key={type} className="inline-flex items-center gap-[5px]">
            <span aria-hidden="true" className={`size-3 rounded-[3px] border-[1.5px] ${TONE[type].tint} ${TONE[type].edge}`} />
            {t.t(`record.activity.type.${type}` as MessageId)}
          </span>
        ))}
        <span className="flex-1" />
        {sync ? (
          <span data-stub="calendar-source" className="inline-flex h-[26px] items-center gap-[5px] rounded-full bg-surface-sunken px-2.25">
            <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-sm border-[1.5px] border-current text-[9px] font-extrabold">
              {'K'}
            </span>
            {t.t('activities.sync.kasuwaOnly')}
          </span>
        ) : null}
      </div>

      {sync && firstClash !== null ? (
        <Banner
          tone="warning"
          icon="event_busy"
          title={t.t('activities.clash.title')}
          action={{ label: t.t('activities.clash.review'), onClick: () => setSelected(firstClash.id) }}
          className="border border-warning"
        >
          {t.t('activities.clash.body')}
        </Banner>
      ) : null}

      {state.phase === 'loading' || state.phase === 'idle' ? (
        <div data-testid="calendar-skeleton" aria-busy="true" className="flex h-[480px] flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <span role="status" className="sr-only">
            {t.t('activities.calendar.loading')}
          </span>
          <span aria-hidden="true" className="h-12 rounded-md bg-surface-sunken" />
          <span aria-hidden="true" className="flex-1 rounded-md bg-surface-sunken" />
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div data-testid="calendar-error" className="flex flex-col gap-2">
          <Banner
            tone="danger"
            title={t.t('activities.calendar.error')}
            action={actions.offline ? undefined : { label: t.t('records.retry'), onClick: onRetry }}
          >
            {t.t(`records.error.${state.error?.code ?? 'network'}` as MessageId)}
          </Banner>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {drawn ? null : (
            <p data-testid="calendar-empty" className="text-meta text-text-2">
              {t.t('activities.calendar.empty')}
            </p>
          )}
          {narrow && grid ? (
            <Agenda
              t={t}
              locale={locale}
              days={strip}
              byDay={placeEvents(state.items, { from: strip[0] ?? window.from, to: addDays(strip[0] ?? window.from, 7), days: strip })}
              today={today}
              day={chosenDay}
              clashes={clashes}
              onDay={(day) => {
                setAgendaDay(day);
                if (day < window.from || day >= window.to) onShow({ range: 'week', anchor: day });
              }}
              onSelect={setSelected}
            />
          ) : null}
          {!narrow && grid ? (
            <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-3">
                <TimeGrid
                  t={t}
                  locale={locale}
                  days={window.days}
                  byDay={byDay}
                  today={today}
                  selected={selectedItem?.id ?? null}
                  clashes={clashes}
                  onSelect={setSelected}
                />
                <span className="text-caption text-text-muted">{t.t('activities.calendar.kasuwaOnly')}</span>
              </div>
              <div className="xl:sticky xl:top-[76px]">
                {selectedItem === null ? <NoSelection t={t} /> : <EventDetail t={t} locale={locale} item={selectedItem} sync={sync} actions={actions} />}
              </div>
            </div>
          ) : null}
          {view.range === 'month' ? (
            <MonthGrid
              t={t}
              locale={locale}
              days={window.days}
              blanks={blanks}
              byDay={byDay}
              today={today}
              narrow={narrow}
              selected={selected}
              onSelect={setSelected}
              onDay={(day) => {
                setAgendaDay(day);
                onShow({ range: narrow ? 'week' : 'day', anchor: day });
              }}
            />
          ) : null}
          {(narrow || view.range === 'month') && selected !== null && selectedItem !== null ? (
            <EventDetail t={t} locale={locale} item={selectedItem} sync={sync} actions={actions} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
