'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createBundleTranslator, localeLabel, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, LINK, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import {
  NODE_TYPES,
  SCRIPT_LOCALES,
  nodeById,
  type NodeType,
  type ScriptGraph,
  type ScriptLocale,
  type ScriptNode,
  type ScriptVersion,
  type VersionSummary,
} from '../../lib/script-graph';
import { getScriptVersion, listScriptVersions, type Script } from '../../lib/scripting-api';
import { complianceDiff, isEmptyDiff, newNode, withNode, type PublishProblem } from './builder-model';
import { NodeInspector } from './node-inspector';
import { ScriptCanvas } from './script-canvas';
import { formatDay } from './script-list-screen';
import { useScriptEditor, type ScriptEditorState } from './use-script-editor';

/**
 * `P10/05` — the script builder's editor (T-0115), for the admin set
 * (`script.write`, who also edit compliance wording, D-P32). Behind
 * the scripts flag, read by the server page only.
 *
 * ---------------------------------------------------------------------------
 *   - The draft is edited in memory and saved by an explicit control (R4),
 *     sending `revision` plus the top-level fields that changed (D-L102); a
 *     409 re-reads and re-applies the author's edits node by node (R5).
 *   - Publish is offered only for SAVED changes (R7): it snapshots the
 *     server's draft. A published version is immutable and opens read-only.
 *   - Translations are edited per design locale against the source wording
 *     and PUT whole for each locale that changed (R10).
 *   - The compliance diff compares the draft with the latest version by node
 *     title (R8).
 *
 * NOT DRAWN (D-L88, D-L91, D-P31, D-P32): publishing to several programmes,
 * a compliance approver or lock, AI line suggestions, QA flags, call-bound
 * controls, a form field bound to a record, `loan.*` variables, and the
 * "preview as agent" sample record.
 * ---------------------------------------------------------------------------
 */

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

export function ScriptEditorScreen({
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
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useScriptEditor(id);
  const [viewing, setViewing] = useState<ScriptVersion | null>(null);
  const offline = !state.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="scripts" live={live}>
      <div
        data-screen="P10/05"
        data-builder-view={viewing === null ? 'editor' : 'version'}
        data-builder-state={state.phase === 'loading' ? 'loading' : 'ready'}
        data-unpublished={state.served === null ? undefined : String(state.served.hasUnpublishedChanges)}
        data-read-only={viewing === null ? undefined : 'true'}
        className="flex min-w-0 flex-col gap-4"
      >
        <Link href="/scripts" className={`inline-flex min-h-touch items-center gap-1 self-start ${LINK}`}>
          <Icon name="arrow_back" size="sm" className="rtl:-scale-x-100" />
          {t.t('scripting.builder.back')}
        </Link>
        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}
        {state.phase === 'loading' ? <EditorSkeleton t={t} slow={state.slow} /> : null}
        {state.phase === 'not-found' ? <RecordNotFound t={t} /> : null}
        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="scripting.builder.unavailable" error={{ code: 'network' }} offline={offline} onRetry={state.reload} />
        ) : null}
        {state.phase === 'ready' && state.served !== null && state.draft !== null ? (
          <Editor t={t} locale={locale} state={state} served={state.served} offline={offline} viewing={viewing} onView={setViewing} />
        ) : null}
      </div>
    </CrmShell>
  );
}

function EditorSkeleton({ t, slow }: { t: Translator; slow: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      {slow ? (
        <p role="status" data-testid="still-connecting" className="rounded-lg bg-info-soft p-4 text-body-sm text-info-text">
          {t.t('scripting.builder.slow')}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {t.t('scripting.builder.loading')}
      </span>
      <div data-testid="builder-skeleton" aria-hidden="true" className="h-12 w-1/2 rounded-md bg-surface-sunken" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div data-testid="builder-skeleton" aria-hidden="true" className="h-96 rounded-lg border border-border bg-surface-sunken lg:col-span-2" />
        <div data-testid="builder-skeleton" aria-hidden="true" className="h-96 rounded-lg border border-border bg-surface-sunken" />
      </div>
    </div>
  );
}

function Editor({
  t,
  locale,
  state,
  served,
  offline,
  viewing,
  onView,
}: {
  t: Translator;
  locale: string;
  state: ScriptEditorState;
  served: Script;
  offline: boolean;
  viewing: ScriptVersion | null;
  onView: (version: ScriptVersion | null) => void;
}) {
  const draft = state.draft ?? { name: served.name, graph: served.draft.graph };
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<ScriptLocale | null>(null);
  const [versions, setVersions] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const publishButton = useRef<HTMLButtonElement | null>(null);
  const nameId = useId();
  const readOnly = viewing !== null;
  const graph = viewing?.graph ?? draft.graph;
  const node = nodeById(graph, selected);
  const writable = !readOnly && !offline && state.busy === null;
  const canPublish = served.hasUnpublishedChanges && !state.dirty && writable;
  const translations = viewing?.translations ?? served.draft.translations;

  const words = {
    title: t.t('scripting.builder.newNode.title'),
    text: t.t('scripting.builder.newNode.text'),
    choice: t.t('scripting.builder.newChoice'),
    field: t.t('scripting.builder.newField'),
    option: t.t('scripting.builder.newOption'),
  };

  const add = (type: NodeType) => {
    const created = newNode(type, draft.graph, words);
    state.setGraph((current) => ({ ...current, nodes: [...current.nodes, created] }));
    setSelected(created.id);
  };

  const change = (next: ScriptNode) => state.setGraph((current) => withNode(current, next.id, () => next));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={PANEL}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-semibold text-text-muted">{t.t('scripting.builder.eyebrow')}</span>
          <h1 data-script-text="" className="break-words text-h3">
            {viewing?.name ?? draft.name}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-body-sm">
          <span className={`rounded-full px-2 font-semibold ${served.latestVersion === null ? 'bg-surface-sunken text-text-2' : 'bg-success-soft text-success-text'}`}>
            {served.latestVersion === null
              ? t.t('scripting.builder.state.draft')
              : t.t('scripting.builder.state.published', { number: served.latestVersion.number })}
          </span>
          {served.hasUnpublishedChanges && served.latestVersion !== null ? (
            <span className="rounded-full bg-warning-soft px-2 font-semibold text-warning-text">{t.t('scripting.builder.state.unpublished')}</span>
          ) : null}
          {state.dirty ? <span className="rounded-full bg-info-soft px-2 font-semibold text-info-text">{t.t('scripting.builder.unsaved')}</span> : null}
        </div>
        <label htmlFor={nameId} className="flex max-w-xl flex-col gap-1 text-body-sm font-semibold">
          {t.t('scripting.builder.name')}
          <input
            id={nameId}
            data-field-input="script-name"
            value={viewing?.name ?? draft.name}
            maxLength={120}
            readOnly={readOnly}
            onChange={(event) => state.setName(event.target.value)}
            className={`${FIELD} w-full font-normal read-only:bg-surface-sunken`}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-action="save-draft"
            data-requires-connection=""
            disabled={!writable || !state.dirty || draft.name.trim() === ''}
            aria-busy={state.busy === 'save'}
            onClick={() => void state.save()}
            className={`${PRIMARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="cloud_upload" size="sm" />
            {t.t(state.busy === 'save' ? 'scripting.builder.saving' : 'scripting.builder.save')}
          </button>
          <button
            ref={publishButton}
            type="button"
            data-action="publish"
            data-requires-connection=""
            aria-haspopup="dialog"
            disabled={!canPublish}
            onClick={() => setPublishing(true)}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="verified" size="sm" />
            {t.t('scripting.builder.publish')}
          </button>
          <button
            type="button"
            data-action="versions"
            aria-expanded={versions}
            disabled={served.latestVersion === null}
            onClick={() => setVersions((value) => !value)}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            <Icon name="history" size="sm" />
            {t.t('scripting.builder.versions')}
          </button>
        </div>
        {readOnly && viewing !== null ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-info-soft p-3 text-body-sm text-info-text">
            <Icon name="lock" size="sm" />
            <span>{t.t('scripting.builder.viewing', { number: viewing.number })}</span>
            <button type="button" data-action="back-to-draft" onClick={() => onView(null)} className={QUIET_BUTTON}>
              {t.t('scripting.builder.backToDraft')}
            </button>
          </div>
        ) : null}
        <Notice t={t} state={state} graph={draft.graph} />
      </section>

      {versions ? (
        <VersionsPanel
          t={t}
          locale={locale}
          script={served}
          onOpen={(version) => {
            onView(version);
            setVersions(false);
            setSelected(null);
          }}
        />
      ) : null}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <div role="group" aria-label={t.t('scripting.builder.palette')} className="flex flex-wrap gap-2">
            {NODE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                data-action="add-node"
                data-node-type={type}
                data-requires-connection=""
                disabled={readOnly || offline}
                onClick={() => add(type)}
                className={`${SECONDARY_BUTTON} min-h-touch px-3 text-body-sm disabled:opacity-60`}
              >
                <Icon name="add" size="sm" />
                {t.t(`scripting.nodeType.${type}` as MessageId)}
              </button>
            ))}
          </div>
          <ScriptCanvas t={t} graph={graph} selected={selected} invalid={readOnly ? new Set() : state.invalid} onSelect={setSelected} />
          {!readOnly && state.latest !== null ? <DiffPanel t={t} draft={draft.graph} latest={state.latest} /> : null}
        </div>

        <aside className={`${PANEL} lg:sticky lg:top-20`} aria-label={t.t('scripting.builder.inspector')}>
          <div data-testid="language-tabs" role="group" aria-label={t.t('scripting.builder.languages')} className="flex flex-wrap gap-1">
            <button
              type="button"
              data-locale-source={served.sourceLocale}
              aria-pressed={tab === null}
              onClick={() => setTab(null)}
              className={tabClass(tab === null)}
            >
              {localeLabel(served.sourceLocale)}
            </button>
            {SCRIPT_LOCALES.filter((code) => code !== served.sourceLocale).map((code) => (
              <button key={code} type="button" lang={code} data-locale-tab={code} aria-pressed={tab === code} onClick={() => setTab(code)} className={tabClass(tab === code)}>
                {localeLabel(code)}
              </button>
            ))}
          </div>
          {node === undefined ? (
            <p className="text-body-sm text-text-2">{t.t('scripting.builder.inspector.empty')}</p>
          ) : (
            <div data-testid="node-inspector" data-inspecting={node.id} className="flex min-w-0 flex-col gap-3">
              {tab === null ? (
                <NodeInspector
                  t={t}
                  graph={graph}
                  node={node}
                  readOnly={readOnly}
                  dispositions={state.dispositions}
                  conflicts={readOnly ? [] : (state.conflicts[node.id] ?? [])}
                  onChange={change}
                  onRemove={() => {
                    state.setGraph((current) => ({ ...current, nodes: current.nodes.filter((entry) => entry.id !== node.id) }));
                    setSelected(null);
                  }}
                  onStart={() => state.setGraph((current) => ({ ...current, startNodeId: node.id }))}
                />
              ) : (
                <TranslationEditor
                  t={t}
                  node={node}
                  locale={tab}
                  readOnly={readOnly}
                  value={state.edits[tab]?.[node.id] ?? translations[tab]?.[node.id]?.text ?? ''}
                  onChange={(text) => state.setTranslation(tab, node.id, text)}
                />
              )}
            </div>
          )}
        </aside>
      </div>

      {publishing ? (
        <PublishDialog
          t={t}
          next={(served.latestVersion?.number ?? 0) + 1}
          busy={state.busy === 'publish'}
          offline={offline}
          onConfirm={async (changes) => {
            await state.publish(changes);
            setPublishing(false);
            publishButton.current?.focus();
          }}
          onClose={() => {
            setPublishing(false);
            publishButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function tabClass(active: boolean): string {
  return `min-h-touch rounded-full border px-3 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
    active ? 'border-primary bg-primary-soft text-primary-text' : 'border-border-strong bg-surface text-text'
  }`;
}

function Notice({ t, state, graph }: { t: Translator; state: ScriptEditorState; graph: ScriptGraph }) {
  const notice = state.notice;
  if (notice === null) return null;
  if (notice.kind === 'saved' || notice.kind === 'published') {
    return (
      <p role="status" className="flex items-center gap-2 text-body-sm font-semibold text-success-text">
        <Icon name="check_circle" size="sm" />
        {notice.kind === 'saved' ? t.t('scripting.builder.saved') : t.t('scripting.builder.published', { number: notice.number })}
      </p>
    );
  }
  if (notice.kind === 'invalid') {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
        <p className="flex items-center gap-2 font-bold">
          <Icon name="error" size="sm" />
          {t.t('scripting.builder.refused')}
        </p>
        <ul className="flex list-disc flex-col gap-1 ps-6">
          {notice.problems.map((problem, index) => (
            <Problem key={index} t={t} problem={problem} title={nodeById(graph, problem.nodeId)?.title ?? null} />
          ))}
        </ul>
      </div>
    );
  }
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
      <Icon name="error" size="sm" />
      {t.t(`scripting.error.${notice.error.code}` as MessageId)}
    </p>
  );
}

function Problem({ t, problem, title }: { t: Translator; problem: PublishProblem; title: string | null }) {
  const reason = t.t(problem.reason === null ? 'scripting.builder.reason.other' : (`scripting.builder.reason.${problem.reason}` as MessageId));
  return (
    <li>
      {title === null ? null : <b data-script-text="">{title}</b>} <span>{reason}</span>
    </li>
  );
}

function DiffPanel({ t, draft, latest }: { t: Translator; draft: ScriptGraph; latest: ScriptVersion }) {
  const diff = complianceDiff(draft, latest.graph);
  const heading = useId();
  const groups = [
    ['added', diff.added],
    ['changed', diff.changed],
    ['removed', diff.removed],
  ] as const;
  return (
    <section data-testid="compliance-diff" aria-labelledby={heading} className={PANEL}>
      <h2 id={heading} className="flex items-center gap-2 text-h5">
        <Icon name="verified_user" size="sm" />
        {t.t('scripting.builder.diff.title', { number: latest.number })}
      </h2>
      {isEmptyDiff(diff) ? (
        <p className="text-body-sm text-text-2">{t.t('scripting.builder.diff.none', { number: latest.number })}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {groups.flatMap(([kind, nodes]) =>
            nodes.map((entry) => (
              <li key={`${kind}-${entry.id}`} data-compliance-diff={kind} className="flex flex-wrap items-center gap-2 text-body-sm">
                <span className="rounded-sm bg-warning-soft px-2 text-caption font-bold text-warning-text">{t.t(`scripting.builder.diff.${kind}` as MessageId)}</span>
                <span data-script-text="">{entry.title}</span>
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  );
}

function TranslationEditor({
  t,
  node,
  locale,
  readOnly,
  value,
  onChange,
}: {
  t: Translator;
  node: ScriptNode;
  locale: ScriptLocale;
  readOnly: boolean;
  value: string;
  onChange: (text: string) => void;
}) {
  const inputId = useId();
  const source = node.type === 'branch' ? null : (node.text ?? null);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="rounded-sm bg-surface-sunken px-2 text-caption font-bold uppercase text-text-2">{t.t(`scripting.nodeType.${node.type}` as MessageId)}</span>
      <p data-script-text="" className="text-body-md font-semibold">
        {node.title}
      </p>
      {source === null ? (
        <p className="text-body-sm text-text-2">{t.t('scripting.builder.translation.none')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-body-sm font-semibold">{t.t('scripting.builder.translation.source')}</p>
            <p data-script-text="" className="whitespace-pre-line rounded-md bg-surface-sunken p-2 text-body-sm">
              {source}
            </p>
          </div>
          <label htmlFor={inputId} className="flex flex-col gap-1 text-body-sm font-semibold">
            <span>
              {t.t('scripting.builder.translation.text')} <span lang={locale}>{localeLabel(locale)}</span>
            </span>
            <textarea
              id={inputId}
              lang={locale}
              data-field-input="translation-text"
              rows={4}
              maxLength={4000}
              value={value}
              readOnly={readOnly}
              onChange={(event) => onChange(event.target.value)}
              className={`${FIELD} w-full py-2 font-normal read-only:bg-surface-sunken`}
            />
          </label>
        </>
      )}
    </div>
  );
}

function VersionsPanel({ t, locale, script, onOpen }: { t: Translator; locale: string; script: Script; onOpen: (version: ScriptVersion) => void }) {
  const [rows, setRows] = useState<readonly VersionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const heading = useId();

  const read = async (from: string | null, held: readonly VersionSummary[]) => {
    setPhase('loading');
    const page = await listScriptVersions(script.id, from);
    if (!page.ok) {
      setPhase(held.length === 0 ? 'error' : 'ready');
      setFailed(held.length > 0);
      return;
    }
    const seen = new Set(held.map((row) => row.id));
    setRows([...held, ...page.value.data.filter((row) => !seen.has(row.id))]);
    setCursor(page.value.nextCursor);
    setPhase('ready');
  };

  useEffect(() => {
    void read(null, []);
    // Read when the panel opens.
  }, []);

  const open = async (version: VersionSummary) => {
    setOpening(version.id);
    setFailed(false);
    const result = await getScriptVersion(script.id, version.id);
    setOpening(null);
    if (result.ok) onOpen(result.value);
    else setFailed(true);
  };

  return (
    <section aria-labelledby={heading} className={PANEL}>
      <h2 id={heading} className="text-h5">
        {t.t('scripting.builder.versions.title')}
      </h2>
      {phase === 'error' ? (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t('scripting.error.network')}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              data-version-row={row.id}
              aria-busy={opening === row.id}
              onClick={() => void open(row)}
              className="flex min-h-touch w-full flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-start text-body-sm hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <b>{t.t('scripting.builder.versions.row', { number: row.number })}</b>
              <time dateTime={row.publishedAt}>{formatDay(locale, row.publishedAt)}</time>
              {row.publishedBy === null ? (
                <span className="text-text-muted">{t.t('scripting.builder.versions.former')}</span>
              ) : (
                <span data-record-text="">{row.publishedBy.displayName}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t('scripting.error.network')}
        </p>
      ) : null}
      {cursor === null ? null : (
        <button
          type="button"
          data-testid="version-list-more"
          disabled={phase === 'loading'}
          onClick={() => void read(cursor, rows)}
          className={`${QUIET_BUTTON} self-start disabled:opacity-60`}
        >
          {t.t('scripting.builder.versions.more')}
        </button>
      )}
    </section>
  );
}

function PublishDialog({
  t,
  next,
  busy,
  offline,
  onConfirm,
  onClose,
}: {
  t: Translator;
  next: number;
  busy: boolean;
  offline: boolean;
  onConfirm: (changes: readonly string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [change, setChange] = useState('');
  const title = useId();
  const changeId = useId();
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    first.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-scrim md:items-center md:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={title} data-testid="publish-dialog" className="flex w-full max-w-md flex-col gap-4 rounded-t-lg bg-surface p-4 shadow-3 md:rounded-lg">
        <h2 id={title} className="text-h4">
          {t.t('scripting.builder.publish.title', { number: next })}
        </h2>
        <p className="text-body-sm text-text-2">{t.t('scripting.builder.publish.body', { number: next })}</p>
        <label htmlFor={changeId} className="flex flex-col gap-1 text-body-sm font-semibold">
          {t.t('scripting.builder.publish.change')}
          <input
            ref={first}
            id={changeId}
            data-field-input="publish-change"
            value={change}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setChange(event.target.value)}
            className={`${FIELD} w-full font-normal`}
          />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${SECONDARY_BUTTON} disabled:opacity-60`}>
            {t.t('scripting.builder.publish.cancel')}
          </button>
          <button
            type="button"
            data-action="confirm-publish"
            data-requires-connection=""
            disabled={busy || offline}
            aria-busy={busy}
            onClick={() => void onConfirm(change.trim() === '' ? [] : [change.trim()])}
            className={`${PRIMARY_BUTTON} disabled:opacity-60`}
          >
            {t.t(busy ? 'scripting.builder.publishing' : 'scripting.builder.publish.confirm', { number: next })}
          </button>
        </div>
      </section>
    </div>
  );
}
