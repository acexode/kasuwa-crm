'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import type { TimelineItem } from '../../lib/contact-record-api';
import { dayHeading, dayKey, formatDateTime, formatTime, type TimelineState, type ValueView } from './record-core';

/**
 * A P05 record's centre column: what happened to the record, newest first, as
 * the API serves it — the contact's (P05/01, T-0061) and the account's
 * (P05/04, T-0080). One component, so both records draw history the same way.
 *
 * T-0134 (D-L193): drawn as P05's timeline — day groups (Today, Yesterday,
 * "Mon 28 Sep") in the browser's zone, a 36px tinted type circle on a 2px
 * connector, the time of day on a 24-hour clock beside the title, notes in
 * the dashed "not visible to customer" box. The served order is kept: a day
 * group is a run of consecutive items, never a re-sort.
 *
 * Every item once, in served order. `before` and `after` are drawn only where
 * the item carries them: the `[data-change]` elements exist exactly then, so
 * nothing on this screen can invent a value the audit trail withheld. Actors
 * by name, the system as one label. Every time is a `<time datetime>`, shown
 * in the browser's zone. No total, no "of", no page number (D-P13).
 *
 * What differs between records comes in as props: how a field is named
 * (`fieldLabel`), and how a served `before`/`after` value is drawn
 * (`describe`). An account's changes are by name only (D-L78), so the account
 * passes no `describe` and nothing here could draw a value for one.
 */

/** How a record names a field on its timeline, and draws a served value. */
export interface TimelineVocabulary {
  readonly fieldLabel: (field: string) => MessageId | null;
  readonly describe?: (field: string, value: unknown) => ValueView;
}

const ICONS: Readonly<Record<string, IconName>> = {
  field_changed: 'edit',
  consent_changed: 'verified_user',
  note: 'sticky_note_2',
  task: 'task_alt',
  call: 'call',
  // T-0082: a meeting on the timeline (logged from P07, never from here).
  meeting: 'event',
};

/** The type circle's tint, as the export colours each channel. */
const TONES: Readonly<Record<string, string>> = {
  field_changed: 'bg-surface-sunken text-text-2',
  consent_changed: 'bg-success-soft text-success-text',
  note: 'bg-accent-soft text-accent-text',
  task: 'bg-info-soft text-info-text',
  call: 'bg-primary-soft text-primary-text',
  meeting: 'bg-info-soft text-info-text',
};

export function Value({ t, view }: { t: Translator; view: ValueView }) {
  if (view.kind === 'label') return <>{t.t(view.id)}</>;
  if (view.kind === 'text') return <span data-record-text="">{view.text}</span>;
  return <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
}

function When({ locale, iso }: { locale: string; iso: string }) {
  return (
    <time dateTime={iso} className="whitespace-nowrap">
      {formatDateTime(locale, iso)}
    </time>
  );
}

/** When it happened, as the time of day: the day is the group heading. */
function Clock({ locale, iso }: { locale: string; iso: string }) {
  return (
    <time dateTime={iso} className="whitespace-nowrap">
      {formatTime(locale, iso)}
    </time>
  );
}

function Actor({ t, item }: { t: Translator; item: TimelineItem }) {
  return (
    <span data-actor="">
      {item.actor === null ? t.t('record.system') : <span data-record-text="">{item.actor.displayName}</span>}
    </span>
  );
}

function Change({
  t,
  field,
  item,
  describe,
}: {
  t: Translator;
  field: string;
  item: { before?: unknown; after?: unknown };
  describe: ((field: string, value: unknown) => ValueView) | undefined;
}) {
  if (describe === undefined || (!('before' in item) && !('after' in item))) return null;
  const side = (value: unknown) => describe(field, value);
  return (
    <p className="flex flex-wrap items-center gap-2 text-body-sm">
      <span data-change="before" className="rounded-sm bg-surface-sunken px-2 text-text-2 line-through decoration-text-muted">
        <Value t={t} view={side(item.before)} />
      </span>
      <Icon name="arrow_forward" size="sm" className="text-text-muted rtl:-scale-x-100" />
      <span className="sr-only">{t.t('record.timeline.to')}</span>
      <span data-change="after" className="rounded-sm bg-primary-soft px-2 font-semibold text-primary-text">
        <Value t={t} view={side(item.after)} />
      </span>
    </p>
  );
}

function Item({
  t,
  locale,
  item,
  vocabulary,
  canComplete,
  completing,
  offline,
  onComplete,
  meetingTimes,
}: {
  t: Translator;
  locale: string;
  item: TimelineItem;
  vocabulary: TimelineVocabulary;
  canComplete: boolean;
  completing: boolean;
  offline: boolean;
  onComplete: (activityId: string) => void;
  meetingTimes: boolean;
}) {
  let title: string;
  let icon: IconName;
  let tone: string;
  let body: React.ReactNode = null;

  if (item.type === 'activity') {
    icon = ICONS[item.activityType] ?? 'edit_note';
    tone = item.activityType;
    title = t.t(`record.activity.type.${item.activityType}` as MessageId);
    const withheld = !('subject' in item) || !('body' in item);
    const done = item.completedAt !== null && item.completedAt !== undefined;
    const note = item.activityType === 'note';
    body = (
      <div
        className={`flex flex-col gap-1 rounded-10 px-3 py-2.5 text-body-sm ${
          note ? 'border border-dashed border-accent bg-note-bg' : 'border border-border'
        }`}
      >
        {typeof item.subject === 'string' ? (
          <b data-record-text="" className="break-words">
            {item.subject}
          </b>
        ) : null}
        {typeof item.body === 'string' ? (
          <p data-record-text="" className={`whitespace-pre-wrap break-words ${note ? 'text-text' : 'text-meta text-text-2'}`}>
            {item.body}
          </p>
        ) : null}
        {note ? <span className="text-micro text-accent-text">{t.t('record.timeline.internal')}</span> : null}
        {withheld ? (
          <span className="inline-flex items-center gap-1 text-text-muted">
            <Icon name="lock" size="sm" />
            {t.t('records.locked')}
          </span>
        ) : null}
        {item.activityType === 'task' && typeof item.dueAt === 'string' ? (
          <span className="flex flex-wrap items-center gap-1 text-text-2">
            <Icon name="schedule" size="sm" />
            {t.t('record.activity.due')} <When locale={locale} iso={item.dueAt} />
          </span>
        ) : null}
        {meetingTimes && item.activityType === 'meeting' && typeof item.startsAt === 'string' ? (
          // A meeting's times (T-0082), in the browser's zone, only where a record opts in (the deal, T-0110).
          <span className="flex flex-wrap items-center gap-1 text-text-2">
            <Icon name="event" size="sm" />
            <When locale={locale} iso={item.startsAt} />
            {typeof item.endsAt === 'string' ? (
              <>
                <span aria-hidden="true">{'–'}</span>
                <When locale={locale} iso={item.endsAt} />
              </>
            ) : null}
          </span>
        ) : null}
        {item.activityType === 'task' && done && typeof item.completedAt === 'string' ? (
          <span className="flex flex-wrap items-center gap-1 font-semibold text-success-text">
            <Icon name="check_circle" size="sm" />
            {t.t('record.activity.done')} <When locale={locale} iso={item.completedAt} />
          </span>
        ) : null}
        {item.activityType === 'task' && !done && canComplete ? (
          <div>
            <button
              type="button"
              data-action="complete-task"
              data-requires-connection=""
              disabled={offline || completing}
              onClick={() => onComplete(item.activityId)}
              className={`${SECONDARY_BUTTON} h-control-sm min-h-0 text-meta disabled:opacity-60`}
            >
              <Icon name="check" size="sm" />
              {completing ? t.t('record.saving') : t.t('record.activity.complete')}
            </button>
          </div>
        ) : null}
      </div>
    );
  } else {
    const field = item.type === 'consent_changed' ? 'consentState' : item.field;
    icon = ICONS[item.type] ?? 'edit';
    tone = item.type;
    const label = vocabulary.fieldLabel(field);
    title = t.t('record.timeline.changed', { field: label === null ? field : t.t(label) });
    body =
      item.type === 'field_changed' && item.redacted === true ? (
        <p className="text-body-sm text-text-muted">{t.t('record.timeline.redacted')}</p>
      ) : (
        <Change t={t} field={field} item={item} describe={vocabulary.describe} />
      );
  }

  return (
    <li
      data-timeline-item={item.id}
      data-item-type={item.type}
      data-activity-id={item.type === 'activity' ? item.activityId : undefined}
      data-completed={
        item.type === 'activity' && item.activityType === 'task'
          ? String(item.completedAt !== null && item.completedAt !== undefined)
          : undefined
      }
      className="grid min-w-0 grid-cols-[36px_minmax(0,1fr)] gap-3"
    >
      <div aria-hidden="true" className="flex flex-col items-center">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${TONES[tone] ?? TONES.field_changed}`}>
          <Icon name={icon} size={18} />
        </span>
        <span className="min-h-3 w-0.5 flex-1 bg-border" />
      </div>
      <div className="flex min-w-0 flex-col gap-2 pb-5">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <b className="text-body-sm font-bold text-text">{title}</b>
          <span className="inline-flex flex-wrap items-baseline gap-x-1 text-caption font-normal text-text-muted">
            <Clock locale={locale} iso={item.occurredAt} />
            <span aria-hidden="true">{'·'}</span>
            <Actor t={t} item={item} />
          </span>
        </p>
        {body}
      </div>
    </li>
  );
}

export function RecordTimeline({
  t,
  locale,
  timeline,
  vocabulary,
  loadingLabel,
  versions,
  completing,
  offline,
  onRetry,
  onLoadOlder,
  onComplete,
  meetingTimes = false,
  filter,
}: {
  t: Translator;
  locale: string;
  timeline: TimelineState<TimelineItem>;
  vocabulary: TimelineVocabulary;
  /** The screen-reader announcement while the first page loads. */
  loadingLabel: MessageId;
  versions: Readonly<Record<string, number>>;
  completing: string | null;
  offline: boolean;
  onRetry: () => void;
  onLoadOlder: () => void;
  onComplete: (activityId: string) => void;
  /** Draw a meeting's start and end times. Off unless a record opts in, so the contact and account timelines are unchanged. */
  meetingTimes?: boolean;
  /** The P05 type filter (T-0134): which loaded items to draw. Every item when left out. */
  filter?: (item: TimelineItem) => boolean;
}) {
  if (timeline.phase === 'loading') {
    return (
      <div data-testid="timeline" aria-busy="true" className="flex flex-col gap-3">
        <span role="status" className="sr-only">
          {t.t(loadingLabel)}
        </span>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} aria-hidden="true" className="flex gap-3">
            <span className="size-9 shrink-0 rounded-full bg-surface-sunken" />
            <span className="h-12 flex-1 rounded-md bg-surface-sunken" />
          </div>
        ))}
      </div>
    );
  }

  if (timeline.phase === 'error') {
    return (
      <div data-testid="timeline" className="flex flex-col gap-3">
        <div
          data-testid="timeline-error"
          className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
        >
          <p className="flex items-center gap-2 font-bold">
            <Icon name="error" size="sm" />
            {t.t('record.timeline.error')}
          </p>
          <button type="button" data-requires-connection="" disabled={offline} onClick={onRetry} className={QUIET_BUTTON}>
            {t.t('records.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="timeline" className="flex flex-col">
      {timeline.items.length === 0 ? (
        <p data-testid="timeline-empty" className="flex items-center gap-2 rounded-md bg-surface-sunken p-4 text-body-sm text-text-2">
          <Icon name="history" size="sm" />
          {t.t('record.timeline.empty')}
        </p>
      ) : (
        <DayGroups
          t={t}
          locale={locale}
          items={filter === undefined ? timeline.items : timeline.items.filter(filter)}
          render={(item) => (
            <Item
              key={item.id}
              t={t}
              locale={locale}
              item={item}
              vocabulary={vocabulary}
              canComplete={item.type === 'activity' && versions[item.activityId] !== undefined}
              completing={item.type === 'activity' && completing === item.activityId}
              offline={offline}
              onComplete={onComplete}
              meetingTimes={meetingTimes}
            />
          )}
        />
      )}
      {timeline.olderError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${timeline.olderError.code}` as MessageId)}
        </p>
      )}
      {timeline.cursor === null ? null : (
        <div className="flex justify-center">
          <Button
            data-testid="timeline-load-older"
            data-requires-connection=""
            disabled={offline || timeline.loadingOlder}
            onClick={onLoadOlder}
          >
            {timeline.loadingOlder ? t.t('records.loadingMore') : t.t('record.timeline.loadOlder')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Runs of consecutive items on the same local day, each under its heading.
 * Served order is kept exactly: an item older than the one before it but on
 * a later day starts a new run rather than moving.
 */
function DayGroups({
  t,
  locale,
  items,
  render,
}: {
  t: Translator;
  locale: string;
  items: readonly TimelineItem[];
  render: (item: TimelineItem) => React.ReactNode;
}) {
  if (items.length === 0) {
    return (
      <p data-testid="timeline-filter-empty" className="flex items-center gap-2 rounded-md bg-surface-sunken p-4 text-body-sm text-text-2">
        <Icon name="history" size="sm" />
        {t.t('record.timeline.filterEmpty')}
      </p>
    );
  }
  const runs: { key: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.occurredAt);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.key === key) last.items.push(item);
    else runs.push({ key, items: [item] });
  }
  return (
    <div className="flex flex-col">
      {runs.map((run, index) => {
        const heading = dayHeading(locale, run.key);
        return (
          <section key={`${run.key}-${index}`} className="flex flex-col">
            <h3 className="pb-2.5 pt-1.5 text-caption font-bold uppercase tracking-wider text-text-muted">
              {heading.kind === 'today' ? (
                t.t('record.timeline.today')
              ) : heading.kind === 'yesterday' ? (
                t.t('record.timeline.yesterday')
              ) : (
                <time dateTime={run.key}>{heading.text}</time>
              )}
            </h3>
            <ol className="flex flex-col">{run.items.map(render)}</ol>
          </section>
        );
      })}
    </div>
  );
}
