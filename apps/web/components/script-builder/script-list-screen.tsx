'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { createBundleTranslator, localeLabel, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, LINK, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { SCRIPT_LOCALES, type ScriptLocale } from '../../lib/script-graph';
import { createScript, listMyProgrammes, listScripts, type Programme, type ScriptSummary } from '../../lib/scripting-api';
import { useOnline } from './use-online';

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

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

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
  const [list, setList] = useState<ListState>({ phase: 'loading', rows: [], cursor: null, loadingMore: false, moreFailed: false });
  const [programmes, setProgrammes] = useState<readonly Programme[]>([]);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setList({ phase: 'loading', rows: [], cursor: null, loadingMore: false, moreFailed: false });
    void Promise.all([listScripts(null, controller.signal), listMyProgrammes(controller.signal)]).then(([page, mine]) => {
      if (controller.signal.aborted) return;
      if (mine.ok) setProgrammes(mine.value.data);
      if (!page.ok) {
        setList((current) => ({ ...current, phase: 'error' }));
        return;
      }
      setSyncedAt(new Date());
      setList({ phase: 'ready', rows: page.value.data, cursor: page.value.nextCursor, loadingMore: false, moreFailed: false });
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
      return { ...current, rows: [...current.rows, ...page.value.data.filter((row) => !seen.has(row.id))], cursor: page.value.nextCursor, loadingMore: false };
    });
    if (page.ok) setSyncedAt(new Date());
  };

  const programmeName = (id: string) => programmes.find((programme) => programme.id === id)?.name ?? null;
  const headingId = useId();

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="scripts" live={live}>
      <div
        data-screen="P10/05"
        data-builder-view="list"
        data-builder-state={list.phase === 'loading' ? 'loading' : 'ready'}
        className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 id={headingId} className="text-h2">
              {t.t('scripting.builder.title')}
            </h1>
            <p className="text-body-md text-text-2">{t.t('scripting.builder.intro')}</p>
          </div>
          <button
            ref={opener}
            type="button"
            data-action="new-script"
            data-requires-connection=""
            aria-haspopup="dialog"
            disabled={!online}
            onClick={() => setCreating(true)}
            className={`${PRIMARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="add" size="sm" />
            {t.t('scripting.builder.new')}
          </button>
        </div>

        {online ? null : <RecordOfflineBanner t={t} locale={locale} syncedAt={syncedAt} />}

        {list.phase === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span role="status" className="sr-only">
              {t.t('scripting.builder.loading')}
            </span>
            {[0, 1, 2].map((row) => (
              <div key={row} data-testid="builder-skeleton" aria-hidden="true" className="h-16 rounded-lg border border-border bg-surface-sunken" />
            ))}
          </div>
        ) : null}

        {list.phase === 'error' ? (
          <RecordUnavailable t={t} heading="scripting.builder.unavailable" error={{ code: 'network' }} offline={!online} onRetry={() => setAttempt((value) => value + 1)} />
        ) : null}

        {list.phase === 'ready' ? (
          <section data-testid="script-list" aria-labelledby={headingId} className={PANEL}>
            {list.rows.length === 0 ? (
              <div data-testid="script-list-empty" className="flex flex-col gap-1 py-6">
                <p className="text-body-lg font-semibold">{t.t('scripting.builder.empty.title')}</p>
                <p className="text-body-md text-text-2">{t.t('scripting.builder.empty.body')}</p>
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {list.rows.map((row) => (
                  <ScriptRow key={row.id} t={t} locale={locale} row={row} programme={programmeName(row.programmeId)} />
                ))}
              </ul>
            )}
            {list.cursor === null ? null : (
              <button
                type="button"
                data-testid="script-list-more"
                disabled={list.loadingMore}
                aria-busy={list.loadingMore}
                onClick={() => void more()}
                className={`${SECONDARY_BUTTON} self-start disabled:opacity-60`}
              >
                {t.t('scripting.builder.more')}
              </button>
            )}
            {list.moreFailed ? (
              <p role="alert" className="text-body-sm text-danger-text">
                {t.t('scripting.error.network')}
              </p>
            ) : null}
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

function ScriptRow({ t, locale, row, programme }: { t: Translator; locale: string; row: ScriptSummary; programme: string | null }) {
  const published = row.latestVersion !== null;
  return (
    <li data-script-row={row.id} className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Link href={UUID.test(row.id) ? `/scripts/${row.id}` : '/scripts'} className={`break-words text-body-lg ${LINK}`}>
          <span data-script-text="">{row.name}</span>
        </Link>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-text-2">
          {programme === null ? null : <span data-record-text="">{programme}</span>}
          <span lang={row.sourceLocale}>{localeLabel(row.sourceLocale)}</span>
          <span>
            {t.t('scripting.builder.updated')} <time dateTime={row.updatedAt}>{formatDay(locale, row.updatedAt)}</time>
          </span>
        </p>
      </div>
      <p
        data-script-state={published ? 'published' : 'draft'}
        data-unpublished={row.hasUnpublishedChanges ? 'true' : 'false'}
        className="flex shrink-0 flex-wrap items-center gap-2 text-body-sm"
      >
        <span className={`rounded-full px-2 font-semibold ${published ? 'bg-success-soft text-success-text' : 'bg-surface-sunken text-text-2'}`}>
          {published && row.latestVersion !== null
            ? t.t('scripting.builder.state.published', { number: row.latestVersion.number })
            : t.t('scripting.builder.state.draft')}
        </span>
        {published && row.hasUnpublishedChanges ? (
          <span className="rounded-full bg-warning-soft px-2 font-semibold text-warning-text">{t.t('scripting.builder.state.unpublished')}</span>
        ) : null}
      </p>
    </li>
  );
}

export function formatDay(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  }
}

/** Create a draft in a programme chosen by NAME. The API's 403 is the gate (D-L84); what was typed is kept. */
function CreateDialog({ t, programmes, offline, onClose }: { t: Translator; programmes: readonly Programme[]; offline: boolean; onClose: () => void }) {
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
    setError(result.ok ? 'scripting.error.network' : (`scripting.error.${result.error.code}` as MessageId));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-scrim md:items-center md:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={title} data-testid="script-create" className="flex w-full max-w-md flex-col gap-4 rounded-t-lg bg-surface p-4 shadow-3 md:rounded-lg">
        <div className="flex items-start justify-between gap-2">
          <h2 id={title} className="text-h4">
            {t.t('scripting.builder.create.title')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t.t('scripting.builder.create.cancel')} className={QUIET_BUTTON}>
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
            <select id={programmeId} data-field-input="programmeId" value={programme} onChange={(event) => setProgramme(event.target.value)} className={`${FIELD} w-full font-normal`}>
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
            <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
              <Icon name="error" size="sm" />
              {t.t(error)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              {t.t('scripting.builder.create.cancel')}
            </button>
            <button type="submit" data-action="create-script" data-requires-connection="" disabled={offline || saving} aria-busy={saving} className={`${PRIMARY_BUTTON} disabled:opacity-60`}>
              {t.t(saving ? 'scripting.builder.create.saving' : 'scripting.builder.create.submit')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
