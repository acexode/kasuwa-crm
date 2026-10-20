'use client';

import dynamic from 'next/dynamic';
import { guarded } from '../custom/lazy-boundary';
import Link from 'next/link';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON } from '../auth/button-classes';
import { LazyCustomValuesPanel } from '../custom/lazy-panel';
import { useCustomFields, useReadOnlyKeys, type CustomContext, type ReadOnlyStore } from '../custom/use-custom-fields';
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
import { LockedValue } from '../records/list-parts';
import { nameOrWithheld } from '../records/name';
import { formatPhone } from '../records/list-model';
import type { Account } from '../../lib/accounts-api';
import { ActivityType } from '../../lib/contact-record-api';
import type { RecordPlaceholders } from '../../lib/record-flags';
import type { Contact } from '../../lib/records-api';
import { initials } from '../contact-record/record-model';
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

// Loaded when opened: neither the edit sheet nor the activity form is on the page's first paint.
const AccountSheet = guarded(dynamic(() => import('../accounts/account-sheet').then((module) => module.AccountSheet), { ssr: false }));
const ActivityForm = guarded(dynamic(() => import('../record/activity-form').then((module) => module.ActivityForm), { ssr: false }));
// The D-L194 placeholders: loaded only where their flag is on, so with every flag off none of them ships.
const Composer = dynamic(() => import('../record/record-placeholders').then((module) => module.Composer), { ssr: false });
const AiSummaryCard = dynamic(() => import('../record/record-placeholders').then((module) => module.AiSummaryCard), { ssr: false });
const NextBestActionCard = dynamic(() => import('../record/record-placeholders').then((module) => module.NextBestActionCard), { ssr: false });
const RelatedSections = dynamic(() => import('../record/record-placeholders').then((module) => module.RelatedSections), { ssr: false });
const AddressesCard = dynamic(() => import('../record/record-placeholders').then((module) => module.AddressesCard), { ssr: false });

/**
 * `P05/04` — the account record (T-0063), rebuilt to the export in T-0134
 * (D-L193): 300 / fluid / 340 at 1440 with the contacts grid above the
 * timeline, Insights | Details at 1024, Activity | Contacts | Details |
 * Insights tabs at 360, with the P05/05 (field security, offline) and P05/06
 * (loading) states. Behind the record-view and accounts flags, which only the
 * server page reads; no client module names a flag.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DRAWS FROM DATA, AS A PLACEHOLDER, OR NOT AT ALL
 *
 *   - From the account: the header (tier badge; industry, place, parent and
 *     owner), Details in groups with a pencil per edited field, the contacts
 *     grid as tiles, the Hierarchy card (the ancestors read up
 *     `parentAccountId`, D-L98, and the account itself), the timeline.
 *   - D-L194 placeholders, each behind its flag: Call, Follow, the composer,
 *     the AI summary, the next best action, related lists and their actions,
 *     Addresses (the State and LGA held).
 *   - Not drawn (D-L69, D-L98, D-P13, CLAUDE.md 6.4): the account's CHILDREN
 *     (nothing serves them, T-0118), roll-ups and every money figure, Health,
 *     the Map, buying roles and "last contact", billing, RC number, TIN, an
 *     inferred DND on account phones, counts of related records, P05/06's
 *     "access denied" frame, P05/05's queued edits (D-P21), and the account's
 *     name in the document title.
 *
 * D-L84: no read tells the screen whether the caller may write, so the write
 * controls show to everyone and the API's 403 is the gate, drawn as an alert
 * in the reader's language. Nothing is optimistic.
 * ---------------------------------------------------------------------------
 */

/** An account's timeline names Account fields, by name only (D-L78): there is no value to draw. */
const ACCOUNT_TIMELINE: TimelineVocabulary = { fieldLabel: accountFieldLabel };

/** P05 at 360: "← Contact" with search and a kebab, as the export's app bar draws it. */
function appBar(title: string, back: string, actions: ReactNode): CrmAppBar {
  return { title, back, actions };
}

type Notice = { readonly kind: 'error'; readonly id: MessageId } | { readonly kind: 'saved' } | null;

const GROUPS: readonly { readonly title: MessageId; readonly keys: readonly AccountDetailKey[] }[] = [
  { title: 'account.group.company', keys: ['industry', 'tier', 'phones', 'tags'] },
  { title: 'account.group.location', keys: ['state', 'lga'] },
  { title: 'record.group.system', keys: ['owner'] },
];

/** What the account sheet edits: a pencil on each. The owner has none here. */
const EDITED: ReadonlySet<AccountDetailKey> = new Set(['industry', 'tier', 'phones', 'tags', 'state', 'lga']);

export function AccountRecordScreen({
  id,
  locale,
  messages,
  locales,
  live,
  customFields = false,
  placeholders,
}: {
  id: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links and the contact rows. */
  live: readonly string[];
  /** Custom values are on in this process (read by the server page, T-0091): draw, edit and log them. */
  customFields?: boolean;
  /** The D-L194 placeholder flags, read by the server page (T-0134). */
  placeholders: RecordPlaceholders;
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useAccountRecord(id);
  const custom = useCustomFields('account', customFields);
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
    <CrmShell t={t} locale={locale} locales={locales} current="accounts" live={live} appBar={appBar(t.t('record.appBar.account'), '/accounts', <RecordAppBarActions t={t} search={live.includes('search')} entries={kebab} />)}>
      <div data-screen="P05/04" data-record-state={state.phase} className="flex min-w-0 flex-col gap-3 lg:gap-4">
        {record === null ? null : (
          <RecordBreadcrumb t={t} href="/accounts" list={t.t('accounts.title')} current={<span data-record-text="">{record.name}</span>} />
        )}

        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}

        {state.phase === 'loading' ? <RecordLoading t={t} slow={state.slow} label="account.loading" /> : null}

        {state.phase === 'not-found' ? <RecordNotFound t={t} back={{ href: '/accounts', label: 'account.notFound.back' }} /> : null}

        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="account.unavailable" error={state.error} offline={offline} onRetry={state.reload} />
        ) : null}

        {record === null ? null : (
          <Ready
            t={t}
            locale={locale}
            state={state}
            record={record}
            offline={offline}
            linkContacts={live.includes('contacts')}
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
  linkContacts,
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
  state: AccountRecordState;
  record: Account;
  offline: boolean;
  /** The contact record is served in this process, so a contact tile may link to it. */
  linkContacts: boolean;
  /** The account's custom-field definitions and what this session has been told is read-only (T-0091). */
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
  const [completing, setCompleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pane, setPane] = useState<Pane>('insights');
  const [channel, setChannel] = useState<ComposerChannel>('whatsapp');
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const headings = { header: useId(), details: useId(), contacts: useId(), related: useId() };

  const complete = async (activityId: string) => {
    setCompleting(activityId);
    setNotice(null);
    // Resolves only after a 409's re-read, so the control comes back with the fresh version.
    const result = await state.complete(activityId);
    setCompleting(null);
    setNotice(result.ok ? { kind: 'saved' } : { kind: 'error', id: writeErrorId(result.error.code) });
  };

  const closeLog = (saved: boolean) => {
    setLogging(null);
    if (saved) setNotice({ kind: 'saved' });
    // The menu item that opened the form is gone; focus goes back to the menu's button.
    document.querySelector<HTMLButtonElement>('[data-screen="P05/04"] [data-action="log-activity"]:not([data-activity-type])')?.focus();
  };

  const saveNote = async (body: string) => {
    setNotice(null);
    const result = await state.log({ type: 'note', body });
    setNotice(result.ok ? { kind: 'saved' } : { kind: 'error', id: writeErrorId(result.error.code) });
    return result.ok;
  };

  const openChannel = (next: ComposerChannel) => {
    setChannel(next);
    setTab('activity');
    requestAnimationFrame(() => composerInput.current?.focus());
  };

  // Only where a placeholder that needs it is on: with every flag off the string is not in the bundle.
  const soon = flags.call || flags.related || flags.follow ? t.t('record.action.soon') : '';
  const actions: RecordAction[] = [
    ...(flags.call ? [{ key: 'call', icon: 'call' as const, label: t.t('record.action.call'), primary: true, disabled: true, title: soon }] : []),
    // The export's account bar has WhatsApp and Email, and no SMS.
    ...(flags.composer
      ? (['whatsapp', 'email'] as const).map((value) => ({
          key: value,
          icon: value === 'whatsapp' ? ('chat' as const) : ('mail' as const),
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
              const spec = ACCOUNT_DETAILS.find((entry) => entry.key === key);
              if (spec === undefined) return null;
              const locked = isLocked(record, key);
              const label = t.t(spec.label);
              return (
                <DetailRow
                  key={key}
                  field={key}
                  label={label}
                  locked={locked}
                  mono={key === 'phones'}
                  edit={
                    EDITED.has(key)
                      ? { label: t.t('record.action.edit', { field: label }), action: 'edit-account', disabled: offline, onClick: () => setEditing(true) }
                      : undefined
                  }
                >
                  {locked ? (
                    <span className="text-text-muted">
                      <LockedValue t={t} />
                    </span>
                  ) : (
                    <DetailValue t={t} field={key} record={record} />
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
      <HierarchyCard t={t} record={record} hierarchy={state.hierarchy} />
      {flags.addresses ? (
        <AddressesCard
          t={t}
          title="account.group.location"
          state={!isLocked(record, 'state') && typeof record.state === 'string' && record.state !== '' ? record.state : null}
          lga={!isLocked(record, 'lga') && typeof record.lga === 'string' && record.lga !== '' ? record.lga : null}
          locked={false}
        />
      ) : null}
    </>
  );

  const hasInsights = flags.aiSummary || flags.aiNba || flags.related;
  const insights = hasInsights ? (
    <>
      {flags.aiSummary ? <AiSummaryCard t={t} /> : null}
      {flags.aiNba ? <NextBestActionCard t={t} /> : null}
      {flags.related ? (
        <section aria-labelledby={headings.related} className={`${CARD} overflow-hidden`}>
          <h2 id={headings.related} className={`${CARD_TITLE} px-3.5 py-3`}>
            {t.t('record.section.related')}
          </h2>
          <RelatedSections t={t} />
        </section>
      ) : null}
    </>
  ) : null;

  const contacts = (
    <section data-testid="account-contacts" aria-labelledby={headings.contacts} className={`${CARD} gap-3 p-4`}>
      <h2 id={headings.contacts} className={CARD_TITLE}>
        {t.t('account.section.contacts')}
      </h2>
      <ContactsGrid t={t} contacts={state.contacts} offline={offline} link={linkContacts} onRetry={state.retryContacts} onMore={state.moreContacts} />
    </section>
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
          vocabulary: ACCOUNT_TIMELINE,
          loadingLabel: 'account.loading',
          versions: state.versions,
          completing,
          offline,
          onRetry: state.retryTimeline,
          onLoadOlder: state.loadOlder,
          onComplete: (activityId) => void complete(activityId),
        }}
      />
    </>
  );

  const parent = state.hierarchy?.ancestors[state.hierarchy.ancestors.length - 1] ?? null;

  return (
    <div data-testid="record" className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <section aria-labelledby={headings.header} className={`${CARD} gap-3.5 p-3.5 md:px-5 md:py-4.5`}>
        <div className="flex min-w-0 items-start gap-3 md:gap-4">
          <span
            aria-hidden="true"
            className="flex size-[52px] shrink-0 items-center justify-center rounded-14 bg-accent-soft text-h5 font-extrabold text-accent-text md:size-[72px] md:text-h3 md:font-extrabold"
          >
            {initials(record.name) === '' ? <Icon name="domain" size={24} /> : initials(record.name)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 id={headings.header} data-record-text="" className="break-words text-h4 font-bold md:text-title-sm md:font-bold">
                {record.name}
              </h1>
              {!isLocked(record, 'tier') && typeof record.tier === 'string' ? (
                <NameBadge>{t.t(`accounts.tier.${record.tier}` as MessageId)}</NameBadge>
              ) : null}
            </div>
            <Subtitle t={t} record={record} parent={parent} />
          </div>
          {flags.follow ? (
            <Button icon="notifications" disabled title={soon} className={`max-md:w-control-base ${ACTION_SIZE}`}>
              <span className="max-md:sr-only">{t.t('record.action.follow')}</span>
            </Button>
          ) : null}
        </div>
        <Chips t={t} record={record} />
        <ActionBar t={t} actions={actions} />
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
          { value: 'contacts', label: t.t('account.section.contacts') },
          { value: 'details', label: t.t('record.section.details') },
          ...(hasInsights ? [{ value: 'insights', label: t.t('record.section.insights') }] : []),
        ]}
        tab={tab}
        onTab={setTab}
        pane={hasInsights ? pane : 'details'}
        onPane={setPane}
        left={details}
        centre={[
          { tab: 'contacts', node: contacts },
          { tab: 'activity', node: activity },
        ]}
        right={insights}
      />

      {editing ? (
        <AccountSheet
          t={t}
          mode={{ kind: 'edit', row: record }}
          programmes={{ list: null, phase: 'loaded' }}
          online={!offline}
          custom={custom}
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

/** "Industry · LGA, State · Part of Parent · Owner Name", each part only where served and readable. */
function Subtitle({ t, record, parent }: { t: Translator; record: Account; parent: Account | null }) {
  const parts: ReactNode[] = [];
  if (!isLocked(record, 'industry') && typeof record.industry === 'string' && record.industry !== '') {
    parts.push(<span data-record-text="">{record.industry}</span>);
  }
  const place = [record.lga, record.state].filter(
    (value, index): value is string => !isLocked(record, index === 0 ? 'lga' : 'state') && typeof value === 'string' && value !== '',
  );
  if (place.length > 0) parts.push(<span data-record-text="">{place.join(', ')}</span>);
  if (parent !== null) {
    const href = recordHref('/accounts', parent.id);
    parts.push(
      <>
        {t.t('account.partOf')}{' '}
        {href === null ? (
          <span data-record-text="" className="font-semibold text-text">
            {parent.name}
          </span>
        ) : (
          <Link href={href} className="rounded-sm font-semibold text-primary-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-focus">
            <span data-record-text="">{parent.name}</span>
          </Link>
        )}
      </>,
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

function Chips({ t, record }: { t: Translator; record: Account }) {
  const year = new Date(record.createdAt).getFullYear();
  if (Number.isNaN(year)) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <HeaderChip tone="neutral" icon="event">
        {t.t('record.chip.since', { year: String(year) })}
      </HeaderChip>
    </div>
  );
}

/** Indentation per level of the tree, as the export steps it (8, 30, 52… px). Literal strings, so Tailwind sees them. */
const INDENT = ['ps-2', 'ps-[30px]', 'ps-[52px]', 'ps-[74px]', 'ps-[96px]'];
const ELBOW = ['', 'start-4', 'start-[38px]', 'start-[60px]', 'start-[82px]'];

/**
 * The Hierarchy card: the ancestors read up `parentAccountId`, root first,
 * each a link to its own record, and the account last, highlighted and not a
 * link (D-L98). Nothing serves an account's children (T-0118), so the tree
 * stops at this account. Where the walk stopped is said at the root, in
 * words and never an id: a lock where a parent link is withheld (nothing
 * above it was read), "not shown" past four ancestors, a loop, or a level
 * that did not load. A top-level account draws no card.
 */
function HierarchyCard({ t, record, hierarchy }: { t: Translator; record: Account; hierarchy: Hierarchy | null }) {
  const locked = isLocked(record, 'parentAccountId');
  if (!locked && typeof record.parentAccountId !== 'string') return null;
  const end = locked ? 'locked' : hierarchy?.end;
  const marker: MessageId | null =
    end === 'failed' ? 'account.hierarchy.partial' : end === 'limit' ? 'account.hierarchy.limit' : end === 'cycle' ? 'account.hierarchy.cycle' : null;
  const ancestors = hierarchy?.ancestors ?? [];
  const lead = end === 'locked' || marker !== null || (hierarchy === null && !locked) ? 1 : 0;
  const row = (level: number) =>
    `relative flex min-h-touch items-center gap-1.5 rounded-md pe-2 ${INDENT[Math.min(level, INDENT.length - 1)] ?? 'ps-2'}`;
  const elbow = (level: number) =>
    level === 0 ? null : (
      <span
        aria-hidden="true"
        className={`absolute bottom-1/2 top-0 w-2.5 rounded-es-6 border-b-2 border-s-2 border-border-strong ${ELBOW[Math.min(level, ELBOW.length - 1)] ?? ''}`}
      />
    );

  return (
    <section aria-label={t.t('account.hierarchy')} className={`${CARD} gap-1 p-3.5`}>
      <h2 className={`${CARD_TITLE} mb-1 flex items-center gap-1.5`}>
        <Icon name="account_tree" size={18} className="text-primary-text" />
        {t.t('account.hierarchy.title')}
      </h2>
      <ol data-testid="account-hierarchy" data-locked={locked ? 'true' : undefined} className="flex flex-col">
        {end === 'locked' ? (
          <li data-hierarchy-end="locked" className={`${row(0)} text-meta text-text-muted`}>
            <span>{t.t('account.field.parentAccountId')}</span>
            <LockedValue t={t} />
          </li>
        ) : null}
        {hierarchy === null && !locked ? (
          <li aria-hidden="true" className={row(0)}>
            <span className="h-4 w-32 rounded-sm bg-surface-sunken" />
          </li>
        ) : null}
        {marker === null ? null : (
          <li data-hierarchy-end={end} className={`${row(0)} text-meta text-text-muted`}>
            {t.t(marker)}
          </li>
        )}
        {ancestors.map((ancestor, index) => {
          const href = recordHref('/accounts', ancestor.id);
          const level = index + lead;
          return (
            <li key={ancestor.id} data-hierarchy-entry={ancestor.id} className={row(level)}>
              {elbow(level)}
              <Icon name="domain" size={18} className="text-text-2" />
              <span className="flex min-w-0 flex-1 flex-col">
                {href === null ? (
                  <b data-record-text="" className="break-words text-meta font-semibold">
                    {ancestor.name}
                  </b>
                ) : (
                  <Link href={href} className="break-words rounded-sm text-meta font-semibold text-text underline-offset-2 is-hover:underline focus-visible:outline-none focus-visible:ring-focus">
                    <span data-record-text="">{ancestor.name}</span>
                  </Link>
                )}
                {index === ancestors.length - 1 ? <span className="text-micro font-normal text-text-muted">{t.t('account.hierarchy.parent')}</span> : null}
              </span>
            </li>
          );
        })}
        <li data-hierarchy-entry={record.id} aria-current="page" className={`${row(ancestors.length + lead)} bg-primary-soft`}>
          {elbow(ancestors.length + lead)}
          <Icon name="apartment" size={18} className="text-primary-text" />
          <span className="flex min-w-0 flex-1 flex-col">
            <b data-record-text="" className="break-words text-meta font-extrabold text-primary-text">
              {record.name}
            </b>
            <span className="text-micro font-normal text-text-muted">{t.t('account.hierarchy.this')}</span>
          </span>
        </li>
      </ol>
    </section>
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
            <span key={phone.e164} data-record-text="" dir="ltr" className="whitespace-nowrap tabular-nums">
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
            <span key={tag} data-record-text="" className="rounded-full bg-surface-sunken px-2 text-caption font-semibold text-text-2">
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
 * security per tile. Withheld, empty and failed are three different sentences.
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
      <div aria-busy="true" className="grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
        <span role="status" className="sr-only">
          {t.t('account.loading')}
        </span>
        {Array.from({ length: 2 }, (_, index) => (
          <span key={index} aria-hidden="true" className="h-[108px] rounded-10 bg-surface-sunken" />
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
      <ul className="grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
        {contacts.rows.map((row) => (
          <ContactTile key={row.id} t={t} row={row} link={link} />
        ))}
      </ul>
      {contacts.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${contacts.moreError.code}` as MessageId)}
        </p>
      )}
      {contacts.cursor === null ? null : (
        <Button
          data-testid="account-contacts-more"
          data-requires-connection=""
          disabled={offline || contacts.loadingMore}
          onClick={onMore}
          className="self-start"
        >
          {contacts.loadingMore ? t.t('records.loadingMore') : t.t('records.loadMore')}
        </Button>
      )}
    </div>
  );
}

/** A consent mini-chip on a tile: ✓ or ✗ in a glyph, so it never relies on colour alone. */
function ConsentMini({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-micro font-semibold ${
        on ? 'bg-success-soft text-success-text' : 'bg-surface-sunken text-text-muted'
      }`}
    >
      <Icon name={on ? 'check' : 'close'} size={14} />
      {label}
    </span>
  );
}

function ContactTile({ t, row, link }: { t: Translator; row: Contact; link: boolean }) {
  const phonesLocked = row.withheldFields.includes('phones');
  const href = link ? recordHref('/contacts', row.id) : null;
  const phone = (row.phones ?? [])[0];
  const name = nameOrWithheld(t, row.displayName);
  const status = !row.withheldFields.includes('status') && typeof row.status === 'string' ? row.status : null;
  return (
    <li data-contact-row={row.id} className="flex min-w-0 flex-col gap-2 rounded-10 border border-border bg-surface p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-meta font-bold text-primary-text">
          {row.displayName === undefined ? <Icon name="person" size={18} /> : initials(row.displayName)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span data-field="displayName" className="min-w-0 break-words text-body-sm font-bold">
            {href !== null ? (
              <Link href={href} className="rounded-sm text-text underline-offset-2 is-hover:underline focus-visible:outline-none focus-visible:ring-focus">
                <span data-record-text="">{name}</span>
              </Link>
            ) : (
              <span data-record-text="">{name}</span>
            )}
          </span>
          {status === null ? null : <span className="text-caption font-normal text-text-2">{t.t(`records.status.${status}` as MessageId)}</span>}
        </span>
      </div>
      <span data-field="phones" data-locked={phonesLocked ? 'true' : undefined} className="font-mono text-caption font-normal text-text-2">
        {phonesLocked ? (
          <span className="font-sans">
            <LockedValue t={t} />
          </span>
        ) : phone === undefined ? (
          <span className="font-sans text-text-muted">{t.t('records.cell.empty')}</span>
        ) : (
          <span data-record-text="" dir="ltr" className="whitespace-nowrap tabular-nums">
            {formatPhone(phone.e164)}
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {row.withheldFields.includes('whatsappOptIn') || typeof row.whatsappOptIn !== 'boolean' ? null : (
          <ConsentMini on={row.whatsappOptIn} label={t.t('records.channel.whatsapp')} />
        )}
        {row.withheldFields.includes('consentState') || row.consentState === undefined ? null : (
          <ConsentMini on={row.consentState === 'opted_in'} label={t.t('account.tile.consent')} />
        )}
      </span>
    </li>
  );
}
