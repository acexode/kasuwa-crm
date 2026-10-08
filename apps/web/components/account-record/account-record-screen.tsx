'use client';

import Link from 'next/link';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { LINK, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { AccountSheet } from '../accounts/account-sheet';
import { ActivityForm } from '../record/activity-form';
import { writeErrorId, zoneName } from '../record/record-core';
import { RecordLoading, RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { RecordTimeline, Value, type TimelineVocabulary } from '../record/record-timeline';
import { LockedValue } from '../records/list-parts';
import { formatPhone } from '../records/list-model';
import type { Account } from '../../lib/accounts-api';
import { ActivityType } from '../../lib/contact-record-api';
import type { Contact } from '../../lib/records-api';
import {
  ACCOUNT_DETAILS,
  accountFieldLabel,
  describeAccountValue,
  isLocked,
  type AccountDetailKey,
  type ContactsState,
  type Hierarchy,
} from './account-record-model';
import { useAccountRecord, type AccountRecordState } from './use-account-record';

/**
 * `P05/04` — the account record (T-0063), with the P05/05 (field security,
 * offline) and P05/06 (loading) states. Behind the record-view and accounts
 * flags, which only the server page reads; no client module names a flag.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES NOT DRAW, AND WHY (D-L69, D-L98)
 *
 *   - P05/06's "access denied" frame: an existence oracle across the BPO
 *     isolation boundary (CLAUDE.md 6.4). Out of scope is the generic
 *     not-found, the same as an id that names nothing.
 *   - The account's CHILDREN. Nothing serves them (T-0118); the hierarchy is
 *     the breadcrumb UP, from `parentAccountId`.
 *   - Pipeline rollups and every money figure, Health, the Map, related deals,
 *     tickets, quotes, invoices and campaigns, buying roles, billing, RC
 *     number, TIN, an inferred DND on account phones, related counts (D-P13)
 *     and access requests. Each waits for the module or field behind it.
 *   - P05/05's queued offline edits (D-P21): offline, every write is off and
 *     the record stays in memory only (D-L64).
 *   - The account's name in the document title: titles land in browser
 *     history on shared desks, and a sole trader's account is a person's name.
 *
 * D-L84: no read tells the screen whether the caller may write, so the write
 * controls show to everyone and the API's 403 is the gate, drawn as an alert
 * in the reader's language. Nothing is optimistic.
 * ---------------------------------------------------------------------------
 */

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

/** An account's timeline names Account fields, by name only (D-L78): there is no value to draw. */
const ACCOUNT_TIMELINE: TimelineVocabulary = { fieldLabel: accountFieldLabel };

type Notice = { readonly kind: 'error'; readonly id: MessageId } | { readonly kind: 'saved' } | null;

export function AccountRecordScreen({
  id,
  locale,
  messages,
  locales,
  live,
}: {
  id: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links and the contact rows. */
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useAccountRecord(id);
  const offline = !state.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="accounts" live={live}>
      <div data-screen="P05/04" data-record-state={state.phase} className="flex min-w-0 flex-col gap-4">
        <Link href="/accounts" className={`inline-flex min-h-touch items-center gap-1 self-start ${LINK}`}>
          <Icon name="arrow_back" size="sm" className="rtl:-scale-x-100" />
          {t.t('accounts.title')}
        </Link>

        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}

        {state.phase === 'loading' ? <RecordLoading t={t} slow={state.slow} label="account.loading" /> : null}

        {state.phase === 'not-found' ? <RecordNotFound t={t} /> : null}

        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="account.unavailable" error={state.error} offline={offline} onRetry={state.reload} />
        ) : null}

        {state.phase === 'ready' && state.record !== null ? (
          <Ready
            t={t}
            locale={locale}
            state={state}
            record={state.record}
            offline={offline}
            linkContacts={live.includes('contacts')}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

function Ready({
  t,
  locale,
  state,
  record,
  offline,
  linkContacts,
}: {
  t: Translator;
  locale: string;
  state: AccountRecordState;
  record: Account;
  offline: boolean;
  /** The contact record is served in this process, so a contact row may link to it. */
  linkContacts: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState<ActivityType | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const logButtons = useRef<Partial<Record<ActivityType, HTMLButtonElement | null>>>({});
  const headings = { details: useId(), contacts: useId(), activity: useId() };

  const complete = async (activityId: string) => {
    setCompleting(activityId);
    setNotice(null);
    // Resolves only after a 409's re-read, so the control comes back with the fresh version.
    const result = await state.complete(activityId);
    setCompleting(null);
    setNotice(result.ok ? { kind: 'saved' } : { kind: 'error', id: writeErrorId(result.error.code) });
  };

  const closeLog = (saved: boolean) => {
    const type = logging;
    setLogging(null);
    if (saved) setNotice({ kind: 'saved' });
    if (type !== null) logButtons.current[type]?.focus();
  };

  return (
    <div data-testid="record" className="flex min-w-0 flex-col gap-4">
      <section className={`${PANEL} gap-4`}>
        <HierarchyTrail t={t} record={record} hierarchy={state.hierarchy} />
        <div className="flex min-w-0 items-start gap-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text md:h-16 md:w-16"
          >
            <Icon name="domain" size="lg" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 data-record-text="" className="break-words text-h3 md:text-h2">
              {record.name}
            </h1>
            {state.programmeName === null ? null : (
              <p data-record-text="" className="text-body-sm text-text-2">
                {state.programmeName}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <button
            type="button"
            data-action="edit-account"
            data-requires-connection=""
            aria-haspopup="dialog"
            disabled={offline}
            onClick={() => setEditing(true)}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="edit" size="sm" />
            {t.t('record.edit')}
          </button>
        </div>
      </section>

      {notice === null ? null : notice.kind === 'error' ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(notice.id)}
        </p>
      ) : (
        <p role="status" className="flex items-center gap-2 text-body-sm font-semibold text-success-text">
          <Icon name="check_circle" size="sm" />
          {t.t('record.saved')}
        </p>
      )}

      <div className="grid min-w-0 items-start gap-4 md:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4">
          <section data-testid="record-details" aria-labelledby={headings.details} className={PANEL}>
            <h2 id={headings.details} className="text-h5">
              {t.t('record.section.details')}
            </h2>
            <dl className="flex flex-col divide-y divide-border">
              {ACCOUNT_DETAILS.map((spec) => (
                <Detail key={spec.key} t={t} field={spec.key} label={spec.label} locked={isLocked(record, spec.key)}>
                  <DetailValue t={t} field={spec.key} record={record} />
                </Detail>
              ))}
            </dl>
          </section>

          <section data-testid="account-contacts" aria-labelledby={headings.contacts} className={PANEL}>
            <h2 id={headings.contacts} className="text-h5">
              {t.t('account.section.contacts')}
            </h2>
            <ContactsGrid
              t={t}
              contacts={state.contacts}
              offline={offline}
              link={linkContacts}
              onRetry={state.retryContacts}
              onMore={state.moreContacts}
            />
          </section>
        </div>

        <section aria-labelledby={headings.activity} className={`${PANEL} gap-4 md:col-span-2`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={headings.activity} className="text-h5">
              {t.t('record.section.activity')}
            </h2>
            <span className="text-caption text-text-muted">{t.t('record.timeline.zone', { zone: zoneName(locale) })}</span>
          </div>
          <div role="group" aria-label={t.t('record.log.group')} className="flex flex-wrap gap-2">
            {ActivityType.options.map((type) => (
              <button
                key={type}
                ref={(element) => {
                  logButtons.current[type] = element;
                }}
                type="button"
                data-action="log-activity"
                data-activity-type={type}
                data-requires-connection=""
                aria-expanded={logging === type}
                disabled={offline}
                onClick={() => setLogging(type)}
                className={`${SECONDARY_BUTTON} disabled:opacity-60`}
              >
                <Icon name={type === 'note' ? 'edit_note' : type === 'task' ? 'add_task' : 'call'} size="sm" />
                {t.t(`record.activity.type.${type}` as MessageId)}
              </button>
            ))}
          </div>
          {logging === null ? null : (
            <ActivityForm key={logging} t={t} type={logging} offline={offline} onSave={state.log} onClose={closeLog} />
          )}
          <RecordTimeline
            t={t}
            locale={locale}
            timeline={state.timeline}
            vocabulary={ACCOUNT_TIMELINE}
            loadingLabel="account.loading"
            versions={state.versions}
            completing={completing}
            offline={offline}
            onRetry={state.retryTimeline}
            onLoadOlder={state.loadOlder}
            onComplete={(activityId) => void complete(activityId)}
          />
        </section>
      </div>

      {editing ? (
        <AccountSheet
          t={t}
          mode={{ kind: 'edit', row: record }}
          programmes={{ list: null, phase: 'loaded' }}
          online={!offline}
          onClose={() => setEditing(false)}
          onSaved={(row) => {
            state.saved(row);
            setEditing(false);
            setNotice({ kind: 'saved' });
          }}
          onRefused={(error) => {
            // Somebody saved first: read the account again so the next save
            // carries its version. The sheet keeps what was typed.
            if (error.code === 'stale_write') state.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The hierarchy, root first, as the breadcrumb D-L98 rules: ancestors by
 * name, each a link to its own record, and the record last, not a link. A
 * top-level account draws none. A withheld parent link is a lock, and nothing
 * above it was read.
 */
function HierarchyTrail({ t, record, hierarchy }: { t: Translator; record: Account; hierarchy: Hierarchy | null }) {
  const locked = isLocked(record, 'parentAccountId');
  if (!locked && typeof record.parentAccountId !== 'string') return null;
  const separator = <Icon name="chevron_right" size="sm" className="text-text-muted rtl:-scale-x-100" />;

  return (
    <nav aria-label={t.t('account.hierarchy')} data-testid="account-hierarchy" data-locked={locked ? 'true' : undefined}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-body-sm text-text-2">
        {locked ? (
          <li className="inline-flex min-h-touch items-center gap-1 text-text-muted">
            <span>{t.t('account.field.parentAccountId')}</span>
            <LockedValue t={t} />
            {separator}
          </li>
        ) : null}
        {hierarchy === null && !locked ? (
          <li aria-hidden="true" className="inline-flex min-h-touch items-center gap-1">
            <span className="h-4 w-24 rounded-sm bg-surface-sunken" />
            {separator}
          </li>
        ) : null}
        {hierarchy?.end === 'failed' ? (
          <li className="inline-flex min-h-touch items-center gap-1 text-text-muted">
            <span>{t.t('account.hierarchy.partial')}</span>
            {separator}
          </li>
        ) : null}
        {(hierarchy?.ancestors ?? []).map((ancestor) => (
          <li key={ancestor.id} data-hierarchy-entry={ancestor.id} className="inline-flex min-w-0 items-center gap-1">
            <Link href={`/accounts/${ancestor.id}`} className={`inline-flex min-h-touch min-w-0 items-center break-words ${LINK}`}>
              <span data-record-text="">{ancestor.name}</span>
            </Link>
            {separator}
          </li>
        ))}
        <li data-hierarchy-entry={record.id} aria-current="page" className="inline-flex min-h-touch min-w-0 items-center font-semibold text-text">
          <span data-record-text="" className="break-words">
            {record.name}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function Detail({
  t,
  field,
  label,
  locked,
  children,
}: {
  t: Translator;
  field: AccountDetailKey;
  label: MessageId;
  locked: boolean;
  children: ReactNode;
}) {
  return (
    <div data-field={field} data-locked={locked ? 'true' : undefined} className="flex min-w-0 flex-col gap-1 py-2">
      <dt className="text-caption text-text-muted">{t.t(label)}</dt>
      <dd className="min-w-0 text-body-md">
        {locked ? (
          <span className="text-text-muted">
            <LockedValue t={t} />
          </span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

function DetailValue({ t, field, record }: { t: Translator; field: AccountDetailKey; record: Account }) {
  const notSet = <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
  switch (field) {
    case 'phones': {
      const phones = record.phones ?? [];
      if (phones.length === 0) return notSet;
      // No DND marker: the contract says a screen must not infer one for an account's numbers.
      return (
        <span className="flex flex-col gap-1">
          {phones.map((phone) => (
            <span key={phone.e164} data-record-text="" className="whitespace-nowrap tabular-nums">
              {formatPhone(phone.e164)}
            </span>
          ))}
        </span>
      );
    }
    case 'tags': {
      const tags = record.tags ?? [];
      if (tags.length === 0) return notSet;
      return (
        <span className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} data-record-text="" className="rounded-full bg-surface-sunken px-2 text-body-sm font-semibold text-text-2">
              {tag}
            </span>
          ))}
        </span>
      );
    }
    case 'owner':
      return record.owner === null || record.owner === undefined ? (
        <span className="text-text-muted">{t.t('records.owner.unassigned')}</span>
      ) : (
        <span data-record-text="">{record.owner.displayName}</span>
      );
    default:
      return <Value t={t} view={describeAccountValue(field, record)} />;
  }
}

/**
 * The account's contacts, as listAccountContacts serves them: in served
 * order, keyset "more" while `nextCursor` says so, no count (D-P13). Field
 * security per row. Withheld, empty and failed are three different sentences.
 */
function ContactsGrid({
  t,
  contacts,
  offline,
  link,
  onRetry,
  onMore,
}: {
  t: Translator;
  contacts: ContactsState;
  offline: boolean;
  link: boolean;
  onRetry: () => void;
  onMore: () => void;
}) {
  if (contacts.phase === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <span role="status" className="sr-only">
          {t.t('account.loading')}
        </span>
        {Array.from({ length: 3 }, (_, index) => (
          <span key={index} aria-hidden="true" className="h-10 rounded-md bg-surface-sunken" />
        ))}
      </div>
    );
  }
  if (contacts.phase === 'withheld') {
    return (
      <p data-testid="account-contacts-withheld" className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-text-2">
        <Icon name="lock" size="sm" />
        {t.t('account.contacts.withheld')}
      </p>
    );
  }
  if (contacts.phase === 'error') {
    return (
      <div
        data-testid="account-contacts-error"
        className="flex flex-col items-start gap-2 rounded-md border border-danger bg-danger-soft p-3 text-body-sm text-danger-text"
      >
        <p className="flex items-center gap-2 font-bold">
          <Icon name="error" size="sm" />
          {t.t('account.contacts.error')}
        </p>
        <button type="button" data-requires-connection="" disabled={offline} onClick={onRetry} className={QUIET_BUTTON}>
          {t.t('records.retry')}
        </button>
      </div>
    );
  }
  if (contacts.rows.length === 0) {
    return (
      <p data-testid="account-contacts-empty" className="flex items-center gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-text-2">
        <Icon name="group" size="sm" />
        {t.t('account.contacts.empty')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {contacts.rows.map((row) => (
          <ContactRow key={row.id} t={t} row={row} link={link} />
        ))}
      </ul>
      {contacts.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${contacts.moreError.code}` as MessageId)}
        </p>
      )}
      {contacts.cursor === null ? null : (
        <button
          type="button"
          data-testid="account-contacts-more"
          data-requires-connection=""
          disabled={offline || contacts.loadingMore}
          onClick={onMore}
          className={`${SECONDARY_BUTTON} self-start disabled:opacity-60`}
        >
          {contacts.loadingMore ? t.t('records.loadingMore') : t.t('records.loadMore')}
        </button>
      )}
    </div>
  );
}

function ContactRow({ t, row, link }: { t: Translator; row: Contact; link: boolean }) {
  const phonesLocked = row.withheldFields.includes('phones');
  const phone = (row.phones ?? [])[0];
  return (
    <li data-contact-row={row.id} className="flex min-w-0 flex-col gap-1 py-2">
      <span data-field="displayName" className="min-w-0 break-words font-semibold">
        {link ? (
          <Link href={`/contacts/${row.id}`} className={`inline-flex min-h-touch items-center ${LINK}`}>
            <span data-record-text="">{row.displayName}</span>
          </Link>
        ) : (
          <span data-record-text="">{row.displayName}</span>
        )}
      </span>
      <span data-field="phones" data-locked={phonesLocked ? 'true' : undefined} className="text-body-sm text-text-2">
        {phonesLocked ? (
          <LockedValue t={t} />
        ) : phone === undefined ? (
          <span className="text-text-muted">{t.t('records.cell.empty')}</span>
        ) : (
          <span data-record-text="" className="whitespace-nowrap tabular-nums">
            {formatPhone(phone.e164)}
          </span>
        )}
      </span>
    </li>
  );
}
