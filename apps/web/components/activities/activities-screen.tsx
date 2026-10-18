'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { PRIMARY_BUTTON } from '../auth/button-classes';
import { CHIP, CHIP_OFF, CHIP_ON } from '../records/list-classes';
import { writeErrorId } from '../record/record-core';
import { hasDetail, type RecordsError, type RecordsResult } from '../../lib/records-api';
import {
  createActivity,
  updateActivity,
  type ActivityChange,
  type ComposedActivity,
  type MyActivity,
  type WrittenActivity,
} from '../../lib/activities-api';
import { versionOf } from './activities-model';
import { formatClockTime, zoneLabel } from './activity-format';
import { MyTasks } from './my-tasks';
import { useActivities } from './use-activities';

/**
 * P07 — Activities (T-0083, `docs/design/P07/`): My tasks by bucket
 * (P07/01–02), the calendar (P07/03–05), the composer (P07/07) and the
 * reschedule form, behind its own flag, which only the server page reads.
 *
 * ---------------------------------------------------------------------------
 * THE ZONE IS THE BROWSER'S. Buckets are the server's, computed in the zone
 * the browser resolves and sends; every time drawn is in that zone, inside a
 * `<time datetime>`. The design's "always WAT" is the reader's own zone here.
 *
 * NOTHING IS OPTIMISTIC. A complete, snooze or reschedule sends `version`
 * plus only what changed (D-L102); the lists are read again from the top when
 * the server answers, and a row moves when the server says it has. A 409 is
 * re-read and rebased; a 403 `field_not_editable` is its own sentence and is
 * never retried.
 *
 * HIDDEN, BECAUSE THE CONTRACT HAS NO HOME FOR THEM (D-L105, D-P13, D-P21,
 * D-P22): priority, bulk actions, Undo, external calendars and "connect your
 * calendar", holidays, the AI brief, booking pages, check-in, attendees,
 * locations, reminder channels, the offline queue and every count.
 *
 * IN MEMORY ONLY (D-L64). Offline, every write is off and nothing queues.
 * ---------------------------------------------------------------------------
 */

const ActivitiesCalendar = dynamic(() => import('./activities-calendar').then((module) => module.ActivitiesCalendar), {
  ssr: false,
  loading: PanelLoading,
});
const ActivityComposer = dynamic(() => import('./activity-composer').then((module) => module.ActivityComposer), {
  ssr: false,
});
const RescheduleForm = dynamic(() => import('./reschedule-form').then((module) => module.RescheduleForm), {
  ssr: false,
});

function PanelLoading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

type View = 'tasks' | 'calendar';

/** The sentence for a refused write. `field_not_editable` is its own: a role that can read a time but not move it. */
function refusal(error: RecordsError): MessageId {
  if (hasDetail(error, 'field_not_editable')) return 'activities.error.field_not_editable';
  return writeErrorId(error.code);
}

export function ActivitiesScreen({
  locale,
  messages,
  locales,
  live,
  customFields = false,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links. */
  live: readonly string[];
  /** Custom values are on in this process (read by the server page): the composer offers the activity's fields (T-0091). */
  customFields?: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const data = useActivities();
  const [view, setView] = useState<View>('tasks');
  const [composing, setComposing] = useState(false);
  const [rescheduling, setRescheduling] = useState<MyActivity | null>(null);
  const [notice, setNotice] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const offline = !data.online;
  const { refreshAll, noteVersion, versions } = data;

  const setBusyFor = useCallback((id: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** One update, then everything read again before the controls come back: the server says where it went. */
  const write = useCallback(
    async (id: string, change: ActivityChange): Promise<RecordsResult<WrittenActivity>> => {
      const result = await updateActivity(id, change);
      if (result.ok) {
        noteVersion(id, result.value.version);
        await refreshAll();
      }
      return result;
    },
    [noteVersion, refreshAll],
  );

  /** Complete or snooze from a row: a refusal is the notice; a 409 re-reads, and the person tries again. */
  const quickWrite = useCallback(
    async (item: MyActivity, change: Omit<ActivityChange, 'version'>) => {
      if (offline || busy.has(item.id)) return;
      setNotice(null);
      setBusyFor(item.id, true);
      const result = await write(item.id, { version: versionOf(item, versions), ...change });
      if (!result.ok) {
        setNotice(refusal(result.error));
        if (result.error.code === 'stale_write') await refreshAll();
      }
      setBusyFor(item.id, false);
    },
    [offline, busy, write, versions, refreshAll, setBusyFor],
  );

  const onComplete = useCallback((item: MyActivity) => void quickWrite(item, { completed: true }), [quickWrite]);
  const onSnooze = useCallback((item: MyActivity, at: Date) => void quickWrite(item, { dueAt: at.toISOString() }), [quickWrite]);
  const onReschedule = useCallback((item: MyActivity) => {
    setNotice(null);
    setRescheduling(item);
  }, []);

  const actions = { offline, busy, onComplete, onSnooze, onReschedule };

  const openCalendar = () => {
    setView('calendar');
    data.openCalendar();
  };

  const compose = async (activity: ComposedActivity, owner: string): Promise<RecordsResult<WrittenActivity>> => {
    const result = await createActivity(activity, owner);
    if (result.ok) {
      noteVersion(result.value.id, result.value.version);
      await refreshAll();
    }
    return result;
  };

  const zone = data.zone === null ? '' : zoneLabel(locale);

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="activities" live={live}>
      <div data-screen="P07" className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-h3 font-bold">{t.t('activities.title')}</h1>
            {zone === '' ? null : (
              <p className="flex items-center gap-1 text-body-sm text-text-2">
                <Icon name="schedule" size="sm" />
                {t.t('activities.zone', { zone })}
              </p>
            )}
          </div>
          <button
            type="button"
            data-action="compose"
            data-requires-connection=""
            disabled={offline}
            onClick={() => setComposing(true)}
            className={PRIMARY_BUTTON}
          >
            <Icon name="add" size="sm" />
            {t.t('activities.compose')}
          </button>
        </header>

        {offline ? (
          <div
            role="status"
            data-testid="offline-banner"
            className="flex items-start gap-3 rounded-lg border border-warning bg-warning-soft p-3 text-body-sm text-warning-text"
          >
            <Icon name="cloud_off" size="sm" />
            <p>
              <b>{t.t('records.offline.title')}</b>{' '}
              {data.syncedAt === null ? null : (
                <>
                  {t.t('activities.offline.synced')}{' '}
                  <time dateTime={data.syncedAt.toISOString()}>{formatClockTime(locale, data.syncedAt)}</time>{' '}
                </>
              )}
              {t.t('records.offline.never')}
            </p>
          </div>
        ) : null}

        {notice === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(notice)}
          </p>
        )}

        <div role="group" aria-label={t.t('activities.view.label')} className="flex flex-wrap gap-2">
          <button
            type="button"
            data-action="view-tasks"
            aria-pressed={view === 'tasks'}
            onClick={() => setView('tasks')}
            className={`${CHIP} ${view === 'tasks' ? CHIP_ON : CHIP_OFF}`}
          >
            <Icon name="task_alt" size="sm" />
            {t.t('activities.view.tasks')}
          </button>
          <button
            type="button"
            data-action="view-calendar"
            aria-pressed={view === 'calendar'}
            onClick={openCalendar}
            className={`${CHIP} ${view === 'calendar' ? CHIP_ON : CHIP_OFF}`}
          >
            <Icon name="event" size="sm" />
            {t.t('activities.view.calendar')}
          </button>
        </div>

        {view === 'tasks' ? (
          <MyTasks t={t} locale={locale} buckets={data.buckets} actions={actions} onRetry={data.retryBucket} onMore={(bucket) => void data.loadMore(bucket)} />
        ) : (
          <ActivitiesCalendar
            t={t}
            locale={locale}
            view={data.calendarView}
            state={data.calendar}
            actions={actions}
            onShow={data.showCalendar}
            onRetry={data.retryCalendar}
          />
        )}
      </div>

      {composing ? <ActivityComposer t={t} offline={offline} whoAmI={data.whoAmI} onSave={compose} onClose={() => setComposing(false)} customFields={customFields} /> : null}
      {rescheduling === null ? null : (
        <RescheduleForm
          t={t}
          item={rescheduling}
          versions={versions}
          offline={offline}
          onSave={(id, body) => write(id, body as unknown as ActivityChange)}
          onStale={async (id) => (await refreshAll()).find((row) => row.id === id) ?? null}
          onClose={() => setRescheduling(null)}
        />
      )}
    </CrmShell>
  );
}
