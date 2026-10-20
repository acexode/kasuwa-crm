'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  createBundleTranslator,
  localeLabel,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import { Checkbox } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { StillConnecting } from '../admin/panel';
import { RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { formatClock } from '../record/record-core';
import { TypePill } from '../script-shared/node-style';
import {
  nodeById,
  type FormField,
  type ScriptLocale,
  type ScriptNode,
  type ScriptVersion,
} from '../../lib/script-graph';
import {
  listScriptRunDispositions,
  type RunContact,
  type ScriptRun,
} from '../../lib/script-runs-api';
import type { ScriptingError } from '../../lib/scripting-http';
import {
  FIELD_ERRORS,
  completionOffered,
  fieldErrors,
  fill,
  formatAnswer,
  initialLocale,
  inputsFromAnswers,
  isAcknowledged,
  localesOf,
  nameWithheld,
  readForm,
  stepsOf,
  unreadTitles,
  wordingFor,
  WITHHELD_NAME_MESSAGE_ID,
  type FillContext,
  type Step,
} from './run-model';
import { DispositionSheet, formatWhen, type Completion } from './disposition-sheet';
import { useScriptRun, type ScriptRunState } from './use-script-run';

/**
 * `P10/01` — one script run, start to completion, in MANUAL mode (T-0116),
 * with `P10/02` (a form), `P10/03` (completion) and the run states. Behind
 * the scripts flag, which only the server page reads. Drawn to the export's
 * "Agent · in-call" view (T-0139): the version banner, then the script on the
 * left and a rail of about 500px at 1440 on the right; finished steps fold to
 * numbered one-line rows, answers are a grid of radio cards, and the
 * language switch is a segmented control of short codes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 *
 *   - Draws the run as the server sends it: the steps are its `path`, the
 *     current one is `currentNodeId`, and every move is advanceScriptRun. It
 *     never evaluates a branch and never draws a node the run has not
 *     entered (R3). Nothing is optimistic.
 *   - Compliance is acknowledged on the server, in the language the screen
 *     showed (R5); the language switch uses the pinned version's
 *     translations and asks the server nothing.
 *   - Form answers go to the run and nowhere else (D-P31): no contact field is
 *     written, ever. They are never put on the device, in the address bar, the
 *     title or the console (D-L93).
 *   - "Completed" is offered only at an end node or on a stopped run; anywhere
 *     else the call ends as "interrupted" (R4, D-L93).
 *   - A finished step cannot be re-opened for editing: the run has no rewind.
 *     Its row's "Show" unfolds what was read and answered, read-only (D-L195).
 *
 * DRAWN AS PLACEHOLDERS (D-L194), each behind its flag and never with
 * invented data: the call bar, not connected, with the loan card and
 * "Writes to record" in their empty states (`call_bar`; D-L88, D-P31, M09);
 * the AI suggestion strip with "Use line" disabled (`ai_script_hints`, M17);
 * the banner's "What changed" (`script_version_changes`).
 * ---------------------------------------------------------------------------
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The export's 44px action button: radius 10, 0 16px, 14/700, an 18px glyph. */
const ACTION =
  'inline-flex h-control-base shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-10 px-4 text-body-sm font-bold is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text';
const PRIMARY = 'bg-primary text-on-primary is-hover:bg-primary-hover is-active:bg-primary-active';
const OUTLINE =
  'border border-border-strong bg-surface text-text is-hover:bg-surface-sunken disabled:border-border';
/** A card: radius 12, a 1px border, surface (the export's sections). */
const CARD = 'flex min-w-0 flex-col rounded-lg border border-border bg-surface';
const FIELD_LABEL = 'text-caption font-bold text-text-2';
const FIELD_CONTROL =
  'h-control-base w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-body-sm text-text placeholder:text-text-muted is-hover:border-text-2 is-focus:field-focus aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger';

export function ScriptRunScreen({
  id,
  locale,
  messages,
  locales,
  live,
  recordLink,
}: {
  id: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  /** The contact record (T-0062) is served in this process, so the run may link back to it. */
  recordLink: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const state = useScriptRun(id);
  const offline = !state.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="calls" live={live}>
      <div
        data-screen="P10/01"
        data-run-state={state.phase === 'loading' ? 'loading' : 'ready'}
        data-run-status={state.run?.status}
        className="flex w-full min-w-0 flex-col gap-4 md:-mt-1"
      >
        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}
        {state.phase === 'loading' ? <RunSkeleton t={t} slow={state.slow} /> : null}
        {state.phase === 'not-found' ? <RecordNotFound t={t} /> : null}
        {state.phase === 'unavailable' ? (
          <RecordUnavailable
            t={t}
            heading="scripting.run.unavailable"
            error={{ code: 'network' }}
            offline={offline}
            onRetry={state.reload}
          />
        ) : null}
        {state.phase === 'ready' && state.run !== null && state.version !== null ? (
          <RunView
            t={t}
            locale={locale}
            live={live}
            state={state}
            run={state.run}
            version={state.version}
            offline={offline}
            recordLink={recordLink}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

/** The run's own shape while it loads: the script header, then step rows. */
function RunSkeleton({ t, slow }: { t: Translator; slow: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      {slow ? <StillConnecting t={t} /> : null}
      <span role="status" className="sr-only">
        {t.t('scripting.run.loading')}
      </span>
      <div aria-hidden="true" className="flex flex-col gap-1.5">
        <span className="h-3 w-24 rounded-sm bg-surface-sunken" />
        <span className="h-5 w-1/2 rounded-sm bg-surface-sunken" />
      </div>
      {[0, 1, 4].map((rows, index) => (
        <div
          key={index}
          data-testid="run-skeleton"
          aria-hidden="true"
          className={`${CARD} gap-3 px-4 py-3.5`}
        >
          <span className="flex items-center gap-2">
            <span className="h-4 w-5 rounded-sm bg-surface-sunken" />
            <span className="h-6 w-20 rounded-6 bg-surface-sunken" />
            <span className="h-4 w-1/3 rounded-sm bg-surface-sunken" />
          </span>
          {Array.from({ length: rows }, (_, row) => (
            <span key={row} className="h-4 rounded-sm bg-surface-sunken" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A served error as copy. Field-level reasons are drawn on their fields, not here. */
function errorId(error: ScriptingError): MessageId {
  return `scripting.error.${error.code}` as MessageId;
}

function RunView({
  t,
  locale,
  live,
  state,
  run,
  version,
  offline,
  recordLink,
}: {
  t: Translator;
  locale: string;
  live: readonly string[];
  state: ScriptRunState;
  run: ScriptRun;
  version: ScriptVersion;
  offline: boolean;
  recordLink: boolean;
}) {
  const [scriptLocale, setScriptLocale] = useState<ScriptLocale>(() =>
    initialLocale(version, locale),
  );
  const [sheet, setSheet] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bannerHidden, setBannerHidden] = useState(false);
  const [aiHidden, setAiHidden] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const opener = useRef<HTMLButtonElement | null>(null);
  const graph = version.graph;
  const steps = stepsOf(run, graph);
  const offered = completionOffered(run, graph);
  const languages = localesOf(version);
  const context: FillContext = {
    contact: state.contact,
    agentName: state.me?.displayName ?? null,
    answers: run.answers,
    graph,
    locale,
  };
  // A field-level refusal is drawn on its field; only the rest are a top alert.
  const fieldLevel =
    state.error !== null &&
    Object.keys(fieldErrors(state.error.details)).length > 0 &&
    ['validation_failed', 'answers_incomplete'].includes(state.error.code);
  const contactHref = recordLink && UUID.test(run.contactId) ? `/contacts/${run.contactId}` : null;
  const callBar = live.includes('call_bar');
  const current = steps.find((step) => step.current);
  // At an end node the finish control sits in the end card, as the export puts it.
  const finishInCard =
    offered === 'completed' && run.status === 'in_progress' && current?.node.type === 'end';

  // Field errors belong to the step they were raised on: a move clears them.
  useEffect(() => setErrors({}), [run.currentNodeId]);
  useEffect(() => setAiHidden(false), [run.currentNodeId]);

  const closeSheet = () => {
    setSheet(false);
    opener.current?.focus();
  };

  const contact = <ContactLink t={t} contact={state.contact} href={contactHref} />;

  const finish =
    offered === 'completed' ? (
      <button
        ref={opener}
        type="button"
        data-action="complete-run"
        data-requires-connection=""
        aria-haspopup="dialog"
        disabled={offline || state.busy}
        onClick={() => setSheet(true)}
        className={`${ACTION} ${PRIMARY}`}
      >
        <Icon name="task_alt" size={18} />
        {t.t('scripting.run.complete')}
      </button>
    ) : (
      <button
        ref={opener}
        type="button"
        data-action="end-early"
        data-requires-connection=""
        aria-haspopup="dialog"
        disabled={offline || state.busy}
        onClick={() => setSheet(true)}
        className={`${ACTION} ${OUTLINE}`}
      >
        <Icon name="call_end" size={18} />
        {t.t('scripting.run.endEarly')}
      </button>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {run.versionId !== run.latestVersion.id && !bannerHidden ? (
        <VersionBanner
          t={t}
          locale={locale}
          run={run}
          changes={live.includes('script_version_changes')}
          onDismiss={() => setBannerHidden(true)}
        />
      ) : null}

      {callBar ? (
        <CallBar t={t} contact={state.contact}>
          {contact}
        </CallBar>
      ) : null}

      {state.error !== null && !fieldLevel && !sheet ? (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-10 border border-danger bg-danger-soft px-3 py-2.5 text-meta text-danger-text"
        >
          <Icon name="error" size={20} />
          {t.t(errorId(state.error))}
        </p>
      ) : null}

      <div
        className={
          callBar
            ? 'grid min-w-0 items-start gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]'
            : 'flex min-w-0 flex-col'
        }
      >
        <section aria-label={t.t('scripting.run.steps')} className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex min-w-[200px] flex-1 flex-col gap-px">
              <span className="text-overline text-text-muted">
                {t.t('scripting.run.eyebrowVersion', { number: run.versionNumber })}
              </span>
              <h1 data-script-text="" className="break-words text-h5 font-bold leading-6">
                {version.name}
              </h1>
              {callBar ? null : (
                <p
                  data-testid="run-contact"
                  className="flex flex-wrap items-center gap-1 text-meta text-text-2"
                >
                  {t.t('scripting.run.with')} {contact}
                </p>
              )}
            </div>
            {languages.length > 1 ? (
              <div
                role="group"
                aria-label={t.t('scripting.run.language')}
                data-testid="language-script"
                className="flex flex-wrap gap-0.5 rounded-[9px] bg-surface-sunken p-0.75"
              >
                {languages.map((code) => {
                  const active = scriptLocale === code;
                  return (
                    <button
                      key={code}
                      type="button"
                      lang={code}
                      data-script-locale={code}
                      aria-pressed={active}
                      aria-label={localeLabel(code)}
                      title={localeLabel(code)}
                      onClick={() => setScriptLocale(code)}
                      className={`h-[30px] rounded-6 px-[9px] text-caption font-semibold uppercase is-focus-visible:ring-focus ${
                        active ? 'bg-surface text-text shadow-1' : 'text-text-2 is-hover:text-text'
                      }`}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <ol
            data-testid="run-steps"
            aria-label={t.t('scripting.run.steps')}
            className="flex min-w-0 flex-col gap-3"
          >
            {steps.map((step, index) => (
              <StepCard
                key={step.key}
                t={t}
                locale={locale}
                number={index + 1}
                step={step}
                run={run}
                version={version}
                scriptLocale={scriptLocale}
                context={context}
                state={state}
                offline={offline}
                errors={step.current ? errors : {}}
                onErrors={setErrors}
                expanded={open.has(step.key)}
                onToggle={() =>
                  setOpen((was) => {
                    const next = new Set(was);
                    if (next.has(step.key)) next.delete(step.key);
                    else next.add(step.key);
                    return next;
                  })
                }
                ai={
                  step.current &&
                  live.includes('ai_script_hints') &&
                  !aiHidden &&
                  step.node.type !== 'end'
                    ? () => setAiHidden(true)
                    : null
                }
                finish={step.current && finishInCard ? finish : null}
              />
            ))}
          </ol>

          {run.status === 'stopped' && run.stopReason !== null ? (
            <section
              data-testid="run-stopped"
              data-stop-reason={run.stopReason}
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-body-sm text-text"
            >
              <Icon name="warning" size={20} className="text-warning-text" />
              <p>{t.t(`scripting.run.stopped.${run.stopReason}` as MessageId)}</p>
            </section>
          ) : null}

          {run.status === 'completed' ? (
            <RunComplete
              t={t}
              locale={locale}
              run={run}
              version={version}
              completion={completion}
            />
          ) : finishInCard ? null : (
            <div className="flex flex-wrap items-center justify-end gap-2.5">{finish}</div>
          )}
        </section>

        {callBar ? <Rail t={t} run={run} version={version} /> : null}
      </div>

      {sheet && offered !== null && run.status !== 'completed' ? (
        <DispositionSheet
          t={t}
          locale={locale}
          run={run}
          graph={graph}
          outcome={offered}
          offline={offline}
          reread={state.reread}
          onClose={closeSheet}
          onCompleted={(next, done) => {
            setCompletion(done);
            state.clearError();
            state.accept(next);
            setSheet(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Who the call is with: a link to the record where it is served, the name's stand-in where it is withheld. */
function ContactLink({
  t,
  contact,
  href,
}: {
  t: Translator;
  contact: RunContact | null;
  href: string | null;
}) {
  if (contact === null)
    return <span className="text-text-muted">{t.t('scripting.run.contactUnavailable')}</span>;
  return href !== null ? (
    <Link
      href={href}
      className="rounded-sm font-semibold text-primary-text is-hover:underline is-focus-visible:ring-focus"
    >
      <ContactName t={t} contact={contact} />
    </Link>
  ) : (
    <b>
      <ContactName t={t} contact={contact} />
    </b>
  );
}

/**
 * The time a version was published, with the zone named: "13:55 WAT". The
 * zone is the one people at the desk say (`zoneName`), never ICU English's
 * "GMT+1" (T-0143).
 */
function clock(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return formatClock(locale, at);
}

/** The export's version banner: info-soft, a 1px info edge, radius 12; a title, a body, "What changed" and a dismiss. */
function VersionBanner({
  t,
  locale,
  run,
  changes,
  onDismiss,
}: {
  t: Translator;
  locale: string;
  run: ScriptRun;
  changes: boolean;
  onDismiss: () => void;
}) {
  const latest = run.latestVersion;
  const time = clock(locale, latest.publishedAt);
  const tail = { run: run.versionNumber, latest: latest.number, time };
  return (
    <div
      data-testid="version-banner"
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-info bg-info-soft px-3.5 py-3"
    >
      <Icon name="published_with_changes" size={22} className="text-info-text" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-body-sm font-bold text-info-text">
          {t.t('scripting.run.banner.title', { latest: latest.number })}
        </b>
        <span className="text-meta text-text-2">
          {latest.publishedBy === null
            ? t.t('scripting.run.banner.bodyFormer', tail)
            : t.t('scripting.run.banner.body', { ...tail, name: latest.publishedBy.displayName })}
        </span>
      </div>
      {changes ? (
        <button
          type="button"
          disabled
          title={t.t('scripting.run.banner.changesSoon')}
          className="h-[34px] shrink-0 whitespace-nowrap rounded-6 border border-border bg-surface px-3 text-meta font-bold text-disabled-text disabled:cursor-not-allowed max-md:hidden"
        >
          {t.t('scripting.run.banner.changes')}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t.t('scripting.run.banner.dismiss')}
        className="flex size-[34px] shrink-0 items-center justify-center rounded-6 text-info-text is-hover:bg-surface is-focus-visible:ring-focus"
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

/** Two initials from a served name, or nothing (then a person glyph): never a guess. */
function initialsOf(contact: RunContact | null): string | null {
  if (contact === null || nameWithheld(contact) || typeof contact.displayName !== 'string')
    return null;
  const parts = contact.displayName
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  const letters =
    parts.length === 0
      ? ''
      : `${parts[0]?.[0] ?? ''}${parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''}`;
  return letters === '' ? null : letters.toUpperCase();
}

/**
 * The call bar (D-L194, `call_bar`): the export's bar in its not-connected
 * state. The call runs in manual mode, so there is no number, timer,
 * recording or control to offer until telephony (M09) is wired: mute, hold
 * and End call are drawn disabled.
 */
function CallBar({
  t,
  contact,
  children,
}: {
  t: Translator;
  contact: RunContact | null;
  children: ReactNode;
}) {
  const initials = initialsOf(contact);
  const ICON_BUTTON =
    'flex size-control-base items-center justify-center rounded-10 border border-border bg-surface text-disabled-text disabled:cursor-not-allowed';
  return (
    <section
      aria-label={t.t('scripting.run.call.label')}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface py-2.5 pe-3 ps-3.5 shadow-1"
    >
      <span
        aria-hidden="true"
        className="flex size-control-base shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-body-sm font-bold text-primary-text"
      >
        {initials ?? <Icon name="person" size={22} />}
      </span>
      <div className="flex min-w-0 flex-col gap-px">
        <span data-testid="run-contact" className="truncate text-card-title">
          {children}
        </span>
        <span className="text-caption font-normal text-text-2">
          {t.t('scripting.run.call.manual')}
        </span>
      </div>
      <span className="inline-flex h-[30px] items-center gap-[5px] rounded-full bg-surface-sunken px-2.5 text-caption font-bold text-text-2">
        <Icon name="call" size={16} />
        {t.t('scripting.run.call.notConnected')}
      </span>
      <span className="flex-1" />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled
          aria-label={t.t('scripting.run.call.mute')}
          title={t.t('scripting.run.call.soon')}
          className={ICON_BUTTON}
        >
          <Icon name="mic" size={20} />
        </button>
        <button
          type="button"
          disabled
          aria-label={t.t('scripting.run.call.hold')}
          title={t.t('scripting.run.call.soon')}
          className={ICON_BUTTON}
        >
          <Icon name="pause" size={20} />
        </button>
        <button
          type="button"
          disabled
          title={t.t('scripting.run.call.soon')}
          className={`${ACTION} bg-disabled-bg text-disabled-text`}
        >
          <Icon name="call_end" size={20} />
          {t.t('scripting.run.call.end')}
        </button>
      </div>
    </section>
  );
}

/**
 * The rail (D-L194, `call_bar`): the export's loan card and "Writes to
 * record", in their empty states. No loan module exists (no `loan.*`), and
 * form answers write nothing to the record (D-P31); only the compliance count
 * is the run's own.
 */
function Rail({ t, run, version }: { t: Translator; run: ScriptRun; version: ScriptVersion }) {
  const compliance = version.graph.nodes
    .filter((node) => node.type === 'compliance')
    .map((node) => node.id);
  const read = compliance.filter((id) => isAcknowledged(run, id)).length;
  const rows: MessageId[] = [
    'scripting.run.loan.balance',
    'scripting.run.loan.due',
    'scripting.run.loan.promise',
    'scripting.run.loan.prefers',
  ];
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <section aria-label={t.t('scripting.run.loan.title')} className={`${CARD} gap-2.5 p-4`}>
        <div className="flex items-center gap-2">
          <b className="flex-1 text-label font-bold">{t.t('scripting.run.loan.title')}</b>
          <span className="inline-flex h-6 items-center rounded-full bg-surface-sunken px-2 text-micro text-text-2">
            {t.t('scripting.run.loan.none')}
          </span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-meta">
          {rows.map((row) => (
            <div key={row} className="contents">
              <dt className="text-text-muted">{t.t(row)}</dt>
              <dd className="text-text-muted">—</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label={t.t('scripting.run.writes.title')} className={`${CARD} gap-2 p-4`}>
        <div className="flex items-center gap-1.5">
          <Icon name="sync_alt" size={18} className="text-text-2" />
          <b className="flex-1 text-label font-bold">{t.t('scripting.run.writes.title')}</b>
          {compliance.length === 0 ? null : (
            <span className="text-caption font-normal text-text-muted">
              {t.t('scripting.run.writes.progress', { read, total: compliance.length })}
            </span>
          )}
        </div>
        <div className="flex min-h-10 items-center gap-2.5 border-t border-border pt-2">
          <Icon name="radio_button_unchecked" size={18} className="text-border-strong" />
          <span className="text-meta text-text-muted">{t.t('scripting.run.writes.empty')}</span>
        </div>
      </section>
    </aside>
  );
}

/** The run's contact by name, or the stand-in when its name is withheld (D-L68, D-L180). */
function ContactName({ t, contact }: { t: Translator; contact: RunContact }) {
  return nameWithheld(contact) ? (
    <span data-variable-placeholder="" data-withheld-name="">
      {t.t(WITHHELD_NAME_MESSAGE_ID)}
    </span>
  ) : (
    <span data-record-text="">{contact.displayName}</span>
  );
}

function Wording({ t, text, context }: { t: Translator; text: string; context: FillContext }) {
  return (
    <p
      data-script-text=""
      className="whitespace-pre-line break-words text-[17px] leading-[27px] text-text"
    >
      {fill(text, context).map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : segment.kind === 'withheldName' ? (
          // D-L180 (T-0124 I13): the name is withheld, so a neutral stand-in.
          <span
            key={index}
            data-variable-placeholder=""
            data-withheld-name=""
            className="rounded-sm bg-surface-sunken px-[5px] py-px font-semibold text-text-muted"
          >
            {t.t(WITHHELD_NAME_MESSAGE_ID)}
          </span>
        ) : (
          <span
            key={index}
            data-variable-placeholder=""
            className="rounded-sm bg-surface-sunken px-[5px] py-px font-semibold text-text-muted"
          >
            {t.t('scripting.run.placeholder')}
          </span>
        ),
      )}
    </p>
  );
}

/** What a finished step's row says it came to: "Read", "Acknowledged", the answer chosen, the form's values. */
function summaryOf(
  t: Translator,
  step: Step,
  run: ScriptRun,
  locale: string,
  label: (key: string, label: string) => string,
): string | null {
  const node = step.node;
  if (node.type === 'say') return t.t('scripting.run.summary.read');
  if (node.type === 'compliance')
    return isAcknowledged(run, node.id) ? t.t('scripting.run.summary.acknowledged') : null;
  if (node.type === 'question') {
    const answer = run.answers[node.id];
    const chosen =
      answer?.type === 'question'
        ? node.choices.find((choice) => choice.key === answer.choiceKey)
        : undefined;
    return chosen === undefined ? null : label(chosen.key, chosen.label);
  }
  if (node.type === 'form') {
    const saved = run.answers[node.id];
    const values = saved?.type === 'form' ? saved.values : {};
    const shown = node.fields
      .map((field) =>
        values[field.key] === undefined || values[field.key] === null
          ? null
          : formatAnswer(field, values[field.key] ?? null, locale),
      )
      .filter((value): value is string => value !== null && value !== '');
    return shown.length === 0 ? null : shown.slice(0, 2).join(' · ');
  }
  return null;
}

function StepCard({
  t,
  locale,
  number,
  step,
  run,
  version,
  scriptLocale,
  context,
  state,
  offline,
  errors,
  onErrors,
  expanded,
  onToggle,
  ai,
  finish,
}: {
  t: Translator;
  locale: string;
  number: number;
  step: Step;
  run: ScriptRun;
  version: ScriptVersion;
  scriptLocale: ScriptLocale;
  context: FillContext;
  state: ScriptRunState;
  offline: boolean;
  errors: Record<string, string>;
  onErrors: (errors: Record<string, string>) => void;
  expanded: boolean;
  onToggle: () => void;
  /** The AI strip's dismiss, where `ai_script_hints` draws it on this step; null where it is not drawn. */
  ai: (() => void) | null;
  /** The finish control, when this is the end card. */
  finish: ReactNode;
}) {
  const node = step.node;
  const wording = wordingFor(node, version, scriptLocale);
  const live = step.current && run.status === 'in_progress';
  const disabled = offline || state.busy;
  const titleId = useId();
  const bodyId = useId();
  const done = !step.current;
  const summary = done ? summaryOf(t, step, run, locale, wording.choiceLabel) : null;
  const showBody = step.current || expanded;

  return (
    <li
      data-step={node.id}
      data-step-state={step.current ? 'current' : 'done'}
      data-node-type={node.type}
      aria-labelledby={titleId}
      aria-current={step.current ? 'step' : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-lg bg-surface px-4 py-3.5 ${step.current ? 'border-2 border-primary shadow-2' : 'border border-border'}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span aria-hidden="true" className="w-5 font-mono text-caption font-normal text-text-muted">
          {String(number).padStart(2, '0')}
        </span>
        <TypePill t={t} type={node.type} />
        <h2 id={titleId} data-script-text="" className="min-w-0 break-words text-label font-bold">
          {wording.title}
        </h2>
        {node.type === 'compliance' ? (
          <span className="inline-flex items-center gap-[3px] text-micro text-warning-text">
            <Icon name="lock" size={14} />
            {t.t('scripting.run.mandatory')}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="sr-only">
          {t.t(step.current ? 'scripting.run.step.current' : 'scripting.run.step.done')}
        </span>
        {done ? (
          <span className="inline-flex items-center gap-2">
            {summary === null ? null : (
              <span className="inline-flex min-w-0 items-center gap-1 text-caption font-semibold text-success-text">
                <Icon name="check_circle" size={16} />
                <span
                  data-script-text={
                    node.type === 'question' || node.type === 'form' ? '' : undefined
                  }
                  className="truncate"
                >
                  {summary}
                </span>
              </span>
            )}
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={onToggle}
              className="h-7 rounded-6 px-2 text-caption font-bold text-primary-text is-hover:bg-primary-soft is-focus-visible:ring-focus"
            >
              {t.t(expanded ? 'scripting.run.step.hide' : 'scripting.run.step.show')}
            </button>
          </span>
        ) : null}
      </div>

      {showBody ? (
        <div id={bodyId} className="flex min-w-0 flex-col gap-3">
          {wording.fallback ? (
            <span
              data-testid="translation-fallback"
              className="inline-flex h-6 items-center gap-1 self-start rounded-6 bg-surface-sunken px-2 text-micro font-semibold text-text-2"
            >
              <Icon name="translate" size={14} />
              {t.t('scripting.run.fallback', {
                language: localeLabel(scriptLocale),
                source: localeLabel(version.sourceLocale),
              })}
            </span>
          ) : null}
          {wording.text !== null && wording.text !== '' ? (
            <Wording t={t} text={wording.text} context={context} />
          ) : null}

          {node.type === 'question' && wording.hint !== null && wording.hint !== '' ? (
            <p className="flex items-center gap-2.5 self-start rounded-full border border-primary-soft-strong bg-primary-soft px-3 py-2 text-meta text-text">
              <Icon name="lightbulb" size={18} className="shrink-0 text-primary-text" />
              <span>
                <span className="font-semibold text-primary-text">{t.t('scripting.run.hint')}</span>{' '}
                <span data-script-text="">{wording.hint}</span>
              </span>
            </p>
          ) : null}

          {node.type === 'question' ? (
            <QuestionPart
              t={t}
              node={node}
              run={run}
              live={live}
              disabled={disabled}
              state={state}
              label={wording.choiceLabel}
            />
          ) : null}

          {node.type === 'compliance' ? (
            <CompliancePart
              t={t}
              node={node}
              run={run}
              live={live}
              disabled={disabled}
              state={state}
              shown={wording.shown}
            />
          ) : null}

          {node.type === 'form' ? (
            <FormPart
              t={t}
              locale={locale}
              node={node}
              run={run}
              live={live}
              offline={offline}
              state={state}
              errors={errors}
              onErrors={onErrors}
              label={wording.fieldLabel}
            />
          ) : null}

          {ai === null ? null : <AiStrip t={t} onDismiss={ai} />}

          {node.type === 'say' && live ? (
            <div className="flex items-center justify-end gap-2.5">
              <AdvanceButton t={t} disabled={disabled} onClick={() => void state.advance()} />
            </div>
          ) : null}

          {node.type === 'end' && finish !== null ? (
            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border pt-2.5">
              <span className="flex-1 text-meta text-text-2">{t.t('scripting.run.endHint')}</span>
              {finish}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The export's AI suggestion strip (D-L194, `ai_script_hints`), in its empty state: nothing to suggest, "Use line" disabled. */
function AiStrip({ t, onDismiss }: { t: Translator; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-primary-soft-strong bg-primary-soft py-2 pe-2 ps-3 max-md:rounded-xl">
      <Icon name="auto_awesome" size={18} className="shrink-0 text-primary-text" />
      <span className="min-w-0 flex-1 text-meta text-text-2">{t.t('scripting.run.ai.empty')}</span>
      <span className="flex gap-1">
        <button
          type="button"
          disabled
          title={t.t('scripting.run.ai.soon')}
          className="h-8 whitespace-nowrap rounded-full bg-disabled-bg px-3 text-caption font-bold text-disabled-text disabled:cursor-not-allowed"
        >
          {t.t('scripting.run.ai.use')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t.t('scripting.run.ai.dismiss')}
          className="flex size-8 items-center justify-center rounded-full text-text-2 is-hover:bg-primary-soft-strong is-focus-visible:ring-focus"
        >
          <Icon name="close" size={18} />
        </button>
      </span>
    </div>
  );
}

function AdvanceButton({
  t,
  disabled,
  onClick,
  label,
}: {
  t: Translator;
  disabled: boolean;
  onClick?: () => void;
  label?: MessageId;
}) {
  return (
    <button
      type={onClick === undefined ? 'submit' : 'button'}
      data-action="advance"
      data-requires-connection=""
      disabled={disabled}
      onClick={onClick}
      className={`${ACTION} ${PRIMARY}`}
    >
      {t.t(label ?? 'scripting.run.next')}
      <Icon name="arrow_downward" size={18} />
    </button>
  );
}

function QuestionPart({
  t,
  node,
  run,
  live,
  disabled,
  state,
  label,
}: {
  t: Translator;
  node: Extract<ScriptNode, { type: 'question' }>;
  run: ScriptRun;
  live: boolean;
  disabled: boolean;
  state: ScriptRunState;
  label: (key: string, label: string) => string;
}) {
  if (live) {
    return (
      <div
        role="group"
        aria-label={t.t('scripting.run.choices')}
        className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2"
      >
        {node.choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            data-choice={choice.key}
            data-requires-connection=""
            disabled={disabled}
            onClick={() => void state.advance(choice.key)}
            className="flex min-h-12 items-center gap-2 rounded-10 border border-border-strong bg-surface px-3 py-2 text-start text-body-sm font-semibold text-text is-hover:border-primary is-hover:bg-primary-soft is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled-bg disabled:text-disabled-text"
          >
            <Icon name="radio_button_unchecked" size={18} className="shrink-0 text-text-muted" />
            <span data-script-text="">{label(choice.key, choice.label)}</span>
          </button>
        ))}
      </div>
    );
  }
  const answer = run.answers[node.id];
  const chosen =
    answer?.type === 'question'
      ? node.choices.find((choice) => choice.key === answer.choiceKey)
      : undefined;
  if (chosen === undefined) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-meta text-text-2">
      <Icon name="radio_button_checked" size={18} className="text-primary" />
      {t.t('scripting.run.answered')} <b data-script-text="">{label(chosen.key, chosen.label)}</b>
    </p>
  );
}

function CompliancePart({
  t,
  node,
  run,
  live,
  disabled,
  state,
  shown,
}: {
  t: Translator;
  node: ScriptNode;
  run: ScriptRun;
  live: boolean;
  disabled: boolean;
  state: ScriptRunState;
  shown: ScriptLocale;
}) {
  const acked = isAcknowledged(run, node.id);
  const box = useId();
  if (!live) {
    return acked ? (
      <p className="flex items-center gap-1.5 text-meta font-semibold text-success-text">
        <Icon name="verified" size={18} />
        {t.t('scripting.run.acknowledged')}
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-3">
      {/*
        The tick is the @kasuwa/ui Checkbox (T-0143), not a native box, so it
        follows the theme. It stays disabled once the server has the
        acknowledgement (it cannot be taken back); that state is drawn as a
        success tick on the success row, not the greyed disabled box.
      */}
      <div
        className={`flex min-h-12 items-center gap-2.5 rounded-10 border px-3 py-0.5 ${acked ? 'border-success bg-success-soft' : 'border-warning bg-warning-soft'}`}
      >
        <Checkbox
          id={box}
          data-action="acknowledge"
          data-requires-connection=""
          checked={acked}
          disabled={disabled || acked}
          onChange={() => void state.acknowledge(node.id, shown)}
          label={<span className="flex-1 font-semibold">{t.t('scripting.run.acknowledge')}</span>}
          className={`flex-1 gap-2.5 ${
            acked
              ? '!cursor-default !text-text [&_.k-icon]:!text-on-primary [&_input]:!border-success [&_input]:!bg-success'
              : ''
          }`}
        />
        <span className="text-caption font-normal text-text-muted max-md:hidden">
          {t.t('scripting.run.logged')}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        {acked ? null : (
          <span className="text-caption font-normal text-text-muted">
            {t.t('scripting.run.tickFirst')}
          </span>
        )}
        <AdvanceButton t={t} disabled={disabled || !acked} onClick={() => void state.advance()} />
      </div>
    </div>
  );
}

function FormPart({
  t,
  locale,
  node,
  run,
  live,
  offline,
  state,
  errors,
  onErrors,
  label,
}: {
  t: Translator;
  locale: string;
  node: Extract<ScriptNode, { type: 'form' }>;
  run: ScriptRun;
  live: boolean;
  offline: boolean;
  state: ScriptRunState;
  errors: Record<string, string>;
  onErrors: (errors: Record<string, string>) => void;
  label: (key: string, label: string) => string;
}) {
  const saved = run.answers[node.id];
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    inputsFromAnswers(node.fields, saved),
  );

  if (!live) {
    const values = saved?.type === 'form' ? saved.values : {};
    const filled = node.fields.filter(
      (field) => values[field.key] !== undefined && values[field.key] !== null,
    );
    if (filled.length === 0) return null;
    return (
      <dl className="grid gap-x-3 gap-y-2 text-meta sm:grid-cols-2">
        {filled.map((field) => (
          <div key={field.key} className="flex min-w-0 flex-col">
            <dt data-script-text="" className="text-caption font-normal text-text-muted">
              {label(field.key, field.label)}
            </dt>
            <dd data-script-text="" className="break-words">
              {formatAnswer(field, values[field.key] ?? null, locale)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const next = async () => {
    const reading = readForm(node.fields, inputs, saved);
    if (Object.keys(reading.errors).length > 0) {
      onErrors(reading.errors);
      return;
    }
    onErrors({});
    const before = saved?.type === 'form' ? saved.values : {};
    const changed = Object.entries(reading.values).some(
      ([key, value]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(value),
    );
    if (changed) {
      const recorded = await state.answer(node.id, reading.values);
      if (!recorded.ok) {
        onErrors(fieldErrors(recorded.error.details));
        return;
      }
    }
    const moved = await state.advance();
    if (!moved.ok) onErrors(fieldErrors(moved.error.details));
  };

  const count = Object.keys(errors).length;

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void next();
      }}
    >
      {count === 0 ? null : (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-10 border border-danger bg-danger-soft px-3 py-2.5 text-meta"
        >
          <Icon name="error" size={20} className="text-danger-text" />
          <b className="text-danger-text">{t.t('scripting.run.form.errors')}</b>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {node.fields.map((field) => (
          <FieldInput
            key={field.key}
            t={t}
            field={field}
            label={label(field.key, field.label)}
            value={inputs[field.key] ?? ''}
            error={errors[field.key] ?? null}
            onChange={(value) => setInputs((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        <span className="flex-1 text-caption font-normal text-text-muted">
          {t.t('scripting.run.form.note')}
        </span>
        <AdvanceButton t={t} disabled={offline || state.busy} />
      </div>
    </form>
  );
}

function FieldInput({
  t,
  field,
  label,
  value,
  error,
  onChange,
}: {
  t: Translator;
  field: FormField;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const common = {
    id: inputId,
    'data-field-input': field.key,
    'aria-invalid': error === null ? undefined : true,
    'aria-describedby': error === null ? undefined : errorId,
    'aria-required': field.required ? true : undefined,
  } as const;
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${field.type === 'text' && (field.maxLength ?? 0) > 120 ? 'sm:col-span-2' : ''}`}
    >
      <label htmlFor={inputId} className={FIELD_LABEL}>
        <span data-script-text="">{label}</span>
        {field.required ? (
          <span className="text-danger-text"> *</span>
        ) : (
          <span className="font-normal text-text-muted"> {t.t('scripting.run.optional')}</span>
        )}
        {field.type === 'money' && field.currency !== undefined ? (
          <span className="font-normal text-text-muted">
            {' '}
            {t.t('scripting.run.amountIn', { currency: field.currency })}
          </span>
        ) : null}
      </label>
      {field.type === 'choice' ? (
        <select
          {...common}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD_CONTROL} pe-2.5`}
        >
          <option value="">{t.t('scripting.run.choose')}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.key} value={option.key} data-script-text="">
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'text' && (field.maxLength ?? 0) > 120 ? (
        <textarea
          {...common}
          autoComplete="off"
          value={value}
          maxLength={field.maxLength}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD_CONTROL} h-auto py-2.5 leading-[21px]`}
        />
      ) : (
        <input
          {...common}
          type={field.type === 'date' ? 'date' : 'text'}
          inputMode={
            field.type === 'money' ? 'decimal' : field.type === 'number' ? 'numeric' : undefined
          }
          autoComplete="off"
          value={value}
          maxLength={field.type === 'text' ? field.maxLength : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD_CONTROL} ${field.type === 'money' || field.type === 'number' ? 'tabular-nums' : ''}`}
        />
      )}
      {error === null ? null : (
        <p
          id={errorId}
          data-field-error={field.key}
          className="flex items-center gap-1 text-caption font-normal text-danger-text"
        >
          <Icon name="error" size={14} />
          {t.t(
            `scripting.run.fieldError.${(FIELD_ERRORS as readonly string[]).includes(error) ? error : 'invalid_type'}` as MessageId,
          )}
        </p>
      )}
    </div>
  );
}

/** P10/03, once completed: read-only, drawn as the export's "Saved" card. The outcome, the disposition, the callback and what was left unread (R10). */
function RunComplete({
  t,
  locale,
  run,
  version,
  completion,
}: {
  t: Translator;
  locale: string;
  run: ScriptRun;
  version: ScriptVersion;
  completion: Completion | null;
}) {
  const [label, setLabel] = useState<string | null>(completion?.label ?? null);
  const unread = unreadTitles(run, version.graph);
  const heading = useId();

  useEffect(() => {
    if (label !== null || run.dispositionId === null) return;
    const controller = new AbortController();
    void (async () => {
      // The disposition's label, by paging the run's list until it is found.
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await listScriptRunDispositions(run.id, cursor, controller.signal);
        if (!result.ok || controller.signal.aborted) return;
        const found = result.value.data.find((row) => row.id === run.dispositionId);
        if (found !== undefined) {
          setLabel(found.label);
          return;
        }
        cursor = result.value.nextCursor;
        if (cursor === null) break;
      }
      setLabel('');
    })();
    return () => controller.abort();
  }, [label, run.id, run.dispositionId]);

  const outcome = run.outcome ?? 'completed';
  return (
    <section
      data-testid="run-complete"
      aria-labelledby={heading}
      role="status"
      className={`${CARD} items-center gap-2.5 px-6 py-12 text-center`}
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-success-soft text-success-text">
        <Icon name="task_alt" size={32} />
      </span>
      <h2 id={heading} className="text-h4 font-bold leading-[26px]">
        {t.t('scripting.run.done.title')}
      </h2>
      <p className="max-w-[460px] text-body-relaxed text-text-2">
        {t.t(`scripting.run.outcome.${outcome}` as MessageId)}
      </p>
      <dl className="flex flex-col items-center gap-1 text-body-sm">
        {run.dispositionId === null ? null : (
          <div className="flex flex-wrap justify-center gap-1.5">
            <dt className="text-text-muted">{t.t('scripting.run.done.disposition')}</dt>
            <dd>
              {label === null ? null : label === '' ? (
                <span className="text-text-muted">
                  {t.t('scripting.run.done.unknownDisposition')}
                </span>
              ) : (
                <b data-record-text="">{label}</b>
              )}
            </dd>
          </div>
        )}
        {completion?.dueAt !== undefined ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            <dt className="text-text-muted">{t.t('scripting.run.done.followUp')}</dt>
            <dd>
              <time dateTime={completion.dueAt}>{formatWhen(locale, completion.dueAt)}</time>
            </dd>
          </div>
        ) : run.followUpTaskId !== null ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            <dt className="text-text-muted">{t.t('scripting.run.done.followUp')}</dt>
            <dd>{t.t('scripting.run.done.followUpBooked')}</dd>
          </div>
        ) : null}
      </dl>
      {unread.length > 0 ? (
        <div className="mt-1 flex flex-col items-center gap-1 rounded-10 bg-warning-soft px-4 py-2.5">
          <p className="text-meta font-semibold text-warning-text">
            {t.t('scripting.run.done.unread')}
          </p>
          <ul className="flex flex-col gap-1">
            {unread.map((entry) => (
              <li
                key={entry.id}
                data-unacknowledged={entry.id}
                className="flex items-center gap-1.5 text-meta"
              >
                <Icon name="warning" size={16} className="text-warning-text" />
                <span data-script-text="">
                  {nodeById(version.graph, entry.id)?.title ?? entry.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export type { RunContact };
