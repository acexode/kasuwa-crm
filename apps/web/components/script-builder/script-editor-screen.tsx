'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  createBundleTranslator,
  localeLabel,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { NODE_STYLE, PALETTE_ORDER, TypePill } from '../script-shared/node-style';
import {
  SCRIPT_LOCALES,
  nodeById,
  type NodeType,
  type ScriptGraph,
  type ScriptLocale,
  type ScriptNode,
  type ScriptVersion,
  type VersionSummary,
} from '../../lib/script-graph';
import {
  getScriptVersion,
  listMyProgrammes,
  listScriptVersions,
  type Script,
} from '../../lib/scripting-api';
import {
  complianceDiff,
  isEmptyDiff,
  newNode,
  withNode,
  type PublishProblem,
} from './builder-model';
import { NodeInspector } from './node-inspector';
import { ScriptCanvas, type NodePreview } from './script-canvas';
import { formatDay } from './script-list-screen';
import { useScriptEditor, type ScriptEditorState } from './use-script-editor';

/**
 * `P10/05` — the script builder's editor (T-0115), drawn to the export's
 * "Admin · Script Builder" view (T-0139): a full-height workspace under the
 * shell's top bar. A header (breadcrumb, the name as the title, the save
 * note, the version menu, Publish vN and the language tabs with how much of
 * each is translated), then three columns: the node palette, the canvas on a
 * dot grid and the inspector. For the admin set (`script.write`, who also
 * edit compliance wording, D-P32). Behind the scripts flag, read by the server
 * page only.
 *
 * ---------------------------------------------------------------------------
 *   - The draft is edited in memory and saved by an explicit control (R4),
 *     sending `revision` plus the top-level fields that changed (D-L102); a
 *     409 re-reads and re-applies the author's edits node by node (R5). The
 *     design's "Draft saved · n min ago" note sits where the export puts it;
 *     the save control appears beside it only while there is something to
 *     save (R4 holds: nothing is saved behind the author's back).
 *   - Publish is offered only for SAVED changes (R7): it snapshots the
 *     server's draft. A published version is immutable and opens read-only.
 *   - Translations are edited per design locale against the source wording
 *     and PUT whole for each locale that changed (R10).
 *   - The compliance diff compares the draft with the latest version by node
 *     title (R8).
 *
 * NOT DRAWN (D-L88, D-L91, D-P31, D-P32): a compliance approver or lock, AI
 * line suggestions, QA flags, call-bound controls, a form field bound to a
 * record and `loan.*` variables. Drawn disabled behind their flags (D-L194):
 * "Assigned to" (`script_programme_assignment`: one programme per script,
 * D-L91) and Preview (`script_preview`: no sample record).
 * ---------------------------------------------------------------------------
 */

/** The design's tab order after the source: Hausa, Yorùbá, Igbo, Pidgin, French; then the rest. */
const TAB_ORDER: readonly ScriptLocale[] = ['en', 'ha', 'yo', 'ig', 'pcm', 'fr', 'sw'];

/** A 40px header button (the export's builder header: 0 14px, radius 8, 13/700, an 18px glyph). */
const HEADER_BUTTON =
  'inline-flex h-control-md shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 text-meta font-bold is-focus-visible:ring-focus disabled:cursor-not-allowed';
const OUTLINE =
  'border border-border-strong bg-surface text-text is-hover:bg-surface-sunken disabled:border-border disabled:text-disabled-text';
const PRIMARY =
  'bg-primary text-on-primary is-hover:bg-primary-hover is-active:bg-primary-active disabled:bg-disabled-bg disabled:text-disabled-text';

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
  const name = state.draft?.name ?? state.served?.name;

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="studio"
      live={live}
      appBar={{ title: name ?? t.t('scripting.builder.title'), back: '/scripts' }}
    >
      <div
        data-screen="P10/05"
        data-builder-view={viewing === null ? 'editor' : 'version'}
        data-builder-state={state.phase === 'loading' ? 'loading' : 'ready'}
        data-unpublished={
          state.served === null ? undefined : String(state.served.hasUnpublishedChanges)
        }
        data-read-only={viewing === null ? undefined : 'true'}
        className="-m-4 flex min-w-0 flex-col md:-m-6 md:h-[calc(100dvh-var(--k-shell-header))]"
      >
        {offline ? (
          <div className="shrink-0 px-4 pt-3 md:px-5">
            <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} />
          </div>
        ) : null}
        {state.phase === 'loading' ? <EditorSkeleton t={t} slow={state.slow} /> : null}
        {state.phase === 'not-found' ? (
          <div className="p-4 md:p-6">
            <RecordNotFound t={t} />
          </div>
        ) : null}
        {state.phase === 'unavailable' ? (
          <div className="p-4 md:p-6">
            <RecordUnavailable
              t={t}
              heading="scripting.builder.unavailable"
              error={{ code: 'network' }}
              offline={offline}
              onRetry={state.reload}
            />
          </div>
        ) : null}
        {state.phase === 'ready' && state.served !== null && state.draft !== null ? (
          <Editor
            t={t}
            locale={locale}
            live={live}
            state={state}
            served={state.served}
            offline={offline}
            viewing={viewing}
            onView={setViewing}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

/** The workspace's own shape while it loads: header, then palette, canvas and inspector. */
function EditorSkeleton({ t, slow }: { t: Translator; slow: boolean }) {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <span role="status" className="sr-only">
        {t.t('scripting.builder.loading')}
      </span>
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-4 pb-3 pt-3.5 md:px-5">
        <div
          data-testid="builder-skeleton"
          aria-hidden="true"
          className="h-3 w-28 rounded-sm bg-surface-sunken"
        />
        <div
          data-testid="builder-skeleton"
          aria-hidden="true"
          className="h-6 w-1/3 rounded-sm bg-surface-sunken"
        />
        <div aria-hidden="true" className="flex gap-3">
          {[0, 1, 2, 3, 4].map((tab) => (
            <span key={tab} className="h-6 w-20 rounded-sm bg-surface-sunken" />
          ))}
        </div>
      </div>
      {slow ? (
        <div className="shrink-0 px-4 pt-3 md:px-5">
          <p
            role="status"
            data-testid="still-connecting"
            className="rounded-lg bg-info-soft p-4 text-body-sm text-info-text"
          >
            {t.t('scripting.builder.slow')}
          </p>
        </div>
      ) : null}
      <div className="flex min-h-[60vh] flex-1 flex-col md:min-h-0 md:flex-row">
        <div
          aria-hidden="true"
          className="hidden w-52 shrink-0 flex-col gap-1.5 border-e border-border bg-surface p-3.5 md:flex"
        >
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <span key={row} className="h-14 rounded-10 bg-surface-sunken" />
          ))}
        </div>
        <div
          data-testid="builder-skeleton"
          aria-hidden="true"
          className="min-h-[50vh] flex-1 bg-bg bg-[radial-gradient(var(--k-border)_1px,transparent_1px)] bg-[length:20px_20px]"
        />
        <div
          aria-hidden="true"
          className="hidden w-[330px] shrink-0 flex-col gap-3.5 border-s border-border bg-surface p-4 md:flex"
        >
          <span className="h-6 w-24 rounded-6 bg-surface-sunken" />
          <span className="h-control-md rounded-md bg-surface-sunken" />
          <span className="h-32 rounded-md bg-surface-sunken" />
        </div>
      </div>
    </div>
  );
}

function Editor({
  t,
  locale,
  live,
  state,
  served,
  offline,
  viewing,
  onView,
}: {
  t: Translator;
  locale: string;
  live: readonly string[];
  state: ScriptEditorState;
  served: Script;
  offline: boolean;
  viewing: ScriptVersion | null;
  onView: (version: ScriptVersion | null) => void;
}) {
  const draft = state.draft ?? { name: served.name, graph: served.draft.graph };
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState<ScriptLocale | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishButton = useRef<HTMLButtonElement | null>(null);
  const nameId = useId();
  const readOnly = viewing !== null;
  const graph = viewing?.graph ?? draft.graph;
  // The start node is selected until the author picks another, as the export opens.
  const node = nodeById(graph, chosen) ?? nodeById(graph, graph.startNodeId) ?? graph.nodes[0];
  const selected = node?.id ?? null;
  const writable = !readOnly && !offline && state.busy === null;
  const canPublish = served.hasUnpublishedChanges && !state.dirty && writable;
  const translations = viewing?.translations ?? served.draft.translations;
  const edits = readOnly ? {} : state.edits;
  const sourceLocale = viewing?.sourceLocale ?? served.sourceLocale;
  const next = (served.latestVersion?.number ?? 0) + 1;

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
    setChosen(created.id);
  };

  const change = (changed: ScriptNode) =>
    state.setGraph((current) => withNode(current, changed.id, () => changed));

  const translated = (code: ScriptLocale, nodeId: string): string =>
    edits[code]?.[nodeId] ?? translations[code]?.[nodeId]?.text ?? '';
  const wordy = graph.nodes.filter((entry) => entry.type !== 'branch' && (entry.text ?? '') !== '');
  const share = (code: ScriptLocale): number =>
    code === sourceLocale || wordy.length === 0
      ? 1
      : wordy.filter((entry) => translated(code, entry.id) !== '').length / wordy.length;
  const tabs = [
    sourceLocale,
    ...TAB_ORDER.filter(
      (code) => code !== sourceLocale && (SCRIPT_LOCALES as readonly string[]).includes(code),
    ),
  ];

  const preview = (entry: ScriptNode): NodePreview => {
    const source = entry.type === 'branch' ? null : (entry.text ?? null);
    if (tab === null || tab === sourceLocale) return { text: source, missing: null };
    const text = translated(tab, entry.id);
    if (text !== '') return { text, missing: null };
    if (source === null || source === '') return { text: null, missing: null };
    return {
      text: source,
      missing: t.t('scripting.builder.missingText', {
        language: localeLabel(tab),
        source: localeLabel(sourceLocale),
      }),
    };
  };

  // Locales part-way translated: their callers hear the source for the missing steps.
  const partial = tabs.filter(
    (code) => code !== sourceLocale && share(code) > 0 && share(code) < 1,
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-4 pt-3.5 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex min-w-[240px] flex-1 flex-col gap-px">
            <nav
              aria-label={t.t('scripting.builder.breadcrumb')}
              className="hidden text-caption font-normal text-text-muted md:block"
            >
              <span>{t.t('records.nav.studio')}</span>
              <span aria-hidden="true"> / </span>
              <Link
                href="/scripts"
                className="rounded-sm text-text-muted underline-offset-3 is-hover:text-text is-hover:underline is-focus-visible:ring-focus"
              >
                {t.t('scripting.builder.breadcrumb.scripts')}
              </Link>
            </nav>
            <h1 data-script-text="" className="sr-only">
              {viewing?.name ?? draft.name}
            </h1>
            <label htmlFor={nameId} className="sr-only">
              {t.t('scripting.builder.name')}
            </label>
            <input
              id={nameId}
              data-field-input="script-name"
              value={viewing?.name ?? draft.name}
              maxLength={120}
              readOnly={readOnly}
              autoComplete="off"
              onChange={(event) => state.setName(event.target.value)}
              className="-mx-1.5 h-7 min-w-0 truncate rounded-6 border border-transparent bg-transparent px-1.5 text-h4 font-bold leading-[26px] text-text is-hover:border-border is-focus:field-focus read-only:is-hover:border-transparent"
            />
          </div>
          {readOnly ? null : <SaveNote t={t} locale={locale} state={state} served={served} />}
          {readOnly || (!state.dirty && state.busy !== 'save') ? null : (
            <button
              type="button"
              data-action="save-draft"
              data-requires-connection=""
              disabled={!writable || !state.dirty || draft.name.trim() === ''}
              aria-busy={state.busy === 'save'}
              onClick={() => void state.save()}
              className={`${HEADER_BUTTON} ${OUTLINE}`}
            >
              <Icon name="cloud_upload" size={18} />
              {t.t(state.busy === 'save' ? 'scripting.builder.saving' : 'scripting.builder.save')}
            </button>
          )}
          <VersionMenu
            t={t}
            locale={locale}
            script={served}
            viewing={viewing}
            next={next}
            onOpen={(version) => {
              onView(version);
              setChosen(null);
            }}
          />
          {live.includes('script_preview') ? (
            <button
              type="button"
              disabled
              title={t.t('scripting.builder.preview.soon')}
              className={`${HEADER_BUTTON} ${OUTLINE}`}
            >
              <Icon name="play_arrow" size={18} />
              {t.t('scripting.builder.preview')}
            </button>
          ) : null}
          <div className="relative">
            <button
              ref={publishButton}
              type="button"
              data-action="publish"
              data-requires-connection=""
              aria-haspopup="dialog"
              aria-expanded={publishing}
              disabled={!canPublish}
              onClick={() => setPublishing((open) => !open)}
              className={`${HEADER_BUTTON} ${PRIMARY}`}
            >
              <Icon name="publish" size={18} />
              {t.t('scripting.builder.publishNext', { number: next })}
            </button>
            {publishing ? (
              <PublishPopover
                t={t}
                locale={locale}
                next={next}
                busy={state.busy === 'publish'}
                offline={offline}
                partial={partial}
                sourceLocale={sourceLocale}
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
        </div>

        {live.includes('script_programme_assignment') ? (
          <Assigned t={t} programmeId={served.programmeId} />
        ) : null}

        <Notice t={t} state={state} graph={draft.graph} />

        <div
          data-testid="language-tabs"
          role="tablist"
          aria-label={t.t('scripting.builder.languages')}
          className="-mb-px flex gap-0.5 overflow-x-auto"
        >
          {tabs.map((code) => {
            const active =
              code === sourceLocale ? tab === null || tab === sourceLocale : tab === code;
            const part = share(code);
            const sourceTab = code === sourceLocale;
            return (
              <button
                key={code}
                type="button"
                role="tab"
                lang={code}
                aria-selected={active}
                {...(sourceTab ? { 'data-locale-source': code } : { 'data-locale-tab': code })}
                onClick={() => setTab(sourceTab ? null : code)}
                className={`inline-flex h-[42px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-[3px] px-3.5 text-meta font-bold is-focus-visible:ring-focus ${
                  active
                    ? 'border-primary text-primary-text'
                    : 'border-transparent text-text-2 is-hover:text-text'
                }`}
              >
                {localeLabel(code)}
                <span
                  className={`inline-flex h-5 items-center rounded-full px-1.5 text-micro ${
                    part >= 1
                      ? 'bg-success-soft text-success-text'
                      : part < 0.5
                        ? 'bg-warning-soft text-warning-text'
                        : 'bg-surface-sunken text-text-2'
                  }`}
                >
                  {percent(locale, part)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label={t.t('scripting.builder.palette')}
          className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-surface p-3.5 md:w-52 md:overflow-y-auto md:border-b-0 md:border-e"
        >
          <h2 className="mb-1 text-overline text-text-muted">
            {t.t('scripting.builder.palette.heading')}
          </h2>
          <div
            role="group"
            aria-label={t.t('scripting.builder.palette')}
            className="-mx-3.5 flex gap-1.5 overflow-x-auto px-3.5 md:mx-0 md:flex-col md:overflow-visible md:px-0"
          >
            {PALETTE_ORDER.map((type) => (
              <button
                key={type}
                type="button"
                data-action="add-node"
                data-node-type={type}
                data-requires-connection=""
                disabled={readOnly || offline}
                onClick={() => add(type)}
                className="flex w-44 shrink-0 items-start gap-2.5 rounded-10 border border-border bg-surface p-2 text-start text-text is-hover:bg-surface-sunken is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text md:w-auto"
              >
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-md ${NODE_STYLE[type].tint}`}
                >
                  <Icon name={NODE_STYLE[type].icon} size={18} />
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <b className="text-meta font-bold">
                    {t.t(`scripting.nodeType.${type}` as MessageId)}
                  </b>
                  <span className="text-caption font-normal leading-4 text-text-muted">
                    {t.t(`scripting.builder.palette.${type}` as MessageId)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {!readOnly && state.latest !== null ? (
            <DiffPanel t={t} draft={draft.graph} latest={state.latest} />
          ) : null}
        </aside>

        <section
          aria-label={t.t('scripting.builder.canvas')}
          className="relative flex min-h-[60vh] min-w-0 flex-1 flex-col md:min-h-0"
        >
          {readOnly && viewing !== null ? (
            <div
              role="status"
              className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-accent bg-accent-soft px-4 py-2.5 text-meta"
            >
              <Icon name="visibility" size={18} className="text-accent-text" />
              <b className="flex-1">
                {t.t('scripting.builder.viewing', { number: viewing.number })}
              </b>
              <button
                type="button"
                data-action="back-to-draft"
                onClick={() => onView(null)}
                className="inline-flex h-8 items-center rounded-6 border border-accent-text bg-surface px-3 text-caption font-bold text-accent-text is-hover:bg-accent-soft is-focus-visible:ring-focus"
              >
                {t.t('scripting.builder.backToDraft')}
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto bg-bg bg-[radial-gradient(var(--k-border)_1px,transparent_1px)] bg-[length:20px_20px]">
            <ScriptCanvas
              t={t}
              graph={graph}
              selected={selected}
              invalid={readOnly ? new Set() : state.invalid}
              preview={preview}
              onSelect={setChosen}
            />
          </div>
        </section>

        <aside
          aria-label={t.t('scripting.builder.inspector')}
          className="flex shrink-0 flex-col gap-3.5 border-t border-border bg-surface p-4 md:w-[330px] md:overflow-y-auto md:border-s md:border-t-0"
        >
          {node === undefined ? (
            <p className="text-body-sm text-text-2">{t.t('scripting.builder.inspector.empty')}</p>
          ) : (
            <div
              data-testid="node-inspector"
              data-inspecting={node.id}
              className="flex min-w-0 flex-col gap-3.5"
            >
              {tab === null || tab === sourceLocale ? (
                <NodeInspector
                  t={t}
                  graph={graph}
                  node={node}
                  language={localeLabel(sourceLocale)}
                  readOnly={readOnly}
                  isStart={graph.startNodeId === node.id}
                  dispositions={state.dispositions}
                  conflicts={readOnly ? [] : (state.conflicts[node.id] ?? [])}
                  onChange={change}
                  onRemove={() => {
                    state.setGraph((current) => ({
                      ...current,
                      nodes: current.nodes.filter((entry) => entry.id !== node.id),
                    }));
                    setChosen(null);
                  }}
                  onStart={() =>
                    state.setGraph((current) => ({ ...current, startNodeId: node.id }))
                  }
                />
              ) : (
                <TranslationEditor
                  t={t}
                  node={node}
                  locale={tab}
                  sourceLocale={sourceLocale}
                  readOnly={readOnly}
                  value={translated(tab, node.id)}
                  onChange={(text) => state.setTranslation(tab, node.id, text)}
                />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function percent(locale: string, share: number): string {
  const rounded = Math.round(share * 100) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      rounded,
    );
  } catch {
    return new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }).format(
      rounded,
    );
  }
}

/** How long ago, in the person's language: "12 min ago", "yesterday". */
function ago(locale: string, iso: string, now: number): string | null {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  } catch {
    format = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
  }
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return formatDay(locale, iso);
}

/** "Draft saved · 12 min ago" (12/400 muted), or what the draft is doing now. A live region. */
function SaveNote({
  t,
  locale,
  state,
  served,
}: {
  t: Translator;
  locale: string;
  state: ScriptEditorState;
  served: Script;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setNow(Date.now()), [served.updatedAt]);
  const notice = state.notice;
  const when = ago(locale, served.updatedAt, now);
  let text: string;
  let tone = 'text-text-muted';
  if (state.busy === 'save') text = t.t('scripting.builder.saving');
  else if (state.busy === 'publish') text = t.t('scripting.builder.publishing');
  else if (state.dirty) text = t.t('scripting.builder.unsaved');
  else if (notice?.kind === 'published') {
    text = t.t('scripting.builder.published', { number: notice.number });
    tone = 'font-semibold text-success-text';
  } else
    text =
      when === null ? t.t('scripting.builder.saved') : t.t('scripting.builder.savedAgo', { when });
  return (
    <span role="status" className={`text-caption font-normal ${tone}`}>
      {text}
    </span>
  );
}

/** "Assigned to" (D-L194, `script_programme_assignment`): the script's one programme (D-L91), every control disabled. */
function Assigned({ t, programmeId }: { t: Translator; programmeId: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listMyProgrammes(controller.signal).then((result) => {
      if (!controller.signal.aborted && result.ok)
        setName(result.value.data.find((entry) => entry.id === programmeId)?.name ?? null);
    });
    return () => controller.abort();
  }, [programmeId]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-caption font-bold text-text-2">
        {t.t('scripting.builder.assigned')}
      </span>
      {name === null ? null : (
        <span className="inline-flex h-[30px] items-center gap-[5px] rounded-full bg-surface-sunken pe-1.5 ps-2.5 text-caption font-semibold">
          <Icon name="groups" size={15} className="text-text-2" />
          <span data-record-text="">{name}</span>
          <button
            type="button"
            disabled
            aria-label={t.t('scripting.builder.unassign')}
            title={t.t('scripting.builder.assign.soon')}
            className="flex size-[22px] items-center justify-center rounded-full text-disabled-text disabled:cursor-not-allowed"
          >
            <Icon name="close" size={15} />
          </button>
        </span>
      )}
      <button
        type="button"
        disabled
        title={t.t('scripting.builder.assign.soon')}
        className="inline-flex h-[30px] items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border-strong px-2.5 text-caption font-bold text-disabled-text disabled:cursor-not-allowed"
      >
        <Icon name="add" size={15} />
        {t.t('scripting.builder.assign')}
      </button>
    </div>
  );
}

function Notice({
  t,
  state,
  graph,
}: {
  t: Translator;
  state: ScriptEditorState;
  graph: ScriptGraph;
}) {
  const notice = state.notice;
  if (notice === null || notice.kind === 'saved' || notice.kind === 'published') return null;
  if (notice.kind === 'invalid') {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1.5 rounded-10 border border-danger bg-danger-soft px-3 py-2.5 text-meta"
      >
        <p className="flex items-center gap-2 font-bold text-danger-text">
          <Icon name="error" size={18} />
          {t.t('scripting.builder.refused')}
        </p>
        <ul className="flex list-disc flex-col gap-0.5 ps-9">
          {notice.problems.map((problem, index) => (
            <Problem
              key={index}
              t={t}
              problem={problem}
              title={nodeById(graph, problem.nodeId)?.title ?? null}
            />
          ))}
        </ul>
      </div>
    );
  }
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-10 border border-danger bg-danger-soft px-3 py-2.5 text-meta text-danger-text"
    >
      <Icon name="error" size={18} />
      {t.t(`scripting.error.${notice.error.code}` as MessageId)}
    </p>
  );
}

function Problem({
  t,
  problem,
  title,
}: {
  t: Translator;
  problem: PublishProblem;
  title: string | null;
}) {
  const reason = t.t(
    problem.reason === null
      ? 'scripting.builder.reason.other'
      : (`scripting.builder.reason.${problem.reason}` as MessageId),
  );
  return (
    <li>
      {title === null ? null : <b data-script-text="">{title}</b>} <span>{reason}</span>
    </li>
  );
}

/** The draft's compliance changes against the latest version (R8), under the palette. */
function DiffPanel({
  t,
  draft,
  latest,
}: {
  t: Translator;
  draft: ScriptGraph;
  latest: ScriptVersion;
}) {
  const diff = complianceDiff(draft, latest.graph);
  const heading = useId();
  const groups = [
    ['added', diff.added],
    ['changed', diff.changed],
    ['removed', diff.removed],
  ] as const;
  return (
    <section
      data-testid="compliance-diff"
      aria-labelledby={heading}
      className="mt-3 hidden flex-col gap-2 border-t border-border pt-3 md:flex"
    >
      <h2 id={heading} className="flex items-start gap-1.5 text-caption font-bold text-text-2">
        <Icon name="verified_user" size={16} className="shrink-0 text-warning-text" />
        {t.t('scripting.builder.diff.title', { number: latest.number })}
      </h2>
      {isEmptyDiff(diff) ? (
        <p className="text-caption font-normal text-text-muted">
          {t.t('scripting.builder.diff.none', { number: latest.number })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {groups.flatMap(([kind, nodes]) =>
            nodes.map((entry) => (
              <li
                key={`${kind}-${entry.id}`}
                data-compliance-diff={kind}
                className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption font-normal"
              >
                <span className="inline-flex h-5 items-center rounded-full bg-warning-soft px-1.5 text-micro text-warning-text">
                  {t.t(`scripting.builder.diff.${kind}` as MessageId)}
                </span>
                <span data-script-text="" className="min-w-0 break-words">
                  {entry.title}
                </span>
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  );
}

const INSPECTOR_LABEL = 'text-caption font-bold text-text-2';

function TranslationEditor({
  t,
  node,
  locale,
  sourceLocale,
  readOnly,
  value,
  onChange,
}: {
  t: Translator;
  node: ScriptNode;
  locale: ScriptLocale;
  sourceLocale: ScriptLocale;
  readOnly: boolean;
  value: string;
  onChange: (text: string) => void;
}) {
  const inputId = useId();
  const source = node.type === 'branch' ? null : (node.text ?? null);
  return (
    <>
      <div className="flex items-center gap-2">
        <TypePill t={t} type={node.type} />
        <span className="flex-1" />
        <code className="font-mono text-micro font-normal text-text-muted">{node.id}</code>
      </div>
      <p data-script-text="" className="text-label font-bold">
        {node.title}
      </p>
      {source === null || source === '' ? (
        <p className="text-body-sm text-text-2">{t.t('scripting.builder.translation.none')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className={INSPECTOR_LABEL}>
              {t.t('scripting.builder.field.line', { language: localeLabel(locale) })}
            </label>
            <textarea
              id={inputId}
              lang={locale}
              data-field-input="translation-text"
              rows={5}
              maxLength={4000}
              value={value}
              readOnly={readOnly}
              placeholder={t.t('scripting.builder.translation.placeholder', {
                language: localeLabel(locale),
              })}
              onChange={(event) => onChange(event.target.value)}
              className={`w-full min-w-0 resize-y rounded-md border bg-surface p-2.5 text-body-sm leading-[21px] text-text placeholder:text-text-muted is-focus:field-focus read-only:bg-surface-sunken ${
                value === '' ? 'border-warning' : 'border-border-strong'
              }`}
            />
          </div>
          <div className="flex flex-col gap-[3px] rounded-md bg-surface-sunken px-2.5 py-2">
            <span className="text-micro text-text-muted">
              {t.t('scripting.builder.translation.sourceIn', {
                language: localeLabel(sourceLocale),
              })}
            </span>
            <p
              data-script-text=""
              lang={sourceLocale}
              className="whitespace-pre-line text-caption font-normal leading-[18px] text-text-2"
            >
              {source}
            </p>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The version menu (the export's `history` button: "v13", a Draft or Live
 * chip, a chevron), opening a 320px menu of the draft and the published
 * versions, newest first and keyset paged. A published version opens
 * read-only. Disabled until something has been published.
 */
function VersionMenu({
  t,
  locale,
  script,
  viewing,
  next,
  onOpen,
}: {
  t: Translator;
  locale: string;
  script: Script;
  viewing: ScriptVersion | null;
  next: number;
  onOpen: (version: ScriptVersion | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const latest = script.latestVersion;
  const editingDraft = latest === null || script.hasUnpublishedChanges;
  const number = viewing?.number ?? (editingDraft ? next : latest.number);
  const chip: Chip =
    viewing !== null
      ? viewing.id === latest?.id
        ? 'live'
        : 'archived'
      : editingDraft
        ? 'draft'
        : 'live';

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (
        box.current !== null &&
        event.target instanceof Node &&
        !box.current.contains(event.target)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        data-action="versions"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t.t('scripting.builder.versions')}
        disabled={latest === null}
        onClick={() => setOpen((value) => !value)}
        className={`${HEADER_BUTTON} ${OUTLINE} pe-2.5 ps-3 font-semibold`}
      >
        <Icon name="history" size={18} />
        {t.t('scripting.builder.version.short', { number })}
        <VersionChip t={t} chip={chip} />
        <Icon name="expand_more" size={18} />
      </button>
      {open ? (
        <VersionsPanel
          t={t}
          locale={locale}
          script={script}
          viewing={viewing}
          draft={script.hasUnpublishedChanges ? next : null}
          onOpen={(version) => {
            onOpen(version);
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

type Chip = 'draft' | 'live' | 'archived';

function VersionChip({ t, chip }: { t: Translator; chip: Chip }) {
  const tone =
    chip === 'draft'
      ? 'bg-accent-soft text-accent-text'
      : chip === 'live'
        ? 'bg-success-soft text-success-text'
        : 'bg-surface-sunken text-text-2';
  return (
    <span className={`inline-flex h-[22px] items-center rounded-full px-[7px] text-micro ${tone}`}>
      {t.t(`scripting.builder.version.${chip}` as MessageId)}
    </span>
  );
}

function VersionsPanel({
  t,
  locale,
  script,
  viewing,
  draft,
  onOpen,
}: {
  t: Translator;
  locale: string;
  script: Script;
  viewing: ScriptVersion | null;
  draft: number | null;
  onOpen: (version: ScriptVersion | null) => void;
}) {
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
    // Read when the menu opens.
  }, []);

  const open = async (version: VersionSummary) => {
    setOpening(version.id);
    setFailed(false);
    const result = await getScriptVersion(script.id, version.id);
    setOpening(null);
    if (result.ok) onOpen(result.value);
    else setFailed(true);
  };

  const ROW =
    'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-start text-text is-hover:bg-surface-sunken is-focus-visible:ring-focus';

  return (
    <section
      aria-labelledby={heading}
      className="absolute end-0 top-[46px] z-20 flex max-h-[60vh] w-[320px] max-w-[calc(100vw-32px)] flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1.5 shadow-3"
    >
      <h2 id={heading} className="sr-only">
        {t.t('scripting.builder.versions.title')}
      </h2>
      {draft === null ? null : (
        <button
          type="button"
          aria-current={viewing === null ? 'true' : undefined}
          onClick={() => onOpen(null)}
          className={`${ROW} ${viewing === null ? 'bg-primary-soft' : ''}`}
        >
          <b className="w-8 shrink-0 font-mono text-meta">
            {t.t('scripting.builder.version.short', { number: draft })}
          </b>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-meta font-semibold">
              {t.t('scripting.builder.version.draft')}
            </span>
            <span className="text-caption font-normal text-text-muted">
              {t.t('scripting.builder.version.draftNote')}
            </span>
          </span>
          <VersionChip t={t} chip="draft" />
        </button>
      )}
      {phase === 'error' ? (
        <p role="alert" className="px-2.5 py-2 text-meta text-danger-text">
          {t.t('scripting.error.network')}
        </p>
      ) : null}
      {rows.map((row) => {
        const current = viewing?.id === row.id;
        return (
          <button
            key={row.id}
            type="button"
            data-version-row={row.id}
            aria-busy={opening === row.id}
            aria-current={current ? 'true' : undefined}
            onClick={() => void open(row)}
            className={`${ROW} ${current ? 'bg-primary-soft' : ''}`}
          >
            <b className="w-8 shrink-0 font-mono text-meta">
              {t.t('scripting.builder.version.short', { number: row.number })}
            </b>
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-meta font-semibold">
                {row.publishedBy === null ? (
                  <span className="text-text-muted">
                    {t.t('scripting.builder.versions.former')}
                  </span>
                ) : (
                  <span data-record-text="">{row.publishedBy.displayName}</span>
                )}
              </span>
              <span className="text-caption font-normal text-text-muted">
                <time dateTime={row.publishedAt}>{formatDay(locale, row.publishedAt)}</time>
              </span>
            </span>
            <VersionChip t={t} chip={row.id === script.latestVersion?.id ? 'live' : 'archived'} />
          </button>
        );
      })}
      {failed ? (
        <p role="alert" className="px-2.5 py-2 text-meta text-danger-text">
          {t.t('scripting.error.network')}
        </p>
      ) : null}
      {cursor === null ? null : (
        <button
          type="button"
          data-testid="version-list-more"
          disabled={phase === 'loading'}
          onClick={() => void read(cursor, rows)}
          className="h-control-md rounded-md px-2.5 text-start text-meta font-bold text-primary-text is-hover:bg-primary-soft is-focus-visible:ring-focus disabled:text-disabled-text"
        >
          {t.t('scripting.builder.versions.more')}
        </button>
      )}
    </section>
  );
}

/**
 * Publish, confirmed in the export's 380px popover under the button (a
 * bottom sheet on a phone): what happens to calls under way, what changed,
 * and which languages are part-translated.
 */
function PublishPopover({
  t,
  locale,
  next,
  busy,
  offline,
  partial,
  sourceLocale,
  onConfirm,
  onClose,
}: {
  t: Translator;
  locale: string;
  next: number;
  busy: boolean;
  offline: boolean;
  partial: readonly ScriptLocale[];
  sourceLocale: ScriptLocale;
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

  let languages: string;
  try {
    languages = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      partial.map((code) => localeLabel(code)),
    );
  } catch {
    languages = partial.map((code) => localeLabel(code)).join(', ');
  }

  return (
    <>
      <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-scrim md:hidden" />
      <section
        role="dialog"
        aria-labelledby={title}
        data-testid="publish-dialog"
        className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-3 rounded-t-xl bg-surface-raised p-4 shadow-3 md:absolute md:inset-x-auto md:bottom-auto md:end-0 md:top-[46px] md:z-20 md:w-[380px] md:rounded-lg md:border md:border-border"
      >
        <h2 id={title} className="text-card-title">
          {t.t('scripting.builder.publish.title', { number: next })}
        </h2>
        <p className="text-meta text-text-2">
          {t.t('scripting.builder.publish.body', { number: next })}
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={changeId} className={INSPECTOR_LABEL}>
            {t.t('scripting.builder.publish.change')}
          </label>
          <input
            ref={first}
            id={changeId}
            data-field-input="publish-change"
            value={change}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setChange(event.target.value)}
            className="h-control-md w-full min-w-0 rounded-md border border-border-strong bg-surface px-2.5 text-body-sm text-text is-focus:field-focus"
          />
        </div>
        {partial.length === 0 ? null : (
          <div
            role="note"
            className="flex gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-caption font-normal leading-[17px] text-text"
          >
            <Icon name="translate" size={18} className="shrink-0 text-warning-text" />
            <span>
              {t.t('scripting.builder.publish.partial', {
                languages,
                source: localeLabel(sourceLocale),
              })}
            </span>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${HEADER_BUTTON} ${OUTLINE} font-semibold`}
          >
            {t.t('scripting.builder.publish.cancel')}
          </button>
          <button
            type="button"
            data-action="confirm-publish"
            data-requires-connection=""
            disabled={busy || offline}
            aria-busy={busy}
            onClick={() => void onConfirm(change.trim() === '' ? [] : [change.trim()])}
            className={`${HEADER_BUTTON} ${PRIMARY}`}
          >
            {busy
              ? t.t('scripting.builder.publishing')
              : t.t('scripting.builder.publishNext', { number: next })}
          </button>
        </div>
      </section>
    </>
  );
}
