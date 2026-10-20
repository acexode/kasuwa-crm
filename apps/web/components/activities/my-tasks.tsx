'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Avatar, Button, IconButton } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { withheld, type ActivityBucket, type MyActivity } from '../../lib/activities-api';
import type { RecordsError } from '../../lib/records-api';
import { BUCKETS, bucketLabel, dayKey, snoozeLabel, snoozeOptions, tasksView, type BucketState } from './activities-model';
import { DueTime, Related, Subject } from './activity-parts';
import { formatDayShort, formatWhen } from './activity-format';
import { ToggleChip } from './activity-chips';

/**
 * P07/01–08 — My tasks: overdue, today and upcoming, each its own read, each
 * drawn in the order the server served it and named, never counted (D-P13).
 * A row completes, snoozes to a preset, or opens the reschedule form. Write
 * controls show to every caller and the API's 403 is the gate (D-L84); a row
 * whose own fields say it cannot be written offers no such control.
 *
 * T-0136 draws it to the export: each bucket a card with a 48px header (the
 * Overdue card edged in danger), rows with the completion circle on the left
 * and the owner and an icon-only snooze on the right, the filter chips above
 * without their counts (D-P13), and the "all caught up" hero. The row
 * checkboxes and bulk bar are not drawn (D-L105); each row and header keeps
 * the checkbox's width, so everything stays where the design puts it.
 */

export interface TaskActions {
  readonly offline: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onComplete: (item: MyActivity) => void;
  readonly onSnooze: (item: MyActivity, at: Date) => void;
  readonly onReschedule: (item: MyActivity) => void;
}

const MENU_ITEM =
  'flex min-h-touch w-full items-center gap-2 rounded-6 px-2.5 text-start text-body-sm text-text is-hover:bg-surface-sunken is-focus-visible:ring-focus disabled:text-disabled-text';

function SnoozeMenu({
  t,
  locale,
  item,
  actions,
  onClose,
}: {
  t: Translator;
  locale: string;
  item: MyActivity;
  actions: TaskActions;
  onClose: (returnFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const options = snoozeOptions(new Date(), item.dueAt ?? null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && !ref.current.parentElement?.contains(target)) onClose(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="snooze-menu"
      role="group"
      aria-labelledby={labelId}
      className="absolute end-0 top-full z-10 mt-1 flex w-60 flex-col rounded-10 border border-border bg-surface-raised p-1 shadow-2"
    >
      <p id={labelId} className="px-2.5 pb-1 pt-1.5 text-overline text-text-muted">
        {t.t('activities.snooze.menu')}
      </p>
      {options.map((option) => (
        <button
          key={option.preset}
          type="button"
          data-snooze-option={option.preset}
          data-requires-connection=""
          disabled={actions.offline}
          onClick={() => {
            onClose(false);
            actions.onSnooze(item, option.at);
          }}
          className={MENU_ITEM}
        >
          <span className="flex-1">{t.t(snoozeLabel(option.preset))}</span>
          <time dateTime={option.at.toISOString()} className="font-mono text-micro font-normal text-text-muted">
            {formatWhen(locale, option.at)}
          </time>
        </button>
      ))}
      <button
        type="button"
        data-action="reschedule"
        onClick={() => {
          onClose(false);
          actions.onReschedule(item);
        }}
        className={`${MENU_ITEM} mt-1 border-t border-border`}
      >
        <Icon name="edit" size={18} />
        <span className="flex-1">{t.t('activities.snooze.pick')}</span>
      </button>
    </div>
  );
}

function TaskRow({
  t,
  locale,
  item,
  bucket,
  owner,
  priority,
  actions,
}: {
  t: Translator;
  locale: string;
  item: MyActivity;
  bucket: ActivityBucket;
  owner: string | null;
  priority: boolean;
  actions: TaskActions;
}) {
  const [menu, setMenu] = useState(false);
  const snoozeRef = useRef<HTMLButtonElement>(null);
  const busy = actions.busy.has(item.id);
  // A completion or a due time the caller cannot read is one they cannot write.
  const canComplete = !withheld(item, 'completedAt');
  const canMove = !withheld(item, 'dueAt');

  return (
    <li
      data-activity={item.id}
      data-activity-type="task"
      className="relative flex items-start gap-2 border-b border-border py-2 pe-2.5 ps-2 last:border-b-0"
    >
      {/* The design's 32px selection column (D-L105: no selection, the place kept). */}
      <span aria-hidden="true" className="hidden w-8 shrink-0 md:block" />
      {canComplete ? (
        <button
          type="button"
          data-action="complete-task"
          data-requires-connection=""
          aria-label={t.t('record.activity.complete')}
          disabled={actions.offline || busy}
          onClick={() => actions.onComplete(item)}
          className="group flex size-touch shrink-0 items-center justify-center rounded-full text-text is-focus-visible:ring-focus disabled:cursor-not-allowed"
        >
          <span className="flex size-6 items-center justify-center rounded-full border-2 border-border-strong text-transparent transition-colors duration-quick group-hover:border-success group-hover:text-success group-disabled:border-disabled-text">
            <Icon name="check" size={18} />
          </span>
        </button>
      ) : (
        <span aria-hidden="true" className="flex size-touch shrink-0 items-center justify-center">
          <span className="size-6 rounded-full border-2 border-dashed border-border" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5">
        <Subject t={t} item={item} className="break-words text-label text-text" />
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-text-2">
          {priority ? (
            <span
              data-placeholder="priority"
              className="inline-flex h-[22px] items-center gap-0.75 rounded-full bg-surface-sunken px-[7px] font-bold text-text-muted"
            >
              {t.t('activities.priority.none')}
            </span>
          ) : null}
          <DueTime t={t} locale={locale} item={item} bucket={bucket} />
          <Related t={t} item={item} />
        </div>
      </div>
      {owner === null ? null : (
        <span className="mt-[7px] shrink-0" title={owner}>
          <span className="sr-only">{t.t('activities.owner', { name: owner })}</span>
          <Avatar name={owner} size={32} locale={locale} className="!size-[30px] !bg-accent-soft !text-[11px] !text-accent-text" />
        </span>
      )}
      {canMove ? (
        <div className="relative shrink-0">
          <IconButton
            ref={snoozeRef}
            variant="ghost"
            icon="snooze"
            label={t.t('activities.task.snooze')}
            data-action="snooze"
            data-requires-connection=""
            aria-expanded={menu}
            disabled={actions.offline || busy}
            onClick={() => setMenu((open) => !open)}
            className={`!text-text-2 [&>.k-icon]:!text-icon-20 ${menu ? '!bg-surface-sunken' : ''}`}
          />
          {menu && !actions.offline ? (
            <SnoozeMenu
              t={t}
              locale={locale}
              item={item}
              actions={actions}
              onClose={(returnFocus) => {
                setMenu(false);
                if (returnFocus) snoozeRef.current?.focus();
              }}
            />
          ) : null}
        </div>
      ) : (
        <span aria-hidden="true" className="size-touch shrink-0" />
      )}
    </li>
  );
}

function errorText(error: RecordsError | null): MessageId {
  return `records.error.${error?.code ?? 'network'}` as MessageId;
}

const BUCKET_ICON = { overdue: 'error', today: 'today', upcoming: 'upcoming' } as const;

function Bucket({
  t,
  locale,
  bucket,
  state,
  owner,
  priority,
  actions,
  onRetry,
  onMore,
}: {
  t: Translator;
  locale: string;
  bucket: ActivityBucket;
  state: BucketState;
  owner: string | null;
  priority: boolean;
  actions: TaskActions;
  onRetry: () => void;
  onMore: () => void;
}) {
  const headingId = useId();
  const overdue = bucket === 'overdue';
  const today = new Date();
  return (
    <section
      data-bucket={bucket}
      aria-labelledby={headingId}
      className={`flex flex-col rounded-lg border bg-surface ${overdue ? 'border-danger' : 'border-border'}`}
    >
      <div className="flex min-h-12 items-center gap-2 border-b border-border px-3.5">
        <span aria-hidden="true" className="hidden w-[26px] shrink-0 md:block" />
        <Icon name={BUCKET_ICON[bucket]} size={18} className={overdue ? 'text-danger-text' : 'text-text'} />
        <h2 id={headingId} className={`text-label font-bold ${overdue ? 'text-danger-text' : 'text-text'}`}>
          {t.t(bucketLabel(bucket))}
          {bucket === 'today' ? (
            <>
              {' · '}
              <time dateTime={dayKey(today)}>{formatDayShort(locale, today)}</time>
            </>
          ) : null}
        </h2>
      </div>
      {state.phase === 'loading' ? (
        <div data-testid="bucket-skeleton" aria-busy="true" className="flex flex-col">
          <span role="status" className="sr-only">
            {t.t('activities.loading')}
          </span>
          {[0, 1].map((index) => (
            <span key={index} aria-hidden="true" className="flex items-start gap-2 border-b border-border py-2 pe-2.5 ps-2 last:border-b-0">
              <span className="hidden w-8 shrink-0 md:block" />
              <span className="flex size-touch shrink-0 items-center justify-center">
                <span className="size-6 rounded-full bg-surface-sunken" />
              </span>
              <span className="flex flex-1 flex-col gap-2 py-2">
                <span className="h-4 w-3/4 rounded-sm bg-surface-sunken" />
                <span className="h-3 w-1/3 rounded-sm bg-surface-sunken" />
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {state.phase === 'error' ? (
        <div role="alert" data-testid="bucket-error" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 text-meta text-danger-text">
          <Icon name="error" size={18} />
          <p className="min-w-0 flex-[1_1_200px]">
            <b>{t.t('activities.bucket.error')}</b> {t.t(errorText(state.error))}
          </p>
          <Button size="compact" data-requires-connection="" disabled={actions.offline} onClick={onRetry}>
            {t.t('records.retry')}
          </Button>
        </div>
      ) : null}
      {state.phase === 'ready' && state.rows.length === 0 ? (
        <p data-testid="bucket-empty" className="px-4 py-3.5 text-meta text-text-2">
          {t.t(`activities.bucket.empty.${bucket}` as MessageId)}
        </p>
      ) : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <ul className="flex flex-col">
          {state.rows.map((item) => (
            <TaskRow key={item.id} t={t} locale={locale} item={item} bucket={bucket} owner={owner} priority={priority} actions={actions} />
          ))}
        </ul>
      ) : null}
      {state.phase === 'ready' && state.cursor !== null ? (
        <div className="flex justify-center border-t border-border p-2">
          <Button
            variant="ghost"
            size="compact"
            data-testid="bucket-more"
            data-requires-connection=""
            disabled={actions.offline || state.loadingMore}
            onClick={onMore}
          >
            {state.loadingMore ? t.t('records.loadingMore') : t.t('records.loadMore')}
          </Button>
        </div>
      ) : null}
      {state.moreError !== null ? (
        <p role="alert" className="px-4 pb-3 text-meta text-danger-text">
          {t.t(errorText(state.moreError))}
        </p>
      ) : null}
    </section>
  );
}

type Filter = 'all' | 'high' | 'deals' | 'mine';

/**
 * The design's filter chips, without their counts (D-P13, D-L195). Every row
 * here is the caller's own, so "Mine only" and "All" draw the same list.
 * Priority and deal links are not in the contract: those two chips are drawn
 * disabled, and only where `activity_priority` is on (D-L194).
 */
function Filters({ t, priority, value, onChange }: { t: Translator; priority: boolean; value: Filter; onChange: (next: Filter) => void }) {
  const chips: readonly Filter[] = priority ? ['all', 'high', 'deals', 'mine'] : ['all', 'mine'];
  return (
    <div role="group" aria-label={t.t('activities.filter.label')} className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => {
        const unavailable = chip === 'high' || chip === 'deals';
        return (
          <ToggleChip
            key={chip}
            data-filter={chip}
            pressed={value === chip}
            disabled={unavailable}
            title={unavailable ? t.t('activities.unavailable') : undefined}
            onClick={() => onChange(chip)}
          >
            {t.t(`activities.filter.${chip}` as MessageId)}
          </ToggleChip>
        );
      })}
    </div>
  );
}

/** P07/05–06: every bucket read, and every one empty. */
function CaughtUp({ t, offline, onCompose, onPlan }: { t: Translator; offline: boolean; onCompose: () => void; onPlan: () => void }) {
  return (
    <section data-testid="tasks-empty" className="flex flex-1 items-center justify-center px-2 py-8">
      <div className="flex max-w-[440px] flex-col items-center gap-3 text-center">
        <div aria-hidden="true" className="relative flex h-24 w-[120px] items-center justify-center">
          <span className="absolute start-2 top-3.5 size-2.5 rotate-[20deg] rounded-[2px] bg-accent" />
          <span className="absolute end-3 top-1.5 size-2 rounded-full bg-chart-3" />
          <span className="absolute bottom-[22px] end-0 h-[5px] w-3 -rotate-[30deg] rounded-[2px] bg-primary" />
          <span className="absolute bottom-4 start-0 size-[7px] rounded-full bg-success" />
          <span className="absolute start-[30px] top-0 h-3 w-1.5 rotate-[35deg] rounded-[2px] bg-chart-5" />
          <span className="flex size-[72px] items-center justify-center rounded-full bg-success-soft text-success-text">
            <Icon name="task_alt" size={32} className="!text-[40px]" />
          </span>
        </div>
        <h2 className="text-h3 font-extrabold">{t.t('activities.caughtUp.title')}</h2>
        <p className="text-label font-normal leading-[23px] text-text-2">{t.t('activities.caughtUp.body')}</p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button data-action="compose-task" data-requires-connection="" disabled={offline} onClick={onCompose} className="!px-4 !text-body-sm !font-semibold">
            {t.t('activities.caughtUp.add')}
          </Button>
          <Button variant="ghost" onClick={onPlan} className="!px-3.5 !text-body-sm !font-semibold">
            {t.t('activities.caughtUp.plan')}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function MyTasks({
  t,
  locale,
  buckets,
  actions,
  owner,
  priority,
  onRetry,
  onMore,
  onCompose,
  onPlan,
}: {
  t: Translator;
  locale: string;
  buckets: Readonly<Record<ActivityBucket, BucketState>>;
  actions: TaskActions;
  /** The caller's name: every row here is their own (listMyActivities), so each carries their avatar. */
  owner: string | null;
  /** `activity_priority` (D-L194): the priority pill placeholder and the disabled chips. */
  priority: boolean;
  onRetry: (bucket: ActivityBucket) => void;
  onMore: (bucket: ActivityBucket) => void;
  onCompose: () => void;
  onPlan: () => void;
}) {
  const view = tasksView(buckets);
  const [filter, setFilter] = useState<Filter>('all');
  return (
    <div data-testid="my-tasks" className="flex flex-1 flex-col gap-3 md:gap-4">
      {view === 'caught-up' ? (
        <CaughtUp t={t} offline={actions.offline} onCompose={onCompose} onPlan={onPlan} />
      ) : (
        <>
          <Filters t={t} priority={priority} value={filter} onChange={setFilter} />
          {BUCKETS.map((bucket) => (
            <Bucket
              key={bucket}
              t={t}
              locale={locale}
              bucket={bucket}
              state={buckets[bucket]}
              owner={owner}
              priority={priority}
              actions={actions}
              onRetry={() => onRetry(bucket)}
              onMore={() => onMore(bucket)}
            />
          ))}
        </>
      )}
    </div>
  );
}

