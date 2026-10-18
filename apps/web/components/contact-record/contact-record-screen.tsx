'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, LINK, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { ActivityType, type ContactRecord } from '../../lib/contact-record-api';
import { recordHref, writeErrorId, zoneName } from '../record/record-core';
import { RecordLoading, RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { RecordTimeline, Value, type TimelineVocabulary } from '../record/record-timeline';
import { StartScript } from '../script-run/start-script';
import { LazyCustomValuesPanel } from '../custom/lazy-panel';
import { useCustomFields, type CustomContext } from '../custom/use-custom-fields';
import {
  DETAILS,
  STATUS_CODES,
  describeValue,
  fieldLabel,
  formatPhone,
  initials,
  isLocked,
  type DetailKey,
} from './record-model';
import { useContactRecord, type ContactRecordState } from './use-contact-record';

// Loaded when opened: neither the edit sheet nor the activity form is on the page's first paint.
const ContactSheet = dynamic(() => import('./contact-sheet').then((module) => module.ContactSheet), { ssr: false });
const ActivityForm = dynamic(() => import('../record/activity-form').then((module) => module.ActivityForm), { ssr: false });

/**
 * `P05/01` — the contact record, the 360° view (T-0062), with `P05/02` (the
 * same screen at tablet and phone widths), `P05/05` (field security and
 * offline) and `P05/06` (loading). Behind the record-view flag, which only the
 * server page reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES NOT DRAW, AND WHY (D-L69)
 *
 *   - P05/06's "access denied" frame. It prints the record id, the owning
 *     programme and "Request access", which tells a caller the record exists
 *     in a programme they cannot reach: an existence oracle across the BPO
 *     isolation boundary (CLAUDE.md 6.4). An out-of-scope record is the same
 *     generic not-found as one that never existed, byte for byte.
 *   - The WhatsApp composer and its 24-hour window, the AI summary and next
 *     best action, recording playback, NIN last-4, addresses and Follow. Each
 *     waits for the module that owns it to publish a contract.
 *   - P05/05's queued offline edits (D-P21). Offline, every write is off and
 *     the record stays in memory only, never on the device (D-L64).
 *   - The contact's name in the document title. Titles land in browser
 *     history, and a BPO desk is shared (D-L63).
 *
 * D-L84: the screen cannot know whether the caller may write, so the write
 * controls are shown to everyone and the API's 403 is the gate, drawn as an
 * alert in the reader's language. Nothing is optimistic: a refused or stale
 * edit leaves the served value on screen.
 * ---------------------------------------------------------------------------
 */

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

/** A contact's timeline names Contact fields, and draws the values the API served (D-L72). */
const CONTACT_TIMELINE: TimelineVocabulary = {
  fieldLabel,
  describe: (field, value) => describeValue(field, value as Parameters<typeof describeValue>[1]),
};

type Notice = { readonly kind: 'error'; readonly id: MessageId } | { readonly kind: 'saved' } | null;

export function ContactRecordScreen({
  id,
  locale,
  messages,
  locales,
  live,
  scripts = false,
  customFields = false,
}: {
  id: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links. */
  live: readonly string[];
  /** The scripts flag is on in this process (read by the server page): draw the start control (T-0116). */
  scripts?: boolean;
  /** Custom values are on in this process (read by the server page, T-0091): draw, edit and log them. */
  customFields?: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useContactRecord(id);
  const custom = useCustomFields('contact', customFields);
  const offline = !state.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div data-screen="P05/01" data-record-state={state.phase} className="flex min-w-0 flex-col gap-4">
        <Link href="/contacts" className={`inline-flex min-h-touch items-center gap-1 self-start ${LINK}`}>
          <Icon name="arrow_back" size="sm" className="rtl:-scale-x-100" />
          {t.t('records.title')}
        </Link>

        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}

        {state.phase === 'loading' ? <RecordLoading t={t} slow={state.slow} label="record.loading" /> : null}

        {state.phase === 'not-found' ? <RecordNotFound t={t} /> : null}

        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="record.unavailable" error={state.error} offline={offline} onRetry={state.reload} />
        ) : null}

        {state.phase === 'ready' && state.record !== null ? (
          <Ready
            t={t}
            locale={locale}
            state={state}
            record={state.record}
            offline={offline}
            linkAccount={live.includes('accounts')}
            scripts={scripts}
            custom={custom}
            customFields={customFields}
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
  linkAccount,
  scripts,
  custom,
  customFields,
}: {
  t: Translator;
  locale: string;
  state: ContactRecordState;
  record: ContactRecord;
  offline: boolean;
  /** The account record (T-0063) is served in this process, so the summary may link to it. */
  linkAccount: boolean;
  /** The P10 start control (T-0116), behind the scripts flag on the server. Reads nothing until opened. */
  scripts: boolean;
  /** The contact's custom-field definitions and what this session has been told is read-only (T-0091). */
  custom: CustomContext;
  /** The custom-fields flag, for the activity form's own definitions. */
  customFields: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState<ActivityType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [tab, setTab] = useState<'activity' | 'details'>('activity');
  const logButtons = useRef<Partial<Record<ActivityType, HTMLButtonElement | null>>>({});
  const headings = { details: useId(), related: useId(), activity: useId() };

  const report = (ok: boolean, code?: Parameters<typeof writeErrorId>[0]) =>
    setNotice(ok ? { kind: 'saved' } : { kind: 'error', id: writeErrorId(code ?? 'network') });

  const changeStatus = async (status: string) => {
    if (status === '' || status === record.status) return;
    setPendingStatus(status);
    setBusy('status');
    setNotice(null);
    const result = await state.save({ status });
    setPendingStatus(null);
    setBusy(null);
    report(result.ok, result.ok ? undefined : result.error.code);
  };

  const assignToMe = async () => {
    if (state.me === null) return;
    setBusy('owner');
    setNotice(null);
    const result = await state.save({ ownerUserId: state.me.id });
    setBusy(null);
    report(result.ok, result.ok ? undefined : result.error.code);
  };

  const complete = async (activityId: string) => {
    setBusy(`task:${activityId}`);
    setNotice(null);
    const result = await state.complete(activityId);
    setBusy(null);
    report(result.ok, result.ok ? undefined : result.error.code);
  };

  const closeLog = (saved: boolean) => {
    const type = logging;
    setLogging(null);
    if (saved) setNotice({ kind: 'saved' });
    if (type !== null) logButtons.current[type]?.focus();
  };

  const tabClass = (which: 'activity' | 'details') => (tab === which ? 'flex' : 'hidden md:flex');

  return (
    <div data-testid="record" className="flex min-w-0 flex-col gap-4">
      <section className={`${PANEL} gap-4`}>
        <div className="flex min-w-0 items-start gap-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-h5 font-bold text-primary-text md:h-16 md:w-16"
          >
            {initials(record.displayName)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 data-record-text="" className="break-words text-h3 md:text-h2">
              {record.displayName}
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
            data-action="edit-contact"
            data-requires-connection=""
            aria-haspopup="dialog"
            disabled={offline}
            onClick={() => setEditing(true)}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="edit" size="sm" />
            {t.t('record.edit')}
          </button>
          {scripts ? <StartScript t={t} contactId={record.id} offline={offline} /> : null}
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

      {custom.fields.length > 0 ? <LazyCustomValuesPanel t={t} locale={locale} fields={custom.fields} custom={record.custom} withheldFields={record.withheldFields} /> : null}

      <div role="group" aria-label={t.t('record.sections')} className="grid grid-cols-2 gap-1 rounded-md bg-surface-sunken p-1 md:hidden">
        {(['activity', 'details'] as const).map((which) => (
          <button
            key={which}
            type="button"
            aria-pressed={tab === which}
            onClick={() => setTab(which)}
            className={`min-h-touch rounded-md text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${tab === which ? 'bg-surface text-text shadow-1' : 'text-text-2'}`}
          >
            {t.t(which === 'activity' ? 'record.section.activity' : 'record.section.details')}
          </button>
        ))}
      </div>

      <div className="grid min-w-0 items-start gap-4 md:grid-cols-3">
        <div className={`${tabClass('details')} min-w-0 flex-col gap-4`}>
          <section data-testid="record-details" aria-labelledby={headings.details} className={PANEL}>
            <h2 id={headings.details} className="text-h5">
              {t.t('record.section.details')}
            </h2>
            <dl className="flex flex-col divide-y divide-border">
              {DETAILS.map((spec) => (
                <Detail
                  key={spec.key}
                  t={t}
                  field={spec.key}
                  label={spec.label}
                  record={record}
                  locked={isLocked(record, spec.key)}
                >
                  <DetailValue
                    t={t}
                    field={spec.key}
                    record={record}
                    me={state.me}
                    offline={offline}
                    busy={busy}
                    pendingStatus={pendingStatus}
                    onStatus={(status) => void changeStatus(status)}
                    onAssign={() => void assignToMe()}
                  />
                </Detail>
              ))}
            </dl>
          </section>

          <section aria-labelledby={headings.related} className={PANEL}>
            <h2 id={headings.related} className="text-h5">
              {t.t('record.section.related')}
            </h2>
            <AccountSummary t={t} record={record} link={linkAccount} />
          </section>
        </div>

        <section
          aria-labelledby={headings.activity}
          className={`${tabClass('activity')} ${PANEL} gap-4 md:col-span-2`}
        >
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
            <ActivityForm key={logging} t={t} type={logging} offline={offline} onSave={state.log} onClose={closeLog} customFields={customFields} />
          )}
          <RecordTimeline
            t={t}
            locale={locale}
            timeline={state.timeline}
            vocabulary={CONTACT_TIMELINE}
            loadingLabel="record.loading"
            versions={state.versions}
            completing={busy?.startsWith('task:') === true ? busy.slice('task:'.length) : null}
            offline={offline}
            onRetry={state.retryTimeline}
            onLoadOlder={state.loadOlder}
            onComplete={(activityId) => void complete(activityId)}
          />
        </section>
      </div>

      {editing ? (
        <ContactSheet t={t} record={record} offline={offline} custom={custom} onSave={state.save} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

function Detail({
  t,
  field,
  label,
  record,
  locked,
  children,
}: {
  t: Translator;
  field: DetailKey;
  label: MessageId;
  record: ContactRecord;
  locked: boolean;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div
      data-field={field}
      data-locked={locked ? 'true' : undefined}
      className="flex min-w-0 flex-col gap-1 py-2"
    >
      <dt id={labelId} className="text-caption text-text-muted">
        {t.t(label)}
      </dt>
      <dd className="min-w-0 text-body-md">
        {locked ? (
          <span className="inline-flex items-center gap-1 text-text-muted">
            <Icon name="lock" size="sm" />
            {t.t('records.locked')}
          </span>
        ) : field in record || field === 'owner' ? (
          children
        ) : (
          <span className="text-text-muted">{t.t('records.cell.empty')}</span>
        )}
      </dd>
    </div>
  );
}

function DetailValue({
  t,
  field,
  record,
  me,
  offline,
  busy,
  pendingStatus,
  onStatus,
  onAssign,
}: {
  t: Translator;
  field: DetailKey;
  record: ContactRecord;
  me: ContactRecordState['me'];
  offline: boolean;
  busy: string | null;
  pendingStatus: string | null;
  onStatus: (status: string) => void;
  onAssign: () => void;
}) {
  const statusId = useId();
  const notSet = <span className="text-text-muted">{t.t('records.cell.empty')}</span>;

  switch (field) {
    case 'phones': {
      const phones = record.phones ?? [];
      if (phones.length === 0) return notSet;
      return (
        <span className="flex flex-col gap-1">
          {phones.map((phone) => (
            <span key={phone.e164} className="flex flex-wrap items-center gap-2">
              <span data-record-text="" className="whitespace-nowrap tabular-nums">
                {formatPhone(phone.e164)}
              </span>
              {typeof record.phoneNetwork === 'string' && phone === phones[0] ? (
                <span data-record-text="" className="rounded-sm bg-surface-sunken px-1 text-caption font-semibold text-text-2">
                  {record.phoneNetwork}
                </span>
              ) : null}
            </span>
          ))}
        </span>
      );
    }
    case 'emails':
    case 'tags': {
      const list = (field === 'emails' ? record.emails : record.tags) ?? [];
      if (list.length === 0) return notSet;
      return (
        <span className="flex flex-wrap gap-1">
          {list.map((entry) => (
            <span
              key={entry}
              data-record-text=""
              className={field === 'tags' ? 'rounded-full bg-surface-sunken px-2 text-body-sm font-semibold text-text-2' : 'break-all'}
            >
              {entry}
            </span>
          ))}
        </span>
      );
    }
    case 'status': {
      const value = pendingStatus ?? record.status ?? '';
      // A native select: on a mid-range Android phone it opens the system
      // picker, which is faster and more legible than anything drawn here.
      return (
        <select
          id={statusId}
          aria-label={t.t('records.col.status')}
          data-field-input="status"
          data-requires-connection=""
          value={value}
          disabled={offline || busy !== null}
          aria-busy={busy === 'status'}
          onChange={(event) => onStatus(event.target.value)}
          className={`${FIELD} w-full max-w-xs font-semibold disabled:opacity-60`}
        >
          {value === '' ? (
            <option value="" disabled>
              {t.t('records.cell.empty')}
            </option>
          ) : null}
          {STATUS_CODES.map((code) => (
            <option key={code} value={code}>
              {t.t(`records.status.${code}` as MessageId)}
            </option>
          ))}
        </select>
      );
    }
    case 'owner': {
      const owner = record.owner;
      const mine = me !== null && owner?.id === me.id;
      return (
        <span className="flex flex-wrap items-center gap-2">
          {owner === null || owner === undefined ? (
            <span className="text-text-muted">{t.t('records.owner.unassigned')}</span>
          ) : owner.displayName === null ? (
            // A former owner (T-0103, D-P23): the server sends no name. Never the id.
            <span data-owner="former" className="text-text-muted">
              {t.t('records.owner.former')}
            </span>
          ) : (
            <span data-record-text="">{owner.displayName}</span>
          )}
          {me === null || mine ? null : (
            <button
              type="button"
              data-action="assign-to-me"
              data-requires-connection=""
              disabled={offline || busy !== null}
              onClick={onAssign}
              className={`${QUIET_BUTTON} disabled:opacity-60`}
            >
              <Icon name="person" size="sm" />
              {busy === 'owner' ? t.t('record.saving') : t.t('record.assignToMe')}
            </button>
          )}
        </span>
      );
    }
    default: {
      const value = record[field];
      const view = describeValue(field, value === undefined ? null : value);
      return (
        <span className={field === 'dnd' && value === true ? 'font-semibold text-danger-text' : undefined}>
          <Value t={t} view={view} />
        </span>
      );
    }
  }
}

function AccountSummary({ t, record, link }: { t: Translator; record: ContactRecord; link: boolean }) {
  // A link only where the account record (T-0063) is served: it needs the
  // accounts flag as well as this page's own, and a link to a 404 is worse
  // than none. A served id that is not a uuid is never made into a path.
  const locked = isLocked(record, 'account');
  const href = link && !locked ? recordHref('/accounts', record.account?.id) : null;
  return (
    <div data-testid="account-summary" data-locked={locked ? 'true' : undefined} className="flex min-w-0 items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
        <Icon name="domain" size="sm" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-caption text-text-muted">{t.t('records.col.accountId')}</span>
        {locked ? (
          <span className="inline-flex items-center gap-1 text-text-muted">
            <Icon name="lock" size="sm" />
            {t.t('records.locked')}
          </span>
        ) : record.account === null || record.account === undefined ? (
          <span className="text-text-muted">{t.t('records.account.none')}</span>
        ) : href !== null ? (
          <Link href={href} className={`break-words font-bold ${LINK}`}>
            <span data-record-text="">{record.account.name}</span>
          </Link>
        ) : (
          <b data-record-text="" className="break-words">
            {record.account.name}
          </b>
        )}
      </span>
    </div>
  );
}
