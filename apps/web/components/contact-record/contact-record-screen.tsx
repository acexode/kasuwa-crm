'use client';

import dynamic from 'next/dynamic';
import { guarded } from '../custom/lazy-boundary';
import Link from 'next/link';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { nameOrWithheld } from '../records/name';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { ActivityType, type ContactRecord } from '../../lib/contact-record-api';
import type { RecordPlaceholders } from '../../lib/record-flags';
import { formatDate, recordHref, writeErrorId } from '../record/record-core';
import { RecordLoading, RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { Value, type TimelineVocabulary } from '../record/record-timeline';
import { TimelineCard } from '../record/timeline-card';
import {
  ACTION_SIZE,
  ActionBar,
  CARD,
  CARD_TITLE,
  DetailGroup,
  DetailRow,
  HeaderChip,
  NameBadge,
  RecordBreadcrumb,
  RecordLayout,
  RecordAppBarActions,
  type MenuEntry,
  type Pane,
  type RecordAction,
} from '../record/record-ui';
import type { CrmAppBar } from '../crm/crm-shell';
import type { ComposerChannel } from '../record/record-placeholders';
import { StartScript } from '../script-run/start-script';
import { LazyCustomValuesPanel } from '../custom/lazy-panel';
import { useCustomFields, useReadOnlyKeys, type CustomContext, type ReadOnlyStore } from '../custom/use-custom-fields';
import {
  DETAILS,
  EDIT_KEYS,
  STATUS_CODES,
  describeValue,
  fieldLabel,
  formatPhone,
  initials,
  isLocked,
  languageLabel,
  type DetailKey,
} from './record-model';
import { useContactRecord, type ContactRecordState } from './use-contact-record';

// Loaded when opened: neither the edit sheet nor the activity form is on the page's first paint.
const ContactSheet = guarded(dynamic(() => import('./contact-sheet').then((module) => module.ContactSheet), { ssr: false }));
const ActivityForm = guarded(dynamic(() => import('../record/activity-form').then((module) => module.ActivityForm), { ssr: false }));
// The D-L194 placeholders: loaded only where their flag is on, so with every flag off none of them ships.
const Composer = dynamic(() => import('../record/record-placeholders').then((module) => module.Composer), { ssr: false });
const AiSummaryCard = dynamic(() => import('../record/record-placeholders').then((module) => module.AiSummaryCard), { ssr: false });
const NextBestActionCard = dynamic(() => import('../record/record-placeholders').then((module) => module.NextBestActionCard), { ssr: false });
const RelatedSections = dynamic(() => import('../record/record-placeholders').then((module) => module.RelatedSections), { ssr: false });
const IdentityCard = dynamic(() => import('../record/record-placeholders').then((module) => module.IdentityCard), { ssr: false });
const AddressesCard = dynamic(() => import('../record/record-placeholders').then((module) => module.AddressesCard), { ssr: false });

/**
 * `P05/01` — the contact record, the 360° view (T-0062), rebuilt to the
 * export in T-0134 (D-L193): the 300 / fluid / 340 workspace at 1440, the
 * Insights | Details switch at 1024, Activity | Details | Insights tabs at
 * 360, with `P05/05` (field security and offline) and `P05/06` (loading).
 * Behind the record-view flag, which only the server page reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DRAWS FROM DATA, AS A PLACEHOLDER, OR NOT AT ALL
 *
 *   - From the contact: the header (status as the name badge; company,
 *     account and owner; chips for created, DND, consent, language and
 *     preferred channel), Details in the export's collapsible groups with a
 *     pencil per editable field, the related account, consent, the timeline.
 *   - As D-L194 placeholders, each behind its own flag and in the design's
 *     empty or disabled state: Call, Follow, the composer with the 24-hour
 *     window (closed: nothing is served), the AI summary, the next best
 *     action, related deals/tickets/quotes/invoices/campaigns and their
 *     actions, Identity (not checked) and Addresses (the State and LGA held).
 *   - Not drawn: P05/06's "access denied" frame. It prints the record id, the
 *     owning programme and "Request access", an existence oracle across the
 *     BPO isolation boundary (CLAUDE.md 6.4, D-L195). An out-of-scope record
 *     is the same generic not-found as one that never existed. Nor P05/05's
 *     queued offline edits (D-P21), nor a contact id (only UUIDs exist), nor
 *     the name in the document title (D-L63).
 *
 * D-L84: the screen cannot know whether the caller may write, so the write
 * controls are shown to everyone and the API's 403 is the gate, drawn as an
 * alert in the reader's language. Nothing is optimistic.
 * ---------------------------------------------------------------------------
 */

/** A contact's timeline names Contact fields, and draws the values the API served (D-L72). */
const CONTACT_TIMELINE: TimelineVocabulary = {
  fieldLabel,
  describe: (field, value) => describeValue(field, value as Parameters<typeof describeValue>[1]),
};

/** P05 at 360: "← Contact" with search and a kebab, as the export's app bar draws it. */
function appBar(title: string, back: string, actions: ReactNode): CrmAppBar {
  return { title, back, actions };
}

type Notice = { readonly kind: 'error'; readonly id: MessageId } | { readonly kind: 'saved' } | null;

/** Details in the export's groups. Every DETAILS key is in exactly one. */
const GROUPS: readonly { readonly title: MessageId; readonly keys: readonly DetailKey[] }[] = [
  { title: 'record.group.contact', keys: ['phones', 'emails', 'companyName', 'preferredLanguage', 'preferredChannel'] },
  { title: 'record.group.personal', keys: ['givenNames', 'familyName', 'state', 'lga'] },
  { title: 'record.group.consent', keys: ['whatsappOptIn', 'consentState', 'dnd'] },
  { title: 'record.group.system', keys: ['status', 'owner', 'source', 'tags'] },
];

export function ContactRecordScreen({
  id,
  locale,
  messages,
  locales,
  live,
  scripts = false,
  customFields = false,
  placeholders,
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
  /** The D-L194 placeholder flags, read by the server page (T-0134). */
  placeholders: RecordPlaceholders;
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useContactRecord(id);
  const custom = useCustomFields('contact', customFields);
  const activityKeys = useReadOnlyKeys();
  const offline = !state.online;
  const record = state.phase === 'ready' ? state.record : null;
  // Owned here, not in Ready, so the phone app bar's kebab can open them too.
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState<ActivityType | null>(null);
  const [tab, setTab] = useState('activity');
  const kebab: MenuEntry[] =
    record === null
      ? []
      : [
          { key: 'edit', icon: 'edit', label: t.t('record.edit'), disabled: offline, onSelect: () => setEditing(true) },
          ...ActivityType.options.map((type) => ({
            key: type,
            icon: type === 'note' ? ('sticky_note_2' as const) : type === 'task' ? ('task_alt' as const) : ('call' as const),
            label: t.t(`record.activity.type.${type}` as MessageId),
            disabled: offline,
            onSelect: () => {
              setTab('activity');
              setLogging(type);
            },
          })),
        ];

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live} appBar={appBar(t.t('record.appBar.contact'), '/contacts', <RecordAppBarActions t={t} search={live.includes('search')} entries={kebab} />)}>
      <div data-screen="P05/01" data-record-state={state.phase} className="flex min-w-0 flex-col gap-3 lg:gap-4">
        {record === null ? null : (
          <RecordBreadcrumb
            t={t}
            href="/contacts"
            list={t.t('records.title')}
            current={<span data-record-text={record.displayName === undefined ? undefined : ''}>{nameOrWithheld(t, record.displayName)}</span>}
          />
        )}

        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}

        {state.phase === 'loading' ? <RecordLoading t={t} slow={state.slow} label="record.loading" /> : null}

        {state.phase === 'not-found' ? <RecordNotFound t={t} back={{ href: '/contacts', label: 'record.notFound.back' }} /> : null}

        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="record.unavailable" error={state.error} offline={offline} onRetry={state.reload} />
        ) : null}

        {record === null ? null : (
          <Ready
            t={t}
            locale={locale}
            state={state}
            record={record}
            offline={offline}
            linkAccount={live.includes('accounts')}
            scripts={scripts}
            custom={custom}
            customFields={customFields}
            activityKeys={activityKeys}
            flags={placeholders}
            editing={editing}
            setEditing={setEditing}
            logging={logging}
            setLogging={setLogging}
            tab={tab}
            setTab={setTab}
          />
        )}
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
  activityKeys,
  flags,
  editing,
  setEditing,
  logging,
  setLogging,
  tab,
  setTab,
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
  /** Read-only activity keys, owned here so they outlive the activity form. */
  activityKeys: ReadOnlyStore;
  flags: RecordPlaceholders;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  logging: ActivityType | null;
  setLogging: (type: ActivityType | null) => void;
  tab: string;
  setTab: (tab: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pane, setPane] = useState<Pane>('insights');
  const [channel, setChannel] = useState<ComposerChannel>('whatsapp');
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const headings = { header: useId(), details: useId(), related: useId(), consent: useId() };

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
    setLogging(null);
    if (saved) setNotice({ kind: 'saved' });
    // The menu item that opened the form is gone; focus goes back to the menu's button.
    document.querySelector<HTMLButtonElement>('[data-screen="P05/01"] [data-action="log-activity"]:not([data-activity-type])')?.focus();
  };

  const saveNote = async (body: string) => {
    setNotice(null);
    const result = await state.log({ type: 'note', body });
    report(result.ok, result.ok ? undefined : result.error.code);
    return result.ok;
  };

  const openChannel = (next: ComposerChannel) => {
    setChannel(next);
    setTab('activity');
    requestAnimationFrame(() => composerInput.current?.focus());
  };

  const soon = t.t('record.action.soon');
  const actions: RecordAction[] = [
    ...(flags.call ? [{ key: 'call', icon: 'call' as const, label: t.t('record.action.call'), primary: true, disabled: true, title: soon }] : []),
    ...(flags.composer
      ? (['whatsapp', 'sms', 'email'] as const).map((value) => ({
          key: value,
          icon: value === 'whatsapp' ? ('chat' as const) : value === 'sms' ? ('sms' as const) : ('mail' as const),
          label: t.t(`records.channel.${value}` as MessageId),
          onClick: () => openChannel(value),
        }))
      : []),
    {
      key: 'log',
      icon: 'edit_note',
      label: t.t('record.action.log'),
      disabled: offline,
      attributes: { 'data-action': 'log-activity', 'data-requires-connection': '' },
      menu: ActivityType.options.map((type) => ({
        key: type,
        icon: type === 'note' ? ('sticky_note_2' as const) : type === 'task' ? ('task_alt' as const) : ('call' as const),
        label: t.t(`record.activity.type.${type}` as MessageId),
        disabled: offline,
        onSelect: () => {
          setTab('activity');
          setLogging(type);
        },
        attributes: { 'data-action': 'log-activity', 'data-activity-type': type, 'data-requires-connection': '' },
      })),
    },
    ...(flags.related
      ? [
          { key: 'deal', icon: 'handshake' as const, label: t.t('record.action.newDeal'), disabled: true, title: soon },
          { key: 'ticket', icon: 'confirmation_number' as const, label: t.t('record.action.newTicket'), disabled: true, title: soon },
          { key: 'pay', icon: 'link' as const, label: t.t('record.action.paymentLink'), disabled: true, title: soon },
        ]
      : []),
  ];

  const edit = (key: DetailKey, label: string): Parameters<typeof DetailRow>[0]['edit'] =>
    (EDIT_KEYS as readonly string[]).includes(key)
      ? { label: t.t('record.action.edit', { field: label }), action: 'edit-contact', disabled: offline, onClick: () => setEditing(true) }
      : undefined;

  const details = (
    <>
      <section data-testid="record-details" aria-labelledby={headings.details} className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <h2 id={headings.details} className={`${CARD_TITLE} flex-1`}>
            {t.t('record.section.details')}
          </h2>
        </div>
        {GROUPS.map((group) => (
          <DetailGroup key={group.title} title={t.t(group.title)}>
            {group.keys.map((key) => {
              const spec = DETAILS.find((entry) => entry.key === key);
              if (spec === undefined) return null;
              const locked = isLocked(record, key);
              const label = t.t(spec.label);
              return (
                <DetailRow key={key} field={key} label={label} locked={locked} mono={key === 'phones'} edit={edit(key, label)}>
                  {locked ? (
                    <span className="inline-flex items-center gap-1 text-text-muted">
                      <Icon name="lock" size="sm" />
                      {t.t('records.locked')}
                    </span>
                  ) : key in record || key === 'owner' ? (
                    <DetailValue
                      t={t}
                      field={key}
                      record={record}
                      me={state.me}
                      offline={offline}
                      busy={busy}
                      pendingStatus={pendingStatus}
                      onStatus={(status) => void changeStatus(status)}
                      onAssign={() => void assignToMe()}
                    />
                  ) : (
                    <span className="text-text-muted">{t.t('records.cell.empty')}</span>
                  )}
                </DetailRow>
              );
            })}
            {group.title === 'record.group.system' ? (
              <>
                <DetailRow label={t.t('record.field.created')}>
                  <time dateTime={record.createdAt}>{formatDate(locale, record.createdAt)}</time>
                </DetailRow>
                {state.programmeName === null ? null : (
                  <DetailRow label={t.t('record.field.programme')}>
                    <span data-record-text="">{state.programmeName}</span>
                  </DetailRow>
                )}
              </>
            ) : null}
          </DetailGroup>
        ))}
      </section>
      {custom.fields.length > 0 ? <LazyCustomValuesPanel t={t} locale={locale} fields={custom.fields} custom={record.custom} withheldFields={record.withheldFields} /> : null}
      {flags.identity ? <IdentityCard t={t} /> : null}
      {flags.addresses ? (
        <AddressesCard
          t={t}
          state={!isLocked(record, 'state') && typeof record.state === 'string' && record.state !== '' ? record.state : null}
          lga={!isLocked(record, 'lga') && typeof record.lga === 'string' && record.lga !== '' ? record.lga : null}
          locked={false}
        />
      ) : null}
    </>
  );

  const insights = (
    <>
      {flags.aiSummary ? <AiSummaryCard t={t} /> : null}
      {flags.aiNba ? <NextBestActionCard t={t} /> : null}
      <section aria-labelledby={headings.related} className={`${CARD} overflow-hidden`}>
        <h2 id={headings.related} className={`${CARD_TITLE} px-3.5 py-3`}>
          {t.t('record.section.related')}
        </h2>
        <div className="border-t border-border px-3.5 py-3">
          <AccountSummary t={t} record={record} link={linkAccount} />
        </div>
        {flags.related ? <RelatedSections t={t} /> : null}
      </section>
      <ConsentHistory t={t} record={record} heading={headings.consent} />
    </>
  );

  const activity = (
    <>
      {flags.composer ? (
        <Composer t={t} channel={channel} onChannel={setChannel} offline={offline} onSaveNote={saveNote} inputRef={composerInput} />
      ) : null}
      <TimelineCard
        t={t}
        locale={locale}
        channels={flags.composer}
        modules={flags.related}
        form={
          logging === null ? null : (
            <ActivityForm key={logging} t={t} type={logging} offline={offline} onSave={state.log} onClose={closeLog} customFields={customFields} readOnlyStore={activityKeys} />
          )
        }
        timeline={{
          t,
          locale,
          timeline: state.timeline,
          vocabulary: CONTACT_TIMELINE,
          loadingLabel: 'record.loading',
          versions: state.versions,
          completing: busy?.startsWith('task:') === true ? busy.slice('task:'.length) : null,
          offline,
          onRetry: state.retryTimeline,
          onLoadOlder: state.loadOlder,
          onComplete: (activityId) => void complete(activityId),
        }}
      />
    </>
  );

  return (
    <div data-testid="record" className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <section aria-labelledby={headings.header} className={`${CARD} gap-3.5 p-3.5 md:px-5 md:py-4.5`}>
        <div className="flex min-w-0 items-start gap-3 md:gap-4">
          <span
            aria-hidden="true"
            className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-h5 font-bold text-primary-text md:size-[72px] md:text-h3"
          >
            {record.displayName === undefined ? <Icon name="lock" size="sm" /> : initials(record.displayName)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                id={headings.header}
                data-record-text={record.displayName === undefined ? undefined : ''}
                data-name-withheld={record.displayName === undefined ? '' : undefined}
                className="break-words text-h4 font-bold md:text-title-sm md:font-bold"
              >
                {nameOrWithheld(t, record.displayName)}
              </h1>
              {!isLocked(record, 'status') && typeof record.status === 'string' ? (
                <NameBadge>{t.t(`records.status.${record.status}` as MessageId)}</NameBadge>
              ) : null}
            </div>
            <Subtitle t={t} record={record} linkAccount={linkAccount} />
          </div>
          {flags.follow ? (
            <Button icon="notifications" disabled title={soon} className={`max-md:w-control-base ${ACTION_SIZE}`}>
              <span className="max-md:sr-only">{t.t('record.action.follow')}</span>
            </Button>
          ) : null}
        </div>
        <Chips t={t} record={record} />
        <ActionBar t={t} actions={actions} extra={scripts ? <StartScript t={t} contactId={record.id} offline={offline} /> : null} />
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

      <RecordLayout
        t={t}
        tabs={[
          { value: 'activity', label: t.t('record.section.activity') },
          { value: 'details', label: t.t('record.section.details') },
          { value: 'insights', label: t.t('record.section.insights') },
        ]}
        tab={tab}
        onTab={setTab}
        pane={pane}
        onPane={setPane}
        left={details}
        centre={[{ tab: 'activity', node: activity }]}
        right={insights}
      />

      {editing ? (
        <ContactSheet t={t} record={record} offline={offline} custom={custom} onSave={state.save} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

/** "Company · Account · Owner Name", each part only where it is served and readable. */
function Subtitle({ t, record, linkAccount }: { t: Translator; record: ContactRecord; linkAccount: boolean }) {
  const parts: ReactNode[] = [];
  if (!isLocked(record, 'companyName') && typeof record.companyName === 'string' && record.companyName !== '') {
    parts.push(<span data-record-text="">{record.companyName}</span>);
  }
  if (!isLocked(record, 'account') && record.account !== null && record.account !== undefined) {
    const href = linkAccount ? recordHref('/accounts', record.account.id) : null;
    parts.push(
      href === null ? (
        <span data-record-text="" className="font-semibold text-text">
          {record.account.name}
        </span>
      ) : (
        <Link href={href} className="rounded-sm font-semibold text-primary-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-focus">
          <span data-record-text="">{record.account.name}</span>
        </Link>
      ),
    );
  }
  if (!isLocked(record, 'owner') && typeof record.owner?.displayName === 'string') {
    parts.push(
      <>
        {t.t('record.owner')}{' '}
        <b data-record-text="" className="text-text">
          {record.owner.displayName}
        </b>
      </>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p className="text-body-sm text-text-2">
      {parts.map((part, index) => (
        <span key={index}>
          {index === 0 ? null : <span aria-hidden="true">{' · '}</span>}
          {part}
        </span>
      ))}
    </p>
  );
}

/** The header's chips: only what the contact holds and the caller may read. */
function Chips({ t, record }: { t: Translator; record: ContactRecord }) {
  const chips: ReactNode[] = [];
  const year = new Date(record.createdAt).getFullYear();
  if (!Number.isNaN(year)) {
    chips.push(
      <HeaderChip key="since" tone="neutral" icon="event">
        {t.t('record.chip.since', { year: String(year) })}
      </HeaderChip>,
    );
  }
  if (!isLocked(record, 'dnd') && record.dnd === true) {
    chips.push(
      <HeaderChip key="dnd" tone="danger" icon="block">
        {t.t('record.chip.dnd')}
      </HeaderChip>,
    );
  }
  if (!isLocked(record, 'consentState')) {
    if (record.consentState === 'opted_in') {
      chips.push(
        <HeaderChip key="consent" tone="success" icon="check">
          {t.t('record.chip.consent.opted_in')}
        </HeaderChip>,
      );
    } else if (record.consentState === 'withdrawn') {
      chips.push(
        <HeaderChip key="consent" tone="danger" icon="close">
          {t.t('record.chip.consent.withdrawn')}
        </HeaderChip>,
      );
    } else if (record.consentState === 'pending') {
      chips.push(
        <HeaderChip key="consent" tone="warning" icon="schedule">
          {t.t('record.chip.consent.pending')}
        </HeaderChip>,
      );
    }
  }
  if (!isLocked(record, 'preferredLanguage') && typeof record.preferredLanguage === 'string' && record.preferredLanguage !== '') {
    const label = languageLabel(record.preferredLanguage);
    chips.push(
      <HeaderChip key="language" tone="neutral" icon="translate">
        {label === null ? <span data-record-text="">{record.preferredLanguage}</span> : t.t(label)}
      </HeaderChip>,
    );
  }
  if (!isLocked(record, 'preferredChannel') && typeof record.preferredChannel === 'string') {
    chips.push(
      <HeaderChip key="channel" tone="success" icon="chat">
        {t.t('record.chip.prefers', { channel: t.t(`records.channel.${record.preferredChannel}` as MessageId) })}
      </HeaderChip>,
    );
  }
  return chips.length === 0 ? null : <div className="flex flex-wrap gap-1.5">{chips}</div>;
}

/** Consent, per channel, as the contact holds it now. Each change is on the timeline. */
function ConsentHistory({ t, record, heading }: { t: Translator; record: ContactRecord; heading: string }) {
  const rows: { key: string; ok: boolean | null; title: string; detail: string }[] = [];
  if (!isLocked(record, 'whatsappOptIn') && typeof record.whatsappOptIn === 'boolean') {
    rows.push({
      key: 'wa',
      ok: record.whatsappOptIn,
      title: t.t(record.whatsappOptIn ? 'record.consent.whatsapp.on' : 'record.consent.whatsapp.off'),
      detail: t.t(record.whatsappOptIn ? 'record.consent.whatsapp.onDetail' : 'record.consent.whatsapp.offDetail'),
    });
  }
  if (!isLocked(record, 'dnd') && typeof record.dnd === 'boolean') {
    rows.push({
      key: 'dnd',
      ok: !record.dnd,
      title: t.t(record.dnd ? 'record.consent.dnd.on' : 'record.consent.dnd.off'),
      detail: t.t(record.dnd ? 'records.filter.dnd.on' : 'records.filter.dnd.off'),
    });
  }
  if (!isLocked(record, 'consentState') && typeof record.consentState === 'string') {
    rows.push({
      key: 'marketing',
      ok: record.consentState === 'opted_in' ? true : record.consentState === 'withdrawn' ? false : null,
      title: t.t('record.consent.marketing', { state: t.t(`records.consent.${record.consentState}` as MessageId) }),
      detail: t.t('record.consent.marketingDetail'),
    });
  }
  return (
    <section aria-labelledby={heading} className={`${CARD} gap-1 p-3.5`}>
      <h2 id={heading} className={`${CARD_TITLE} pb-1`}>
        {t.t('record.consent.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-meta text-text-muted">{t.t('record.consent.none')}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.key} className="flex gap-2.5 border-t border-border py-2.5 first:border-t-0">
              <span
                aria-hidden="true"
                className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                  row.ok === true ? 'bg-success-soft text-success-text' : row.ok === false ? 'bg-danger-soft text-danger-text' : 'bg-surface-sunken text-text-2'
                }`}
              >
                <Icon name={row.ok === true ? 'check' : row.ok === false ? 'close' : 'schedule'} size={15} />
              </span>
              <span className="flex min-w-0 flex-col">
                <b className="text-meta font-bold">{row.title}</b>
                <span className="text-caption font-normal text-text-2">{row.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="pt-1 text-caption font-normal text-text-2">{t.t('record.consent.footer')}</p>
    </section>
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
              <span data-record-text="" dir="ltr" className="whitespace-nowrap tabular-nums">
                {formatPhone(phone.e164)}
              </span>
              {typeof record.phoneNetwork === 'string' && phone === phones[0] ? (
                <span data-record-text="" className="rounded-sm bg-surface-sunken px-1 font-sans text-caption font-semibold text-text-2">
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
              className={field === 'tags' ? 'rounded-full bg-surface-sunken px-2 text-caption font-semibold text-text-2' : 'break-all'}
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
          className="h-control-sm w-full max-w-xs rounded-md border border-border-strong bg-surface px-2.5 text-body-sm font-semibold text-text focus-visible:outline-none focus-visible:field-focus disabled:bg-disabled-bg disabled:text-disabled-text"
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
        <span className="flex flex-wrap items-center gap-x-2">
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
              className="inline-flex min-h-touch items-center gap-1 rounded-md px-1 text-meta font-semibold text-primary-text is-hover:underline focus-visible:outline-none focus-visible:ring-focus disabled:text-disabled-text"
            >
              <Icon name="person" size={16} />
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
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-10 bg-accent-soft text-accent-text">
        <Icon name="domain" size={20} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-caption font-semibold text-text-muted">{t.t('records.col.accountId')}</span>
        {locked ? (
          <span className="inline-flex items-center gap-1 text-meta text-text-muted">
            <Icon name="lock" size="sm" />
            {t.t('records.locked')}
          </span>
        ) : record.account === null || record.account === undefined ? (
          <span className="text-meta text-text-muted">{t.t('records.account.none')}</span>
        ) : href !== null ? (
          <Link href={href} className="break-words rounded-sm text-body-sm font-bold text-primary-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-focus">
            <span data-record-text="">{record.account.name}</span>
          </Link>
        ) : (
          <b data-record-text="" className="break-words text-body-sm">
            {record.account.name}
          </b>
        )}
      </span>
    </div>
  );
}
