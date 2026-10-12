'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS, MENU_ROW, POPOVER } from '../records/list-classes';
import { withheld, type ActivityBucket, type MyActivity } from '../../lib/activities-api';
import type { RecordsError } from '../../lib/records-api';
import { BUCKETS, bucketLabel, snoozeLabel, snoozeOptions, tasksView, type BucketState } from './activities-model';
import { DueTime, Related, Subject } from './activity-parts';
import { formatWhen } from './activity-format';

/**
 * P07/01 — My tasks: overdue, today and upcoming, each its own read, each
 * drawn in the order the server served it and named, never counted (D-P13).
 * A row completes, snoozes to a preset, or opens the reschedule form. Write
 * controls show to every caller and the API's 403 is the gate (D-L84); a row
 * whose own fields say it cannot be written offers no such control.
 */

const ROW_BUTTON = `flex min-h-touch items-center justify-center gap-1 rounded-md border border-border px-3 text-body-sm font-semibold text-text hover:bg-surface-sunken disabled:opacity-60 ${FOCUS}`;

export interface TaskActions {
  readonly offline: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onComplete: (item: MyActivity) => void;
  readonly onSnooze: (item: MyActivity, at: Date) => void;
  readonly onReschedule: (item: MyActivity) => void;
}

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
      className={`absolute end-0 top-full mt-1 w-64 ${POPOVER}`}
    >
      <p id={labelId} className="px-2 py-1 text-caption font-bold text-text-muted">
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
          className={`${MENU_ROW} flex-col items-start justify-center gap-0 py-1`}
        >
          <span className="font-semibold">{t.t(snoozeLabel(option.preset))}</span>
          <time dateTime={option.at.toISOString()} className="text-caption text-text-2">
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
        className={`${MENU_ROW} border-t border-border`}
      >
        <Icon name="edit" size="sm" />
        {t.t('activities.snooze.pick')}
      </button>
    </div>
  );
}

function TaskRow({ t, locale, item, actions }: { t: Translator; locale: string; item: MyActivity; actions: TaskActions }) {
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
      className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Subject t={t} item={item} className="break-words text-body-md font-semibold" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-text-2">
          <DueTime t={t} locale={locale} item={item} />
          <Related t={t} item={item} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {canComplete ? (
          <button
            type="button"
            data-action="complete-task"
            data-requires-connection=""
            disabled={actions.offline || busy}
            onClick={() => actions.onComplete(item)}
            className={ROW_BUTTON}
          >
            <Icon name="check_circle" size="sm" />
            {t.t('record.activity.complete')}
          </button>
        ) : null}
        {canMove ? (
          <div className="relative">
            <button
              ref={snoozeRef}
              type="button"
              data-action="snooze"
              data-requires-connection=""
              aria-expanded={menu}
              disabled={actions.offline || busy}
              onClick={() => setMenu((open) => !open)}
              className={ROW_BUTTON}
            >
              <Icon name="alarm" size="sm" />
              {t.t('activities.task.snooze')}
            </button>
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
        ) : null}
      </div>
    </li>
  );
}

function errorText(error: RecordsError | null): MessageId {
  return `records.error.${error?.code ?? 'network'}` as MessageId;
}

function Bucket({
  t,
  locale,
  bucket,
  state,
  actions,
  onRetry,
  onMore,
}: {
  t: Translator;
  locale: string;
  bucket: ActivityBucket;
  state: BucketState;
  actions: TaskActions;
  onRetry: () => void;
  onMore: () => void;
}) {
  const headingId = useId();
  return (
    <section data-bucket={bucket} aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-center gap-2 text-h5 font-bold">
        <Icon name={bucket === 'overdue' ? 'warning' : bucket === 'today' ? 'schedule' : 'event'} size="sm" />
        {t.t(bucketLabel(bucket))}
      </h2>
      {state.phase === 'loading' ? (
        <div data-testid="bucket-skeleton" aria-busy="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <span role="status" className="sr-only">
            {t.t('activities.loading')}
          </span>
          {[0, 1].map((index) => (
            <span key={index} aria-hidden="true" className="flex flex-col gap-2 py-1">
              <span className="h-4 w-3/4 rounded-sm bg-surface-sunken" />
              <span className="h-3 w-1/3 rounded-sm bg-surface-sunken" />
            </span>
          ))}
        </div>
      ) : null}
      {state.phase === 'error' ? (
        <div
          role="alert"
          data-testid="bucket-error"
          className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-3 text-body-sm text-danger-text"
        >
          <p className="flex items-center gap-2 font-bold">
            <Icon name="error" size="sm" />
            {t.t('activities.bucket.error')}
          </p>
          <p>{t.t(errorText(state.error))}</p>
          <button type="button" data-requires-connection="" disabled={actions.offline} onClick={onRetry} className={QUIET_BUTTON}>
            {t.t('records.retry')}
          </button>
        </div>
      ) : null}
      {state.phase === 'ready' && state.rows.length === 0 ? (
        <p data-testid="bucket-empty" className="rounded-lg border border-dashed border-border px-3 py-3 text-body-sm text-text-2">
          {t.t(`activities.bucket.empty.${bucket}` as MessageId)}
        </p>
      ) : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <ul className="flex flex-col rounded-lg border border-border bg-surface">
          {state.rows.map((item) => (
            <TaskRow key={item.id} t={t} locale={locale} item={item} actions={actions} />
          ))}
        </ul>
      ) : null}
      {state.phase === 'ready' && state.cursor !== null ? (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="bucket-more"
            data-requires-connection=""
            disabled={actions.offline || state.loadingMore}
            onClick={onMore}
            className={SECONDARY_BUTTON}
          >
            {state.loadingMore ? t.t('records.loadingMore') : t.t('records.loadMore')}
          </button>
        </div>
      ) : null}
      {state.moreError !== null ? (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(errorText(state.moreError))}
        </p>
      ) : null}
    </section>
  );
}

export function MyTasks({
  t,
  locale,
  buckets,
  actions,
  onRetry,
  onMore,
}: {
  t: Translator;
  locale: string;
  buckets: Readonly<Record<ActivityBucket, BucketState>>;
  actions: TaskActions;
  onRetry: (bucket: ActivityBucket) => void;
  onMore: (bucket: ActivityBucket) => void;
}) {
  const view = tasksView(buckets);
  return (
    <div data-testid="my-tasks" className="flex flex-col gap-6">
      {view === 'caught-up' ? (
        <section data-testid="tasks-empty" className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-4 py-10 text-center">
          <Icon name="task_alt" size="xl" className="text-success-text" />
          <h2 className="text-h4 font-bold">{t.t('activities.caughtUp.title')}</h2>
          <p className="max-w-prose text-body-md text-text-2">{t.t('activities.caughtUp.body')}</p>
        </section>
      ) : (
        BUCKETS.map((bucket) => (
          <Bucket
            key={bucket}
            t={t}
            locale={locale}
            bucket={bucket}
            state={buckets[bucket]}
            actions={actions}
            onRetry={() => onRetry(bucket)}
            onMore={() => onMore(bucket)}
          />
        ))
      )}
    </div>
  );
}
