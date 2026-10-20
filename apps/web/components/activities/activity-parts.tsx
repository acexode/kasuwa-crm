'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import { nameOrWithheld } from '../records/name';
import { Icon } from '../icon';
import { LockedValue } from '../records/list-parts';
import { recordHref } from '../record/record-core';
import { withheld, type ActivityBucket, type MyActivity } from '../../lib/activities-api';
import { dayOffset, formatClockTime, formatWhen, zoneSuffix } from './activity-format';

/**
 * The pieces a task row and a calendar event draw alike: the subject, the
 * due time and the contact or account it is about. A withheld field is a lock
 * ("Restricted"), never a blank and never a guess; record text is drawn as
 * text, never parsed; and a summary links only from a well-formed uuid.
 *
 * T-0136 draws them as the P07 rows do: a 12px meta line, the due time 600
 * with a 14px `schedule` (danger-text and "Overdue · " on an overdue row,
 * "12:00 WAT" on today's), and the record as "Contact · Emeka Obi" in
 * primary-text 600, never underlined.
 */

/** The subject, as text. `null` is "No subject"; withheld is a lock. */
export function Subject({ t, item, className = '' }: { t: Translator; item: MyActivity; className?: string }) {
  if (withheld(item, 'subject')) {
    return (
      <span data-field="subject" data-locked="true" className={`text-text-2 ${className}`}>
        <LockedValue t={t} />
      </span>
    );
  }
  const subject = item.subject ?? null;
  return (
    <span data-field="subject" className={className}>
      {subject === null || subject === '' ? (
        <span className="text-text-muted">{t.t('activities.task.noSubject')}</span>
      ) : (
        <span data-record-text="">{subject}</span>
      )}
    </span>
  );
}

/** How a row writes its due time: today's as the clock and the zone, yesterday's by name, the rest by date. */
function dueText(t: Translator, locale: string, due: string, bucket: ActivityBucket | undefined): string {
  if (bucket === 'today') return t.t('activities.due.today', { time: formatClockTime(locale, due), zone: zoneSuffix(new Date(due)) });
  if (dayOffset(due) === -1) return t.t('activities.due.yesterday', { time: formatClockTime(locale, due) });
  return formatWhen(locale, due);
}

/**
 * A task's due time in the browser's zone, inside a `<time>`. Undated says
 * so; a due time the caller may not read is a lock — never "no due date",
 * which would be a lie about a time that exists.
 */
export function DueTime({ t, locale, item, bucket }: { t: Translator; locale: string; item: MyActivity; bucket?: ActivityBucket }) {
  if (withheld(item, 'dueAt')) {
    return (
      <span data-field="dueAt" data-locked="true" className="inline-flex items-center gap-0.75 font-semibold text-text-2">
        <LockedValue t={t} />
      </span>
    );
  }
  const due = item.dueAt ?? null;
  if (due === null) {
    return (
      <span data-field="dueAt" className="inline-flex items-center gap-0.75 font-semibold text-text-muted">
        <Icon name="schedule" size={14} />
        {t.t('activities.task.undated')}
      </span>
    );
  }
  const overdue = bucket === 'overdue';
  return (
    <span data-field="dueAt" className={`inline-flex items-center gap-0.75 font-semibold ${overdue ? 'text-danger-text' : 'text-text-2'}`}>
      <Icon name="schedule" size={14} />
      <span className="sr-only">{t.t('record.activity.due')}</span>
      <span>
        {overdue ? `${t.t('activities.due.overdue')} · ` : null}
        <time dateTime={due}>{dueText(t, locale, due, bucket)}</time>
      </span>
    </span>
  );
}

function Summary({
  t,
  kind,
  id,
  name,
}: {
  t: Translator;
  kind: 'contact' | 'account';
  id: string;
  name: string;
}) {
  const href = recordHref(kind === 'contact' ? '/contacts' : '/accounts', id);
  const icon = kind === 'contact' ? 'person' : 'domain';
  const label = t.t(kind === 'contact' ? 'activities.related.contact' : 'activities.related.account');
  const inner = (
    <>
      <Icon name={icon} size={14} className="mt-px" />
      <span className="min-w-0 break-words">
        {`${label} · `}
        <span data-record-text="">{name}</span>
      </span>
    </>
  );
  return (
    <span data-related={kind} className="inline-flex min-w-0 items-center font-semibold text-primary-text">
      {href === null ? (
        <span className="inline-flex min-w-0 items-start gap-0.75">{inner}</span>
      ) : (
        <Link
          href={href}
          prefetch={false}
          className="inline-flex min-w-0 items-start gap-0.75 rounded-sm is-hover:underline is-focus-visible:ring-focus"
        >
          {inner}
        </Link>
      )}
    </span>
  );
}

function LockedSummary({ t, kind }: { t: Translator; kind: 'contact' | 'account' }) {
  return (
    <span data-related={kind} data-locked="true" className="inline-flex items-center gap-0.75 font-semibold text-text-2">
      <span>{t.t(kind === 'contact' ? 'activities.related.contact' : 'activities.related.account')}</span>
      <LockedValue t={t} />
    </span>
  );
}

/** The contact and the account an activity is about, each by name; nothing for neither. */
export function Related({ t, item }: { t: Translator; item: MyActivity }) {
  const parts = [];
  if (withheld(item, 'contact')) parts.push(<LockedSummary key="contact" t={t} kind="contact" />);
  else if (item.contact) parts.push(<Summary key="contact" t={t} kind="contact" id={item.contact.id} name={nameOrWithheld(t, item.contact.displayName)} />);
  if (withheld(item, 'account')) parts.push(<LockedSummary key="account" t={t} kind="account" />);
  else if (item.account) parts.push(<Summary key="account" t={t} kind="account" id={item.account.id} name={item.account.name} />);
  return parts.length === 0 ? null : <>{parts}</>;
}
