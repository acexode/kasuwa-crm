'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import { nameOrWithheld } from '../records/name';
import { Icon } from '../icon';
import { LINK } from '../auth/button-classes';
import { LockedValue } from '../records/list-parts';
import { recordHref } from '../record/record-core';
import { withheld, type MyActivity } from '../../lib/activities-api';
import { formatWhen } from './activity-format';

/**
 * The pieces a task row and a calendar event draw alike: the subject, the
 * due time and the contact or account it is about. A withheld field is a lock
 * ("Restricted"), never a blank and never a guess; record text is drawn as
 * text, never parsed; and a summary links only from a well-formed uuid.
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

/**
 * A task's due time in the browser's zone, inside a `<time>`. Undated says
 * so; a due time the caller may not read is a lock — never "no due date",
 * which would be a lie about a time that exists.
 */
export function DueTime({ t, locale, item }: { t: Translator; locale: string; item: MyActivity }) {
  if (withheld(item, 'dueAt')) {
    return (
      <span data-field="dueAt" data-locked="true" className="inline-flex items-center gap-1 text-text-2">
        <LockedValue t={t} />
      </span>
    );
  }
  const due = item.dueAt ?? null;
  if (due === null) {
    return (
      <span data-field="dueAt" className="inline-flex items-center gap-1 text-text-muted">
        <Icon name="schedule" size="sm" />
        {t.t('activities.task.undated')}
      </span>
    );
  }
  return (
    <span data-field="dueAt" className="inline-flex items-center gap-1">
      <Icon name="schedule" size="sm" />
      <span className="sr-only">{t.t('record.activity.due')}</span>
      <time dateTime={due}>{formatWhen(locale, due)}</time>
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
  return (
    <span data-related={kind} className="inline-flex min-w-0 items-center gap-1">
      <Icon name={icon} size="sm" />
      <span className="sr-only">{t.t(kind === 'contact' ? 'activities.related.contact' : 'activities.related.account')}</span>
      {href === null ? (
        <span data-record-text="" className="truncate">
          {name}
        </span>
      ) : (
        <Link href={href} prefetch={false} className={`truncate ${LINK}`}>
          <span data-record-text="">{name}</span>
        </Link>
      )}
    </span>
  );
}

function LockedSummary({ t, kind }: { t: Translator; kind: 'contact' | 'account' }) {
  return (
    <span data-related={kind} data-locked="true" className="inline-flex items-center gap-1 text-text-2">
      <span className="sr-only">{t.t(kind === 'contact' ? 'activities.related.contact' : 'activities.related.account')}</span>
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
  return parts.length === 0 ? null : <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{parts}</span>;
}
