'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { MENU_ROW } from '../records/list-classes';
import { nameOrWithheld } from '../records/name';
import { DEAL_CURRENCIES, searchRecords, type MoveDealBody, type Pipeline, type PickerRow } from '../../lib/pipelines-api';
import {
  amountInvalid,
  errorMessage,
  fieldLabel,
  isFilled,
  promptBody,
  promptReady,
  stageById,
  type PromptInput,
  type PromptState,
  type RequirementView,
} from './pipeline-model';
import { PipelineDialog } from './pipeline-dialog';

/**
 * The requirement prompt (P06/02, "Complete to move", T-0109, D-P20, R9).
 *
 * EVERY REQUIREMENT OF THE TARGET STAGE IS LISTED. One the deal already meets
 * is shown met and not asked again; a field withheld from the caller is a lock
 * and is never filled (the server answers `403 field_not_editable`, said here
 * by label). A check's label is printed word for word; a field's label is
 * translated. What the person fills goes in the SAME moveDeal as the move:
 * only what they filled, never a value the deal already holds.
 *
 * AFTER A `409 stale_write` the prompt stays open on the fresh deal, with what
 * was typed kept and a "changed by someone else" note where somebody else
 * changed the same field meanwhile (D-L102, R11). The person confirms again;
 * nothing is resent by itself.
 *
 * A contact or account requirement is a search (`listContacts` or
 * `listAccounts` with `q`) offering only records of the deal's programme.
 */

const SEARCH_DEBOUNCE_MS = 300;

export function RequirementPrompt({
  t,
  pipeline,
  prompt,
  online,
  onInput,
  onClose,
  onConfirm,
}: {
  t: Translator;
  pipeline: Pipeline;
  prompt: PromptState;
  online: boolean;
  onInput: (input: PromptInput) => void;
  onClose: () => void;
  onConfirm: (body: MoveDealBody) => void;
}) {
  const { deal, views, input } = prompt;
  const from = stageById(pipeline, deal.stageId);
  const to = stageById(pipeline, prompt.toStageId);
  const ready = promptReady(views, input);
  const done = views.filter((view) => view.met || isFilled(view, input)).length;
  const left = views.length - done;
  const fields = views.filter((view) => view.requirement.kind === 'field');
  const checks = views.filter((view) => view.requirement.kind === 'check');
  const percent = views.length === 0 ? 100 : Math.round((done / views.length) * 100);
  return (
    <PipelineDialog
      testId="move-requirements"
      size="prompt"
      title={t.t('pipeline.prompt.titleTo', { stage: to?.name ?? '' })}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-x-1">
          <span data-record-text="">{deal.name}</span>
          <span aria-hidden="true">·</span>
          <span data-record-text="">{from?.name ?? ''}</span>
          <Icon name="arrow_forward" size={15} className="rtl:-scale-x-100" />
          <span data-record-text="">{to?.name ?? ''}</span>
        </span>
      }
      closeLabel={t.t('pipeline.dialog.close')}
      busy={prompt.sending}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-[1_1_160px] text-caption font-normal text-text-muted">{t.t('pipeline.prompt.left', { count: left })}</span>
          <button type="button" disabled={prompt.sending} onClick={onClose} className={`${SECONDARY_BUTTON} h-control-lg px-4 disabled:cursor-not-allowed disabled:opacity-60`}>
            {t.t('pipeline.cancel')}
          </button>
          <button
            type="button"
            data-action="confirm-move"
            data-requires-connection=""
            disabled={!online || !ready || prompt.sending}
            onClick={() => onConfirm(promptBody(deal.version, prompt.toStageId, views, input))}
            className="inline-flex h-control-lg items-center justify-center rounded-md bg-primary px-4.5 text-label font-bold text-on-primary is-hover:bg-primary-hover is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text"
          >
            {t.t('pipeline.prompt.confirm')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="flex flex-wrap justify-between gap-x-3 text-meta">
          <b>{t.t('pipeline.prompt.progress', { done, total: views.length })}</b>
          <span className="text-text-2">
            <span data-record-text="">{t.t('pipeline.prompt.rules', { pipeline: pipeline.name, stage: to?.name ?? '' })}</span>
          </span>
        </span>
        <span role="progressbar" aria-valuemin={0} aria-valuemax={views.length} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-sm bg-surface-sunken">
          <span className="block h-full bg-success transition-[width] duration-quick" style={{ width: `${percent}%` }} />
        </span>
      </div>
      {fields.length === 0 ? null : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2.5 text-caption font-bold uppercase tracking-[0.06em] text-text-muted">{t.t('pipeline.prompt.fields')}</legend>
          <ul className="flex flex-col gap-3">
            {fields.map((view) => (
              <Requirement
                key={view.requirement.id}
                t={t}
                view={view}
                input={input}
                programmeId={deal.programmeId}
                conflict={prompt.conflicts.includes(view.requirement.id)}
                onInput={onInput}
              />
            ))}
          </ul>
        </fieldset>
      )}
      {checks.length === 0 ? null : (
        <fieldset className="flex flex-col gap-0.5">
          <legend className="mb-2 text-caption font-bold uppercase tracking-[0.06em] text-text-muted">{t.t('pipeline.prompt.checklist')}</legend>
          <ul className="flex flex-col gap-0.5">
            {checks.map((view) => (
              <Requirement
                key={view.requirement.id}
                t={t}
                view={view}
                input={input}
                programmeId={deal.programmeId}
                conflict={prompt.conflicts.includes(view.requirement.id)}
                onInput={onInput}
              />
            ))}
          </ul>
        </fieldset>
      )}
      {prompt.refusal === null ? null : (
        <p role="alert" className="flex items-start gap-2 rounded-10 border-2 border-danger bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text">
          <Icon name="block" size={20} />
          <span>{prompt.refusal}</span>
        </p>
      )}
    </PipelineDialog>
  );
}

const INPUT = 'h-control-lg w-full min-w-0 rounded-md border bg-surface px-3 text-label text-text placeholder:text-text-muted is-focus:field-focus';

function Requirement({
  t,
  view,
  input,
  programmeId,
  conflict,
  onInput,
}: {
  t: Translator;
  view: RequirementView;
  input: PromptInput;
  programmeId: string;
  conflict: boolean;
  onInput: (input: PromptInput) => void;
}) {
  const { requirement } = view;
  const inputId = useId();
  const filled = view.met || isFilled(view, input);
  const edge = filled ? 'border-border-strong' : 'border-accent';
  const label =
    requirement.kind === 'check' ? <span data-record-text="">{requirement.label}</span> : <span>{t.t(fieldLabel(requirement.field))}</span>;

  if (requirement.kind === 'check') {
    const on = view.met || input.checks[requirement.id] === true;
    return (
      <li data-requirement={requirement.id} data-met={String(view.met)} data-locked={view.locked ? 'true' : undefined} className="flex flex-col gap-1">
        <label className={`flex min-h-control-lg items-center gap-3 text-body-sm ${view.met ? '' : 'cursor-pointer'}`}>
          <span className="relative flex shrink-0">
            <input
              type="checkbox"
              data-requirement-input={view.met ? undefined : requirement.id}
              checked={on}
              disabled={view.met || view.locked}
              onChange={(event) => onInput({ ...input, checks: { ...input.checks, [requirement.id]: event.target.checked } })}
              className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-default"
            />
            <span
              aria-hidden="true"
              className={`flex size-[22px] items-center justify-center rounded-sm text-on-primary peer-focus-visible:ring-focus ${
                on ? (view.met ? 'bg-success' : 'bg-primary') : 'border-2 border-border-strong bg-surface'
              }`}
            >
              {on ? <Icon name="check" size={18} /> : null}
            </span>
          </span>
          <span className="min-w-0 flex-1">{label}</span>
          {view.met ? <span className="rounded-full bg-success-soft px-2 py-0.5 text-micro text-success-text">{t.t('pipeline.prompt.met')}</span> : null}
          {view.locked ? <Icon name="lock" size={18} className="text-text-2" /> : null}
        </label>
        {conflict ? <Conflict t={t} /> : null}
      </li>
    );
  }

  let body;
  if (view.met) {
    body = null;
  } else if (view.locked) {
    body = (
      <span className="inline-flex items-center gap-1 text-body-sm text-text-2">
        <Icon name="lock" size={18} />
        {t.t('pipeline.prompt.locked')}
      </span>
    );
  } else if (requirement.field === 'primaryContactId' || requirement.field === 'accountId') {
    body = <Picker t={t} id={inputId} requirementId={requirement.id} kind={requirement.field} programmeId={programmeId} input={input} onInput={onInput} edge={edge} />;
  } else if (requirement.field === 'amount') {
    const invalid = amountInvalid(view, input);
    body = (
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          data-requirement-input={requirement.id}
          aria-invalid={invalid}
          value={input.text[requirement.id] ?? ''}
          onChange={(event) => onInput({ ...input, text: { ...input.text, [requirement.id]: event.target.value } })}
          className={`${INPUT} flex-1 font-mono ${invalid ? 'border-2 border-danger' : edge}`}
        />
        <span className="relative flex">
          <select
            aria-label={t.t('pipeline.field.currency')}
            data-requirement-currency={requirement.id}
            value={input.currency[requirement.id] ?? ''}
            onChange={(event) => onInput({ ...input, currency: { ...input.currency, [requirement.id]: event.target.value } })}
            className={`${INPUT} w-auto cursor-pointer appearance-none pe-10 border-border-strong`}
          >
            <option value="">{t.t('pipeline.create.currency.choose')}</option>
            {DEAL_CURRENCIES.map((code) => (
              <option key={code} value={code} data-record-text="">
                {code}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 end-2.5 flex items-center">
            <Icon name="expand_more" size={22} />
          </span>
        </span>
        {invalid ? <p className="basis-full text-caption font-normal text-danger-text">{t.t('pipeline.create.error.amount')}</p> : null}
      </div>
    );
  } else {
    body = (
      <input
        id={inputId}
        type={requirement.field === 'expectedCloseDate' ? 'date' : 'text'}
        maxLength={200}
        autoComplete="off"
        data-requirement-input={requirement.id}
        value={input.text[requirement.id] ?? ''}
        onChange={(event) => onInput({ ...input, text: { ...input.text, [requirement.id]: event.target.value } })}
        className={`${INPUT} ${edge}`}
      />
    );
  }

  return (
    <li data-requirement={requirement.id} data-met={String(view.met)} data-locked={view.locked ? 'true' : undefined} className="flex flex-col gap-1.5">
      <label htmlFor={view.met || view.locked ? undefined : inputId} className="flex items-center gap-1.5 text-body-sm font-semibold">
        {label}
        <span aria-hidden="true" className="text-danger-text">
          *
        </span>
        {filled ? (
          <span className="inline-flex text-success-text">
            <Icon name="check_circle" size={16} />
            <span className="sr-only">{t.t('pipeline.prompt.met')}</span>
          </span>
        ) : null}
      </label>
      {body}
      {conflict ? <Conflict t={t} /> : null}
    </li>
  );
}

function Conflict({ t }: { t: Translator }) {
  return (
    <p data-conflict="" className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-body-sm text-warning-text">
      <Icon name="info" size={18} />
      {t.t('pipeline.prompt.conflict')}
    </p>
  );
}

/** A search of the deal's own programme's contacts or accounts; a pick by name, never an id on screen. */
function Picker({
  t,
  id,
  requirementId,
  kind,
  programmeId,
  input,
  onInput,
  edge,
}: {
  t: Translator;
  id: string;
  requirementId: string;
  kind: 'primaryContactId' | 'accountId';
  programmeId: string;
  input: PromptInput;
  onInput: (input: PromptInput) => void;
  edge: string;
}) {
  const [rows, setRows] = useState<readonly PickerRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const sequence = useRef(0);
  const picked = input.picked[requirementId];
  const typed = input.text[requirementId] ?? '';

  useEffect(() => {
    const q = typed.trim();
    if (q === '' || picked !== undefined) {
      setRows(null);
      return undefined;
    }
    sequence.current += 1;
    const mine = sequence.current;
    const timer = window.setTimeout(() => {
      void searchRecords(kind, q, programmeId).then((result) => {
        if (mine !== sequence.current) return;
        if (result.ok) {
          setRows(result.value);
          setFailed(null);
        } else {
          setRows(null);
          setFailed(t.t(errorMessage(result.error, 'read')));
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, picked, kind, programmeId, t]);

  const unpicked = Object.fromEntries(Object.entries(input.picked).filter(([key]) => key !== requirementId));
  return (
    <div className="flex flex-col gap-1">
      <input
        id={id}
        type="search"
        autoComplete="off"
        maxLength={100}
        data-requirement-input={requirementId}
        placeholder={t.t('pipeline.prompt.search')}
        value={typed}
        onChange={(event) => onInput({ ...input, text: { ...input.text, [requirementId]: event.target.value }, picked: unpicked })}
        onKeyDown={(event) => {
          // Escape empties the search first; only an empty search lets it close the prompt.
          if (event.key !== 'Escape' || typed === '') return;
          event.preventDefault();
          onInput({ ...input, text: { ...input.text, [requirementId]: '' }, picked: unpicked });
        }}
        className={`${INPUT} ${edge}`}
      />
      {failed === null ? null : <p className="text-body-sm text-danger-text">{failed}</p>}
      {rows === null ? null : rows.length === 0 ? (
        <p className="text-body-sm text-text-2">{t.t('pipeline.prompt.noMatches')}</p>
      ) : (
        <div role="group" aria-label={t.t('pipeline.prompt.results')} className="flex flex-col">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              data-picker-option={row.id}
              onClick={() =>
                onInput({
                  ...input,
                  text: { ...input.text, [requirementId]: nameOrWithheld(t, row.name) },
                  picked: { ...input.picked, [requirementId]: { id: row.id, name: nameOrWithheld(t, row.name) } },
                })
              }
              className={`${MENU_ROW} text-text`}
            >
              <Icon name={kind === 'accountId' ? 'domain' : 'person'} size="sm" className="text-text-muted" />
              <span data-record-text="">{nameOrWithheld(t, row.name)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
