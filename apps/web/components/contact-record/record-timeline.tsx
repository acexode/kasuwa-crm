'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import type { TimelineItem } from '../../lib/contact-record-api';
import { describeValue, fieldLabel, formatDateTime, type ValueView } from './record-model';
import type { TimelineState } from './use-contact-record';

/**
 * P05/01's centre column: what happened to the contact, newest first, as the
 * API serves it (T-0061).
 *
 * Every item once, in served order. `before` and `after` are drawn only where
 * the item carries them: the `[data-change]` elements exist exactly then, so
 * nothing on this screen can invent a value the audit trail withheld. Actors
 * by name, the system as one label. Every time is a `<time datetime>`, shown
 * in the browser's zone. No total, no "of", no page number (D-P13).
 */

const ICONS: Readonly<Record<string, IconName>> = {
  field_changed: 'edit',
  consent_changed: 'verified_user',
  note: 'edit_note',
  task: 'task_alt',
  call: 'call',
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

function Actor({ t, item }: { t: Translator; item: TimelineItem }) {
  return (
    <span data-actor="" className="font-semibold text-text">
      {item.actor === null ? t.t('record.system') : <span data-record-text="">{item.actor.displayName}</span>}
    </span>
  );
}

function Change({ t, field, item }: { t: Translator; field: string; item: { before?: unknown; after?: unknown } }) {
  if (!('before' in item) && !('after' in item)) return null;
  const side = (value: unknown) => describeValue(field, value as Parameters<typeof describeValue>[1]);
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
  canComplete,
  completing,
  offline,
  onComplete,
}: {
  t: Translator;
  locale: string;
  item: TimelineItem;
  canComplete: boolean;
  completing: boolean;
  offline: boolean;
  onComplete: (activityId: string) => void;
}) {
  let title: string;
  let icon: IconName;
  let body: React.ReactNode = null;

  if (item.type === 'activity') {
    icon = ICONS[item.activityType] ?? 'edit_note';
    title = t.t(`record.activity.type.${item.activityType}` as MessageId);
    const withheld = !('subject' in item) || !('body' in item);
    const done = item.completedAt !== null && item.completedAt !== undefined;
    body = (
      <div className={`flex flex-col gap-1 rounded-md p-3 text-body-sm ${item.activityType === 'note' ? 'bg-note-bg' : 'bg-surface-sunken'}`}>
        {typeof item.subject === 'string' ? (
          <b data-record-text="" className="break-words">
            {item.subject}
          </b>
        ) : null}
        {typeof item.body === 'string' ? (
          <p data-record-text="" className="whitespace-pre-wrap break-words text-text-2">
            {item.body}
          </p>
        ) : null}
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
              className={`${SECONDARY_BUTTON} disabled:opacity-60`}
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
    const label = fieldLabel(field);
    title = t.t('record.timeline.changed', { field: label === null ? field : t.t(label) });
    body =
      item.type === 'field_changed' && item.redacted === true ? (
        <p className="text-body-sm text-text-muted">{t.t('record.timeline.redacted')}</p>
      ) : (
        <Change t={t} field={field} item={item} />
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
      className="flex min-w-0 gap-3"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text">
        <Icon name={icon} size="sm" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 border-b border-border pb-4">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-text-2">
          <b className="text-text">{title}</b>
          <span aria-hidden="true">{'·'}</span>
          <Actor t={t} item={item} />
          <span aria-hidden="true">{'·'}</span>
          <When locale={locale} iso={item.occurredAt} />
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
  versions,
  completing,
  offline,
  onRetry,
  onLoadOlder,
  onComplete,
}: {
  t: Translator;
  locale: string;
  timeline: TimelineState;
  versions: Readonly<Record<string, number>>;
  completing: string | null;
  offline: boolean;
  onRetry: () => void;
  onLoadOlder: () => void;
  onComplete: (activityId: string) => void;
}) {
  if (timeline.phase === 'loading') {
    return (
      <div data-testid="timeline" aria-busy="true" className="flex flex-col gap-3">
        <span role="status" className="sr-only">
          {t.t('record.loading')}
        </span>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} aria-hidden="true" className="flex gap-3">
            <span className="h-8 w-8 shrink-0 rounded-full bg-surface-sunken" />
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
    <div data-testid="timeline" className="flex flex-col gap-4">
      {timeline.items.length === 0 ? (
        <p data-testid="timeline-empty" className="flex items-center gap-2 rounded-md bg-surface-sunken p-4 text-body-sm text-text-2">
          <Icon name="history" size="sm" />
          {t.t('record.timeline.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {timeline.items.map((item) => (
            <Item
              key={item.id}
              t={t}
              locale={locale}
              item={item}
              canComplete={item.type === 'activity' && versions[item.activityId] !== undefined}
              completing={item.type === 'activity' && completing === item.activityId}
              offline={offline}
              onComplete={onComplete}
            />
          ))}
        </ol>
      )}
      {timeline.olderError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${timeline.olderError.code}` as MessageId)}
        </p>
      )}
      {timeline.cursor === null ? null : (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="timeline-load-older"
            data-requires-connection=""
            disabled={offline || timeline.loadingOlder}
            onClick={onLoadOlder}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            {timeline.loadingOlder ? t.t('records.loadingMore') : t.t('record.timeline.loadOlder')}
          </button>
        </div>
      )}
    </div>
  );
}
