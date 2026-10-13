'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createBundleTranslator, localeLabel, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, LINK, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { StillConnecting } from '../admin/panel';
import { RecordNotFound, RecordOfflineBanner, RecordUnavailable } from '../record/record-states';
import { nodeById, type FormField, type ScriptLocale, type ScriptNode, type ScriptVersion } from '../../lib/script-graph';
import { listScriptRunDispositions, type RunContact, type ScriptRun } from '../../lib/script-runs-api';
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
  readForm,
  stepsOf,
  unreadTitles,
  wordingFor,
  type FillContext,
  type Step,
} from './run-model';
import { DispositionSheet, formatWhen, type Completion } from './disposition-sheet';
import { useScriptRun, type ScriptRunState } from './use-script-run';

/**
 * `P10/01` — one script run, start to completion, in MANUAL mode (T-0116),
 * with `P10/02` (a form), `P10/03` (completion) and the run states. Behind
 * the scripts flag, which only the server page reads.
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
 *
 * WHAT IT DOES NOT DRAW (D-L88): the call bar, its timer and controls, the
 * screen-pop, wrap-up and agent state (M09); AI (M17); the SMS reminder,
 * calling hours and team queues; the "writes to record" panel (D-P31); loan
 * data. Each waits for the module that owns it.
 * ---------------------------------------------------------------------------
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

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
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div
        data-screen="P10/01"
        data-run-state={state.phase === 'loading' ? 'loading' : 'ready'}
        data-run-status={state.run?.status}
        className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4"
      >
        {offline ? <RecordOfflineBanner t={t} locale={locale} syncedAt={state.syncedAt} /> : null}
        {state.phase === 'loading' ? <RunSkeleton t={t} slow={state.slow} /> : null}
        {state.phase === 'not-found' ? <RecordNotFound t={t} /> : null}
        {state.phase === 'unavailable' ? (
          <RecordUnavailable t={t} heading="scripting.run.unavailable" error={{ code: 'network' }} offline={offline} onRetry={state.reload} />
        ) : null}
        {state.phase === 'ready' && state.run !== null && state.version !== null ? (
          <RunView t={t} locale={locale} state={state} run={state.run} version={state.version} offline={offline} recordLink={recordLink} />
        ) : null}
      </div>
    </CrmShell>
  );
}

function RunSkeleton({ t, slow }: { t: Translator; slow: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      {slow ? <StillConnecting t={t} /> : null}
      <span role="status" className="sr-only">
        {t.t('scripting.run.loading')}
      </span>
      {[3, 2, 4].map((rows, index) => (
        <div key={index} data-testid="run-skeleton" aria-hidden="true" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <span className="h-5 w-1/3 rounded-sm bg-surface-sunken" />
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
  state,
  run,
  version,
  offline,
  recordLink,
}: {
  t: Translator;
  locale: string;
  state: ScriptRunState;
  run: ScriptRun;
  version: ScriptVersion;
  offline: boolean;
  recordLink: boolean;
}) {
  const [scriptLocale, setScriptLocale] = useState<ScriptLocale>(() => initialLocale(version, locale));
  const [sheet, setSheet] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const opener = useRef<HTMLButtonElement | null>(null);
  const graph = version.graph;
  const steps = stepsOf(run, graph);
  const offered = completionOffered(run, graph);
  const languages = localesOf(version);
  const context: FillContext = { contact: state.contact, agentName: state.me?.displayName ?? null, answers: run.answers, graph, locale };
  // A field-level refusal is drawn on its field; only the rest are a top alert.
  const fieldLevel =
    state.error !== null && Object.keys(fieldErrors(state.error.details)).length > 0 && ['validation_failed', 'answers_incomplete'].includes(state.error.code);
  const contactHref = recordLink && UUID.test(run.contactId) ? `/contacts/${run.contactId}` : null;

  // Field errors belong to the step they were raised on: a move clears them.
  useEffect(() => setErrors({}), [run.currentNodeId]);

  const closeSheet = () => {
    setSheet(false);
    opener.current?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={PANEL}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-semibold text-text-muted">{t.t('scripting.run.eyebrow')}</span>
          <h1 data-script-text="" className="break-words text-h3">
            {version.name}
          </h1>
          <p data-testid="run-contact" className="flex flex-wrap items-center gap-1 text-body-sm text-text-2">
            {t.t('scripting.run.with')}{' '}
            {state.contact === null ? (
              <span className="text-text-muted">{t.t('scripting.run.contactUnavailable')}</span>
            ) : contactHref !== null ? (
              <Link href={contactHref} className={LINK}>
                <span data-record-text="">{state.contact.displayName}</span>
              </Link>
            ) : (
              <b data-record-text="">{state.contact.displayName}</b>
            )}
          </p>
        </div>
        {run.versionId !== run.latestVersion.id ? (
          <p data-testid="version-banner" role="note" className="flex items-start gap-2 rounded-md bg-info-soft p-3 text-body-sm text-info-text">
            <Icon name="info" size="sm" />
            {t.t('scripting.run.banner', { run: run.versionNumber, latest: run.latestVersion.number })}
          </p>
        ) : null}
        {languages.length > 1 ? (
          <div role="group" aria-label={t.t('scripting.run.language')} data-testid="language-script" className="flex flex-wrap items-center gap-2">
            <Icon name="translate" size="sm" />
            {languages.map((code) => (
              <button
                key={code}
                type="button"
                lang={code}
                data-script-locale={code}
                aria-pressed={scriptLocale === code}
                onClick={() => setScriptLocale(code)}
                className={`min-h-touch rounded-full border px-3 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  scriptLocale === code ? 'border-primary bg-primary-soft text-primary-text' : 'border-border-strong bg-surface text-text'
                }`}
              >
                {localeLabel(code)}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {state.error !== null && !fieldLevel && !sheet ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(errorId(state.error))}
        </p>
      ) : null}

      <ol data-testid="run-steps" aria-label={t.t('scripting.run.steps')} className="flex min-w-0 flex-col gap-3">
        {steps.map((step) => (
          <StepCard
            key={step.key}
            t={t}
            locale={locale}
            step={step}
            run={run}
            version={version}
            scriptLocale={scriptLocale}
            context={context}
            state={state}
            offline={offline}
            errors={step.current ? errors : {}}
            onErrors={setErrors}
          />
        ))}
      </ol>

      {run.status === 'stopped' && run.stopReason !== null ? (
        <section data-testid="run-stopped" data-stop-reason={run.stopReason} role="status" className="flex items-start gap-3 rounded-lg border border-warning bg-warning-soft p-4 text-body-md text-warning-text">
          <Icon name="warning" size="sm" />
          <p>{t.t(`scripting.run.stopped.${run.stopReason}` as MessageId)}</p>
        </section>
      ) : null}

      {run.status === 'completed' ? (
        <RunComplete t={t} locale={locale} run={run} version={version} completion={completion} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {offered === 'completed' ? (
            <button
              ref={opener}
              type="button"
              data-action="complete-run"
              data-requires-connection=""
              aria-haspopup="dialog"
              disabled={offline || state.busy}
              onClick={() => setSheet(true)}
              className={`${PRIMARY_BUTTON} disabled:opacity-60`}
            >
              <Icon name="task_alt" size="sm" />
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
              className={`${SECONDARY_BUTTON} disabled:opacity-60`}
            >
              <Icon name="block" size="sm" />
              {t.t('scripting.run.endEarly')}
            </button>
          )}
        </div>
      )}

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

function Wording({ t, text, context }: { t: Translator; text: string; context: FillContext }) {
  return (
    <p data-script-text="" className="whitespace-pre-line break-words text-body-lg">
      {fill(text, context).map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span key={index} data-variable-placeholder="" className="rounded-sm bg-surface-sunken px-1 text-body-md text-text-muted">
            {t.t('scripting.run.placeholder')}
          </span>
        ),
      )}
    </p>
  );
}

function StepCard({
  t,
  locale,
  step,
  run,
  version,
  scriptLocale,
  context,
  state,
  offline,
  errors,
  onErrors,
}: {
  t: Translator;
  locale: string;
  step: Step;
  run: ScriptRun;
  version: ScriptVersion;
  scriptLocale: ScriptLocale;
  context: FillContext;
  state: ScriptRunState;
  offline: boolean;
  errors: Record<string, string>;
  onErrors: (errors: Record<string, string>) => void;
}) {
  const node = step.node;
  const wording = wordingFor(node, version, scriptLocale);
  const live = step.current && run.status === 'in_progress';
  const disabled = offline || state.busy;
  const titleId = useId();

  return (
    <li
      data-step={node.id}
      data-step-state={step.current ? 'current' : 'done'}
      data-node-type={node.type}
      aria-labelledby={titleId}
      aria-current={step.current ? 'step' : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border p-4 ${
        step.current ? 'border-primary bg-surface shadow-1' : 'border-border bg-surface-sunken'
      } ${node.type === 'compliance' ? 'border-s-4 border-s-warning' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-surface-sunken px-2 text-caption font-bold uppercase text-text-2">{t.t(`scripting.nodeType.${node.type}` as MessageId)}</span>
        <h2 id={titleId} data-script-text="" className="min-w-0 break-words text-body-md font-bold">
          {wording.title}
        </h2>
        <span className="text-caption text-text-muted">{t.t(step.current ? 'scripting.run.step.current' : 'scripting.run.step.done')}</span>
      </div>

      {wording.text !== null && wording.text !== '' ? <Wording t={t} text={wording.text} context={context} /> : null}
      {wording.fallback ? (
        <p data-testid="translation-fallback" className="text-caption text-text-muted">
          {t.t('scripting.run.fallback', { language: localeLabel(scriptLocale), source: localeLabel(version.sourceLocale) })}
        </p>
      ) : null}

      {node.type === 'question' && wording.hint !== null && wording.hint !== '' ? (
        <p className="flex items-start gap-2 rounded-md bg-info-soft p-2 text-body-sm text-info-text">
          <Icon name="lightbulb" size="sm" />
          <span>
            <span className="font-semibold">{t.t('scripting.run.hint')}</span> <span data-script-text="">{wording.hint}</span>
          </span>
        </p>
      ) : null}

      {node.type === 'question' ? <QuestionPart t={t} node={node} run={run} live={live} disabled={disabled} state={state} label={wording.choiceLabel} /> : null}

      {node.type === 'compliance' ? (
        <CompliancePart t={t} node={node} run={run} live={live} disabled={disabled} state={state} shown={wording.shown} />
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

      {node.type === 'say' && live ? (
        <AdvanceButton t={t} disabled={disabled} onClick={() => void state.advance()} />
      ) : null}
    </li>
  );
}

function AdvanceButton({ t, disabled, onClick }: { t: Translator; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-action="advance"
      data-requires-connection=""
      disabled={disabled}
      onClick={onClick}
      className={`${PRIMARY_BUTTON} self-start disabled:opacity-60`}
    >
      {t.t('scripting.run.next')}
      <Icon name="arrow_forward" size="sm" className="rtl:-scale-x-100" />
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
      <div role="group" aria-label={t.t('scripting.run.choices')} className="flex flex-col gap-2">
        {node.choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            data-choice={choice.key}
            data-requires-connection=""
            disabled={disabled}
            onClick={() => void state.advance(choice.key)}
            className={`${SECONDARY_BUTTON} justify-start text-start disabled:opacity-60`}
          >
            <span data-script-text="">{label(choice.key, choice.label)}</span>
          </button>
        ))}
      </div>
    );
  }
  const answer = run.answers[node.id];
  const chosen = answer?.type === 'question' ? node.choices.find((choice) => choice.key === answer.choiceKey) : undefined;
  if (chosen === undefined) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 text-body-sm text-text-2">
      <Icon name="check" size="sm" />
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
      <p className="flex items-center gap-1 text-body-sm font-semibold text-success-text">
        <Icon name="verified" size="sm" />
        {t.t('scripting.run.acknowledged')}
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-text-2">{t.t('scripting.run.compliance.note')}</p>
      <label htmlFor={box} className="flex min-h-touch items-center gap-3 rounded-md border border-border-strong px-3 text-body-md font-semibold">
        <input
          id={box}
          type="checkbox"
          data-action="acknowledge"
          data-requires-connection=""
          checked={acked}
          disabled={disabled || acked}
          onChange={() => void state.acknowledge(node.id, shown)}
          className="h-5 w-5 accent-primary"
        />
        {t.t('scripting.run.acknowledge')}
      </label>
      <AdvanceButton t={t} disabled={disabled || !acked} onClick={() => void state.advance()} />
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
  const [inputs, setInputs] = useState<Record<string, string>>(() => inputsFromAnswers(node.fields, saved));

  if (!live) {
    const values = saved?.type === 'form' ? saved.values : {};
    const filled = node.fields.filter((field) => values[field.key] !== undefined && values[field.key] !== null);
    if (filled.length === 0) return null;
    return (
      <dl className="grid gap-1 text-body-sm sm:grid-cols-2">
        {filled.map((field) => (
          <div key={field.key} className="flex min-w-0 flex-col">
            <dt data-script-text="" className="text-caption text-text-muted">
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
    const changed = Object.entries(reading.values).some(([key, value]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(value));
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

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void next();
      }}
    >
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
      <p className="text-caption text-text-muted">{t.t('scripting.run.form.note')}</p>
      <button
        type="submit"
        data-action="advance"
        data-requires-connection=""
        disabled={offline || state.busy}
        className={`${PRIMARY_BUTTON} self-start disabled:opacity-60`}
      >
        {t.t('scripting.run.next')}
        <Icon name="arrow_forward" size="sm" className="rtl:-scale-x-100" />
      </button>
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
  const wide = `${FIELD} w-full`;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${field.type === 'text' && (field.maxLength ?? 0) > 120 ? 'sm:col-span-2' : ''}`}>
      <label htmlFor={inputId} className="text-body-sm font-semibold">
        <span data-script-text="">{label}</span>
        {field.required ? null : <span className="font-normal text-text-muted"> {t.t('scripting.run.optional')}</span>}
        {field.type === 'money' && field.currency !== undefined ? (
          <span className="font-normal text-text-muted"> {t.t('scripting.run.amountIn', { currency: field.currency })}</span>
        ) : null}
      </label>
      {field.type === 'choice' ? (
        <select {...common} value={value} onChange={(event) => onChange(event.target.value)} className={wide}>
          <option value="">{t.t('scripting.run.choose')}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.key} value={option.key} data-script-text="">
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'text' && (field.maxLength ?? 0) > 120 ? (
        <textarea {...common} autoComplete="off" value={value} maxLength={field.maxLength} rows={3} onChange={(event) => onChange(event.target.value)} className={`${wide} py-2`} />
      ) : (
        <input
          {...common}
          type={field.type === 'date' ? 'date' : 'text'}
          inputMode={field.type === 'money' ? 'decimal' : field.type === 'number' ? 'numeric' : undefined}
          autoComplete="off"
          value={value}
          maxLength={field.type === 'text' ? field.maxLength : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={wide}
        />
      )}
      {error === null ? null : (
        <p id={errorId} data-field-error={field.key} className="flex items-center gap-1 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(`scripting.run.fieldError.${(FIELD_ERRORS as readonly string[]).includes(error) ? error : 'invalid_type'}` as MessageId)}
        </p>
      )}
    </div>
  );
}

/** P10/03, once completed: read-only. The outcome, the disposition, the callback and what was left unread (R10). */
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
    <section data-testid="run-complete" aria-labelledby={heading} role="status" className={`${PANEL} border-success`}>
      <h2 id={heading} className="flex items-center gap-2 text-h5">
        <Icon name="check_circle" size="sm" />
        {t.t('scripting.run.done.title')}
      </h2>
      <p className="text-body-md font-semibold">{t.t(`scripting.run.outcome.${outcome}` as MessageId)}</p>
      <dl className="flex flex-col gap-2 text-body-md">
        {run.dispositionId === null ? null : (
          <div className="flex flex-wrap gap-2">
            <dt className="text-text-muted">{t.t('scripting.run.done.disposition')}</dt>
            <dd>
              {label === null ? null : label === '' ? (
                <span className="text-text-muted">{t.t('scripting.run.done.unknownDisposition')}</span>
              ) : (
                <b data-record-text="">{label}</b>
              )}
            </dd>
          </div>
        )}
        {completion?.dueAt !== undefined ? (
          <div className="flex flex-wrap gap-2">
            <dt className="text-text-muted">{t.t('scripting.run.done.followUp')}</dt>
            <dd>
              <time dateTime={completion.dueAt}>{formatWhen(locale, completion.dueAt)}</time>
            </dd>
          </div>
        ) : run.followUpTaskId !== null ? (
          <div className="flex flex-wrap gap-2">
            <dt className="text-text-muted">{t.t('scripting.run.done.followUp')}</dt>
            <dd>{t.t('scripting.run.done.followUpBooked')}</dd>
          </div>
        ) : null}
      </dl>
      {unread.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-body-sm font-semibold text-warning-text">{t.t('scripting.run.done.unread')}</p>
          <ul className="flex flex-col gap-1">
            {unread.map((entry) => (
              <li key={entry.id} data-unacknowledged={entry.id} className="flex items-center gap-2 text-body-sm">
                <Icon name="warning" size="sm" />
                <span data-script-text="">{nodeById(version.graph, entry.id)?.title ?? entry.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export type { RunContact };
