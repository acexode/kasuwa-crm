'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  createBundleTranslator,
  localeLabel,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmFab, CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { HEADER_PRIMARY, TOOL_BUTTON } from '../records/list-classes';
import { RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { SCRIPT_LOCALES, type ScriptLocale } from '../../lib/script-graph';
import {
  createScript,
  listMyProgrammes,
  listScripts,
  type Programme,
  type ScriptSummary,
} from '../../lib/scripting-api';
import { useOnline } from './use-online';
import { formatDayFirst } from '../../lib/date-locale';

/**
 * `P10/05` — the script builder's list (T-0115): the scripts the caller may
 * author, in served order, each with its draft and published state. Keyset
 * paged on `nextCursor` (a short page is not the last), with no count
 * (D-P13), and the cursor never in the address bar.
 *
 * D-L84 / R2: nothing tells the screen who holds `script.write`, so "New
 * script" shows to every caller and the API's 403 is the gate, drawn as a
 * translated alert that keeps what was typed. A non-writer simply sees no
 * scripts, exactly as an admin with none does. There is no nav entry to this
 * screen for anyone until a capability read exists (R3).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ListState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly ScriptSummary[];
  readonly cursor: string | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
}

export function ScriptListScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const [list, setList] = useState<ListState>({
    phase: 'loading',
    rows: [],
    cursor: null,
    loadingMore: false,
    moreFailed: false,
  });
  const [programmes, setProgrammes] = useState<readonly Programme[]>([]);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setList({ phase: 'loading', rows: [], cursor: null, loadingMore: false, moreFailed: false });
    void Promise.all([
      listScripts(null, controller.signal),
      listMyProgrammes(controller.signal),
    ]).then(([page, mine]) => {
      if (controller.signal.aborted) return;
      if (mine.ok) setProgrammes(mine.value.data);
      if (!page.ok) {
        setList((current) => ({ ...current, phase: 'error' }));
        return;
      }
      setSyncedAt(new Date());
      setList({
        phase: 'ready',
        rows: page.value.data,
        cursor: page.value.nextCursor,
        loadingMore: false,
        moreFailed: false,
      });
    });
    return () => controller.abort();
  }, [attempt]);

  const more = async () => {
    if (list.cursor === null || list.loadingMore) return;
    setList((current) => ({ ...current, loadingMore: true, moreFailed: false }));
    const page = await listScripts(list.cursor);
    setList((current) => {
      if (!page.ok) return { ...current, loadingMore: false, moreFailed: true };
      const seen = new Set(current.rows.map((row) => row.id));
      return {
        ...current,
        rows: [...current.rows, ...page.value.data.filter((row) => !seen.has(row.id))],
        cursor: page.value.nextCursor,
        loadingMore: false,
      };
    });
    if (page.ok) setSyncedAt(new Date());
  };

  const programmeName = (id: string) =>
    programmes.find((programme) => programme.id === id)?.name ?? null;
  const headingId = useId();

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="studio"
      live={live}
      appBar={{ title: t.t('scripting.builder.title') }}
      fab={
        <CrmFab
          label={t.t('scripting.builder.new')}
          onClick={() => {
            if (online) setCreating(true);
          }}
        />
      }
    >
      <div
        data-screen="P10/05"
        data-builder-view="list"
        data-builder-state={list.phase === 'loading' ? 'loading' : 'ready'}
        className="flex w-full min-w-0 flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <nav
              aria-label={t.t('scripting.builder.breadcrumb')}
              className="hidden text-caption font-normal text-text-muted md:block"
            >
              {t.t('records.nav.studio')}
              <span aria-hidden="true"> / </span>
              {t.t('scripting.builder.breadcrumb.scripts')}
            </nav>
            <h1 id={headingId} className="text-h4 font-bold md:text-title">
              {t.t('scripting.builder.title')}
            </h1>
            <p className="text-meta text-text-2">{t.t('scripting.builder.intro')}</p>
          </div>
          <button
            ref={opener}
            type="button"
            data-action="new-script"
            data-requires-connection=""
            aria-haspopup="dialog"
            disabled={!online}
            onClick={() => setCreating(true)}
            className={`${HEADER_PRIMARY} hidden disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text md:inline-flex`}
          >
            <Icon name="add" size={20} />
            {t.t('scripting.builder.new')}
          </button>
        </div>

        {online ? null : <RecordOfflineBanner t={t} locale={locale} syncedAt={syncedAt} />}

        {list.phase === 'loading' ? (
          <div
            aria-busy="true"
            className="flex flex-col overflow-hidden rounded-10 border border-border bg-surface"
          >
            <span role="status" className="sr-only">
              {t.t('scripting.builder.loading')}
            </span>
            <div
              aria-hidden="true"
              className="hidden h-control-md border-b border-border bg-surface-sunken md:block"
            />
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                data-testid="builder-skeleton"
                aria-hidden="true"
                className="flex h-control-xl items-center gap-3 border-b border-border px-3 last:border-b-0"
              >
                <span className="h-4 w-1/3 rounded-sm bg-surface-sunken" />
                <span className="h-4 w-1/6 rounded-sm bg-surface-sunken" />
              </div>
            ))}
          </div>
        ) : null}

        {list.phase === 'error' ? (
          <RecordUnavailable
            t={t}
            heading="scripting.builder.unavailable"
            error={{ code: 'network' }}
            offline={!online}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : null}

        {list.phase === 'ready' ? (
          <section
            data-testid="script-list"
            aria-labelledby={headingId}
            className="flex min-w-0 flex-col overflow-hidden rounded-10 border border-border bg-surface max-md:-mx-4 max-md:rounded-none max-md:border-x-0"
          >
            {list.rows.length === 0 ? (
              <div
                data-testid="script-list-empty"
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
              >
                <span className="flex size-16 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                  <Icon name="account_tree" size={32} />
                </span>
                <p className="text-sheet-title">{t.t('scripting.builder.empty.title')}</p>
                <p className="max-w-[460px] text-body-relaxed text-text-2">
                  {t.t('scripting.builder.empty.body')}
                </p>
              </div>
            ) : (
              <>
                <div
                  aria-hidden="true"
                  className={`${GRID} hidden h-control-md items-center border-b border-border bg-surface-sunken px-3 text-caption font-bold uppercase tracking-[0.04em] text-text-2 md:grid`}
                >
                  <span>{t.t('scripting.builder.col.script')}</span>
                  <span>{t.t('scripting.builder.col.programme')}</span>
                  <span>{t.t('scripting.builder.col.language')}</span>
                  <span>{t.t('scripting.builder.col.version')}</span>
                  <span>{t.t('scripting.builder.updated')}</span>
                </div>
                <ul className="flex flex-col">
                  {list.rows.map((row) => (
                    <ScriptRow
                      key={row.id}
                      t={t}
                      locale={locale}
                      row={row}
                      programme={programmeName(row.programmeId)}
                    />
                  ))}
                </ul>
              </>
            )}
            {list.cursor === null && !list.moreFailed ? null : (
              <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface px-3 py-2">
                {list.cursor === null ? null : (
                  <button
                    type="button"
                    data-testid="script-list-more"
                    disabled={list.loadingMore}
                    aria-busy={list.loadingMore}
                    onClick={() => void more()}
                    className={`${TOOL_BUTTON} disabled:cursor-not-allowed disabled:text-disabled-text`}
                  >
                    <Icon name="expand_more" size={18} />
                    {t.t('scripting.builder.more')}
                  </button>
                )}
                {list.moreFailed ? (
                  <p role="alert" className="text-meta text-danger-text">
                    {t.t('scripting.error.network')}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {creating ? (
          <CreateDialog
            t={t}
            programmes={programmes}
            offline={!online}
            onClose={() => {
              setCreating(false);
              opener.current?.focus();
            }}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

/** The table's columns at md and up (P04's list pattern): name, programme, language, version, updated. */
const GRID =
  'grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-3';

/** A version state chip: 22px, 11/700, radius full (the builder's version menu). */
function StateChip({
  tone,
  children,
}: {
  tone: 'draft' | 'live' | 'pending';
  children: ReactNode;
}) {
  const colour =
    tone === 'live'
      ? 'bg-success-soft text-success-text'
      : tone === 'draft'
        ? 'bg-accent-soft text-accent-text'
        : 'bg-warning-soft text-warning-text';
  return (
    <span
      className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-[7px] text-micro ${colour}`}
    >
      {children}
    </span>
  );
}

function ScriptRow({
  t,
  locale,
  row,
  programme,
}: {
  t: Translator;
  locale: string;
  row: ScriptSummary;
  programme: string | null;
}) {
  const published = row.latestVersion !== null;
  const href = UUID.test(row.id) ? `/scripts/${row.id}` : '/scripts';
  return (
    <li
      data-script-row={row.id}
      className={`relative flex min-w-0 flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0 is-hover:bg-surface-sunken md:grid md:min-h-[52px] md:items-center md:px-3 md:py-1.5 ${GRID}`}
    >
      <Link
        href={href}
        className="min-w-0 truncate rounded-sm text-body-sm font-semibold text-text after:absolute after:inset-0 is-focus-visible:ring-focus"
      >
        <span data-script-text="">{row.name}</span>
      </Link>
      <span className="min-w-0 truncate text-caption font-normal text-text-2 md:text-body-sm md:text-text">
        {programme === null ? (
          <span className="text-text-muted">—</span>
        ) : (
          <span data-record-text="">{programme}</span>
        )}
      </span>
      <span lang={row.sourceLocale} className="hidden truncate text-body-sm md:block">
        {localeLabel(row.sourceLocale)}
      </span>
      <p
        data-script-state={published ? 'published' : 'draft'}
        data-unpublished={row.hasUnpublishedChanges ? 'true' : 'false'}
        className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta"
      >
        {published && row.latestVersion !== null ? (
          <>
            <span className="font-mono font-semibold">
              {t.t('scripting.builder.version.short', { number: row.latestVersion.number })}
            </span>
            <StateChip tone="live">{t.t('scripting.builder.version.live')}</StateChip>
            {row.hasUnpublishedChanges ? (
              <StateChip tone="pending">{t.t('scripting.builder.state.unpublished')}</StateChip>
            ) : null}
          </>
        ) : (
          <StateChip tone="draft">{t.t('scripting.builder.state.draft')}</StateChip>
        )}
      </p>
      <span className="text-caption font-normal text-text-muted md:text-body-sm md:text-text-2">
        <span className="md:hidden">{t.t('scripting.builder.updated')} </span>
        <time dateTime={row.updatedAt}>{formatDay(locale, row.updatedAt)}</time>
      </span>
    </li>
  );
}

export function formatDay(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  // "20 Oct 2026": day first in every English (T-0143).
  return formatDayFirst(locale, at, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Create a draft in a programme chosen by NAME. The API's 403 is the gate (D-L84); what was typed is kept. */
function CreateDialog({
  t,
  programmes,
  offline,
  onClose,
}: {
  t: Translator;
  programmes: readonly Programme[];
  offline: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [programme, setProgramme] = useState('');
  const [sourceLocale, setSourceLocale] = useState<ScriptLocale>('en');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const title = useId();
  const nameId = useId();
  const programmeId = useId();
  const localeId = useId();
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    first.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || programme === '') {
      setError('scripting.builder.create.missing');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createScript({ programmeId: programme, name: trimmed, sourceLocale });
    if (result.ok && UUID.test(result.value.id)) {
      router.push(`/scripts/${result.value.id}`);
      return;
    }
    setSaving(false);
    setError(
      result.ok ? 'scripting.error.network' : (`scripting.error.${result.error.code}` as MessageId),
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-scrim md:items-center md:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid="script-create"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-lg bg-surface p-4 shadow-3 md:rounded-lg"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={title} className="text-h4">
            {t.t('scripting.builder.create.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.t('scripting.builder.create.cancel')}
            className={QUIET_BUTTON}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={nameId} className="flex flex-col gap-1 text-body-sm font-semibold">
            {t.t('scripting.builder.create.name')}
            <input
              ref={first}
              id={nameId}
              data-field-input="name"
              value={name}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              className={`${FIELD} w-full font-normal`}
            />
          </label>
          <label htmlFor={programmeId} className="flex flex-col gap-1 text-body-sm font-semibold">
            {t.t('scripting.builder.create.programme')}
            <select
              id={programmeId}
              data-field-input="programmeId"
              value={programme}
              onChange={(event) => setProgramme(event.target.value)}
              className={`${FIELD} w-full font-normal`}
            >
              <option value="">{t.t('scripting.builder.create.choose')}</option>
              {programmes.map((entry) => (
                <option key={entry.id} value={entry.id} data-record-text="">
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={localeId} className="flex flex-col gap-1 text-body-sm font-semibold">
            {t.t('scripting.builder.create.locale')}
            <select
              id={localeId}
              data-field-input="sourceLocale"
              value={sourceLocale}
              onChange={(event) => setSourceLocale(event.target.value as ScriptLocale)}
              className={`${FIELD} w-full font-normal`}
            >
              {SCRIPT_LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {localeLabel(code)}
                </option>
              ))}
            </select>
          </label>
          {error === null ? null : (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
            >
              <Icon name="error" size="sm" />
              {t.t(error)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              {t.t('scripting.builder.create.cancel')}
            </button>
            <button
              type="submit"
              data-action="create-script"
              data-requires-connection=""
              disabled={offline || saving}
              aria-busy={saving}
              className={`${PRIMARY_BUTTON} disabled:opacity-60`}
            >
              {t.t(saving ? 'scripting.builder.create.saving' : 'scripting.builder.create.submit')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
