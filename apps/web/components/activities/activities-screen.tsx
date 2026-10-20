'use client';

import dynamic from 'next/dynamic';
import { useReadOnlyKeys } from '../custom/use-custom-fields';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Banner, Button, IconButton, SegmentedControl, Tabs, type SegmentedOption, type TabItem } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
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
import type { ActivitiesPlaceholders } from '../../lib/feature-flags';
import { versionOf } from './activities-model';
import { formatClockTime, zonePill } from './activity-format';
import { MyTasks } from './my-tasks';
import { useActivities } from './use-activities';

/**
 * P07 — Activities (T-0083, T-0136, `docs/design/P07/`): My tasks by bucket
 * (P07/01–08), the calendar (P07/09–18), the "Log activity" composer
 * (P07/19–21) and the reschedule form, behind its own flag, which only the
 * server page reads. T-0136 draws it to the export: one header row with the
 * segmented views and the zone pill, the phone's own app bar and underline
 * tabs, and the inverse offline banner.
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
 * FLAGGED PLACEHOLDERS (D-L194). Booking pages, check-in, the calendar's
 * not-connected furniture, the priority pill and the reminder channels are
 * drawn in the design's empty or disabled state, each behind its own flag
 * (`placeholders`, read on the server). Off, none is drawn.
 *
 * HIDDEN, BECAUSE THE CONTRACT HAS NO HOME FOR THEM (D-L105, D-P13, D-P21,
 * D-P22): bulk actions, Undo, holidays, the AI brief, the offline queue and
 * every count.
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
const BookingPages = dynamic(() => import('./activity-booking').then((module) => module.BookingPages), {
  ssr: false,
  loading: PanelLoading,
});
const FieldCheckin = dynamic(() => import('./activity-checkin').then((module) => module.FieldCheckin), {
  ssr: false,
  loading: PanelLoading,
});

function PanelLoading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

type View = 'tasks' | 'calendar' | 'booking' | 'checkin';

/** The flags that are on, by name: an empty list (all off) serialises to `[]`, naming nothing. */
function placeholderFlags(on: readonly (keyof ActivitiesPlaceholders)[]): ActivitiesPlaceholders {
  return {
    calendarSync: on.includes('calendarSync'),
    bookingPages: on.includes('bookingPages'),
    fieldCheckin: on.includes('fieldCheckin'),
    priority: on.includes('priority'),
    reminders: on.includes('reminders'),
  };
}

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
  placeholders: enabled = [],
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links. */
  live: readonly string[];
  /** Custom values are on in this process (read by the server page): the composer offers the activity's fields (T-0091). */
  customFields?: boolean;
  /** P07's flagged placeholders that are on (T-0136, D-L194), read by the server page. */
  placeholders?: readonly (keyof ActivitiesPlaceholders)[];
}) {
  const placeholders = placeholderFlags(enabled);
  const t = createBundleTranslator(locale, messages);
  const data = useActivities();
  const activityKeys = useReadOnlyKeys();
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

  const show = (next: View) => {
    setView(next);
    if (next === 'calendar') data.openCalendar();
  };

  const compose = async (activity: ComposedActivity, owner: string): Promise<RecordsResult<WrittenActivity>> => {
    const result = await createActivity(activity, owner);
    if (result.ok) {
      noteVersion(result.value.id, result.value.version);
      await refreshAll();
    }
    return result;
  };

  const openComposer = () => {
    if (!offline) setComposing(true);
  };

  const zone = data.zone === null ? '' : zonePill();

  // The design's third view is Booking pages on a desk and Check-in on a
  // phone; each is drawn only where its flag is on (D-L194).
  const viewIcon = { tasks: 'task_alt', calendar: 'calendar_month', booking: 'event_available', checkin: 'where_to_vote' } as const;
  const desktopViews: View[] = ['tasks', 'calendar', ...(placeholders.bookingPages ? (['booking'] as const) : [])];
  const phoneViews: View[] = ['tasks', 'calendar', ...(placeholders.fieldCheckin ? (['checkin'] as const) : [])];
  const viewLabel = (option: View) => t.t(`activities.view.${option}` as MessageId);
  const viewAction = (option: View) => ({ 'data-action': `view-${option}` });

  const segments: SegmentedOption[] = desktopViews.map((option) => ({
    value: option,
    label: viewLabel(option),
    icon: viewIcon[option],
    attributes: viewAction(option),
  }));
  const phoneTabs: TabItem[] = phoneViews.map((option) => ({
    value: option,
    label: viewLabel(option),
    attributes: viewAction(option),
  }));

  const barTitle = t.t(view === 'checkin' ? 'activities.bar.checkin' : view === 'calendar' ? 'activities.view.calendar' : view === 'booking' ? 'activities.view.booking' : 'activities.view.tasks');

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="activities"
      live={live}
      appBar={{
        title: barTitle,
        actions: (
          <IconButton
            variant="ghost"
            icon="add_circle"
            label={t.t('activities.compose')}
            data-action="compose"
            data-requires-connection=""
            disabled={offline}
            onClick={openComposer}
            className="!size-12 !text-primary-text [&>.k-icon]:!text-icon-28"
          />
        ),
      }}
    >
      <div data-screen="P07" className="flex min-h-full flex-col gap-3 md:gap-4 md:px-1">
        {/* Phone: the design's underline tabs, full width under the app bar. */}
        <div className="-mx-4 -mt-4 border-b border-border bg-surface px-2 md:hidden">
          <Tabs
            aria-label={t.t('activities.view.label')}
            items={phoneTabs}
            value={view}
            onValueChange={(next) => show(next as View)}
            className="grid auto-cols-fr grid-flow-col border-b-0 [&>button]:justify-center"
          />
        </div>

        {/* Desk: one row — the title, the views, the zone and New activity. */}
        <header className="hidden flex-wrap items-center gap-x-4 gap-y-2.5 md:flex">
          <h1 className="text-title">{t.t('activities.title')}</h1>
          <SegmentedControl
            aria-label={t.t('activities.view.label')}
            options={segments}
            value={view}
            onValueChange={(next) => show(next as View)}
            className="!gap-0.5 !rounded-10 [&>button]:!h-[38px] [&>button]:!rounded-[7px]"
          />
          <span className="flex-1" />
          {zone === '' ? null : (
            <span
              data-testid="zone-pill"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-primary-soft px-2.5 text-caption font-bold text-primary-text"
            >
              <Icon name="schedule" size={15} />
              <span className="sr-only">{t.t('activities.zone.label')}</span>
              {zone}
            </span>
          )}
          <Button
            variant="primary"
            icon="add"
            data-action="compose"
            data-requires-connection=""
            disabled={offline}
            onClick={openComposer}
            className="!px-4"
          >
            {t.t('activities.compose')}
          </Button>
        </header>

        {offline ? (
          <div data-testid="offline-banner">
            <Banner tone="offline" title={t.t('records.offline.title')} className="!ps-3.5">
              {data.syncedAt === null ? null : (
                <>
                  {t.t('activities.offline.synced')}{' '}
                  <time dateTime={data.syncedAt.toISOString()}>{formatClockTime(locale, data.syncedAt)}</time>
                  {'. '}
                </>
              )}
              {t.t('records.offline.never')}
            </Banner>
          </div>
        ) : null}

        {notice === null ? null : <Banner tone="danger">{t.t(notice)}</Banner>}

        {view === 'tasks' ? (
          <MyTasks
            t={t}
            locale={locale}
            buckets={data.buckets}
            actions={actions}
            owner={data.meName}
            priority={placeholders.priority}
            onRetry={data.retryBucket}
            onMore={(bucket) => void data.loadMore(bucket)}
            onCompose={openComposer}
            onPlan={() => show('calendar')}
          />
        ) : null}
        {view === 'calendar' ? (
          <ActivitiesCalendar
            t={t}
            locale={locale}
            view={data.calendarView}
            state={data.calendar}
            actions={actions}
            sync={placeholders.calendarSync}
            onShow={data.showCalendar}
            onRetry={data.retryCalendar}
          />
        ) : null}
        {view === 'booking' && placeholders.bookingPages ? <BookingPages t={t} owner={data.meName} /> : null}
        {view === 'checkin' && placeholders.fieldCheckin ? <FieldCheckin t={t} /> : null}
      </div>

      {composing ? (
        <ActivityComposer
          t={t}
          locale={locale}
          offline={offline}
          whoAmI={data.whoAmI}
          onSave={compose}
          onClose={() => setComposing(false)}
          customFields={customFields}
          readOnlyStore={activityKeys}
          visit={placeholders.fieldCheckin}
          reminders={placeholders.reminders}
        />
      ) : null}
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
