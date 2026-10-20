'use client';

import { useId, useState, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import type { TimelineItem } from '../../lib/contact-record-api';
import { Icon } from '../icon';
import { zoneName } from './record-core';
import { RecordTimeline } from './record-timeline';
import { CARD, CARD_TITLE } from './record-ui';

/**
 * P05's Timeline card (T-0134): the title, "All times WAT", the type filter
 * pills and the timeline. The pills filter what is loaded, in memory; they
 * carry no counts (D-P13: a count of loaded items reads as a total). Pills for
 * channels whose module does not exist yet (WhatsApp, SMS, Email, Tickets,
 * Payments, E-invoices) are drawn only where their D-L194 flag is on, and
 * select nothing.
 */

type FilterKey =
  | 'all'
  | 'call'
  | 'whatsapp'
  | 'sms'
  | 'email'
  | 'note'
  | 'task'
  | 'meeting'
  | 'changes'
  | 'tickets'
  | 'payments'
  | 'einvoices';

interface FilterSpec {
  readonly key: FilterKey;
  readonly icon: IconName;
  readonly label: MessageId;
  readonly match: (item: TimelineItem) => boolean;
}

const nothing = () => false;
const activity = (type: string) => (item: TimelineItem) => item.type === 'activity' && item.activityType === type;

const BASE: readonly FilterSpec[] = [
  { key: 'all', icon: 'forum', label: 'record.timeline.filter.all', match: () => true },
  { key: 'call', icon: 'call', label: 'record.timeline.filter.calls', match: activity('call') },
];
const CHANNELS: readonly FilterSpec[] = [
  { key: 'whatsapp', icon: 'chat', label: 'records.channel.whatsapp', match: nothing },
  { key: 'sms', icon: 'sms', label: 'records.channel.sms', match: nothing },
  { key: 'email', icon: 'mail', label: 'records.channel.email', match: nothing },
];
const OWN: readonly FilterSpec[] = [
  { key: 'note', icon: 'sticky_note_2', label: 'record.timeline.filter.notes', match: activity('note') },
  { key: 'task', icon: 'task_alt', label: 'record.timeline.filter.tasks', match: activity('task') },
  { key: 'meeting', icon: 'event', label: 'record.timeline.filter.meetings', match: activity('meeting') },
  {
    key: 'changes',
    icon: 'edit',
    label: 'record.timeline.filter.changes',
    match: (item) => item.type === 'field_changed' || item.type === 'consent_changed',
  },
];
const MODULES: readonly FilterSpec[] = [
  { key: 'tickets', icon: 'confirmation_number', label: 'record.related.tickets', match: nothing },
  { key: 'payments', icon: 'payments', label: 'record.timeline.filter.payments', match: nothing },
  { key: 'einvoices', icon: 'receipt_long', label: 'record.timeline.filter.einvoices', match: nothing },
];

export type TimelineProps = Omit<Parameters<typeof RecordTimeline>[0], 'filter'>;

export function TimelineCard({
  t,
  locale,
  channels,
  modules,
  form,
  timeline,
}: {
  t: Translator;
  locale: string;
  /** The `whatsapp_composer` flag: draw the channel pills. */
  channels: boolean;
  /** The `record_related` flag: draw the tickets, payments and e-invoices pills. */
  modules: boolean;
  /** The activity form, when one is open. */
  form: ReactNode;
  timeline: TimelineProps;
}) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const heading = useId();
  const specs = [...BASE, ...(channels ? CHANNELS : []), ...OWN, ...(modules ? MODULES : [])];
  const active = specs.find((spec) => spec.key === filter) ?? BASE[0];

  return (
    <section aria-labelledby={heading} className={`${CARD} gap-3.5 p-4`}>
      <div className="flex items-center gap-2">
        <h2 id={heading} className={`${CARD_TITLE} flex-1`}>
          {t.t('record.timeline.title')}
        </h2>
        <span className="text-caption font-normal text-text-muted">{t.t('record.timeline.zone', { zone: zoneName(locale) })}</span>
      </div>
      <div role="group" aria-label={t.t('record.timeline.filter')} className="flex flex-wrap gap-1.5 pb-0.5">
        {specs.map((spec) => {
          const on = spec.key === filter;
          return (
            <button
              key={spec.key}
              type="button"
              aria-pressed={on}
              data-timeline-filter={spec.key}
              onClick={() => setFilter(spec.key)}
              className={`inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-meta font-semibold focus-visible:outline-none focus-visible:ring-focus ${
                on ? 'border-primary bg-primary text-on-primary' : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken'
              }`}
            >
              <Icon name={spec.icon} size={16} />
              {t.t(spec.label)}
            </button>
          );
        })}
      </div>
      {form}
      <RecordTimeline {...timeline} {...(filter === 'all' || active === undefined ? {} : { filter: active.match })} />
    </section>
  );
}
