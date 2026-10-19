import type { MessageId } from '@kasuwa/i18n/bundle';
import { RecordsErrorCode } from '../../lib/records-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { BUCKETS, bucketLabel, meetingRuleLabel, snoozeLabel, type MeetingRule, type SnoozePreset } from './activities-model';

/**
 * The strings P07 needs, resolved on the SERVER (T-0083).
 *
 * **No `'use client'` in this file, ever** — a server component importing a
 * client module's array gets a proxy, which fails at request time and not at
 * compile time (`app/client-boundary.test.ts`). Only these strings cross the
 * wire; the catalogues stay on the server.
 *
 * `message-ids.test.ts` checks every id the activities sources name is here.
 */

const SNOOZE_PRESETS: readonly SnoozePreset[] = ['hour', 'tomorrow', 'nextWeek'];
const MEETING_RULES: readonly MeetingRule[] = ['required', 'invalid_range', 'too_long'];

export const ACTIVITIES_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'activities.title',
  'activities.zone',
  'activities.compose',
  'activities.view.label',
  'activities.view.tasks',
  'activities.view.calendar',
  'activities.loading',
  ...BUCKETS.map(bucketLabel),
  ...BUCKETS.map((bucket) => `activities.bucket.empty.${bucket}` as MessageId),
  'activities.bucket.error',
  'activities.caughtUp.title',
  'activities.caughtUp.body',
  'activities.task.noSubject',
  'activities.task.undated',
  'activities.task.snooze',
  'activities.snooze.menu',
  ...SNOOZE_PRESETS.map(snoozeLabel),
  'activities.snooze.pick',
  'activities.related.contact',
  'activities.related.account',
  'activities.completion.locked',
  'activities.error.field_not_editable',
  'activities.offline.synced',
  // The calendar (loaded when first opened, but its strings ride with the page).
  'activities.calendar.range',
  'activities.calendar.week',
  'activities.calendar.month',
  'activities.calendar.prev',
  'activities.calendar.next',
  'activities.calendar.today',
  'activities.calendar.rangeTo',
  'activities.calendar.kasuwaOnly',
  'activities.calendar.loading',
  'activities.calendar.empty',
  'activities.calendar.error',
  // The reschedule form.
  'activities.reschedule',
  'activities.reschedule.title',
  'activities.reschedule.save',
  'activities.reschedule.hint',
  'activities.reschedule.gone',
  'activities.reschedule.stale',
  'activities.reschedule.error.dueRequired',
  'activities.field.startsAt',
  'activities.field.endsAt',
  ...MEETING_RULES.map(meetingRuleLabel),
  // The composer.
  'activities.compose.title',
  'activities.compose.type',
  'activities.compose.target',
  'activities.compose.target.hint',
  'activities.compose.target.searching',
  'activities.compose.target.failed',
  'activities.compose.target.none',
  'activities.compose.target.picked',
  'activities.compose.target.change',
  'activities.compose.error.subject',
  'activities.compose.error.target',
  'activities.compose.owner',
  // Shared with the P05 records: the types, the form's words, the refusals.
  'record.activity.type.task',
  'record.activity.type.meeting',
  'record.activity.due',
  'record.activity.done',
  'record.activity.complete',
  'record.form.subject',
  'record.form.save',
  'record.form.cancel',
  'record.sheet.close',
  'record.saving',
  'record.error.invalid',
  'record.error.stale',
  'record.conflict.otherChange',
  'records.locked',
  'records.name.withheld',
  'records.loadMore',
  'records.loadingMore',
  'records.retry',
  'records.offline.title',
  'records.offline.never',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
];
