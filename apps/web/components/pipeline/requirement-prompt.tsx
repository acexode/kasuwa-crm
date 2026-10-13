'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { MENU_ROW } from '../records/list-classes';
import { DEAL_CURRENCIES, searchRecords, type MoveDealBody, type Pipeline, type PickerRow } from '../../lib/pipelines-api';
import { amountInvalid, errorMessage, fieldLabel, promptBody, promptReady, stageById, type PromptInput, type RequirementView } from './pipeline-model';
import { PipelineDialog } from './pipeline-dialog';
import type { PromptState } from './pipeline-screen';

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
  return (
    <PipelineDialog
      testId="move-requirements"
      title={t.t('pipeline.prompt.title')}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-1">
          <span data-record-text="">{deal.name}</span>
          <span aria-hidden="true">·</span>
          <span data-record-text="">{from?.name ?? ''}</span>
          <Icon name="arrow_forward" size="sm" />
          <span data-record-text="">{to?.name ?? ''}</span>
        </span>
      }
      closeLabel={t.t('pipeline.dialog.close')}
      onClose={onClose}
    >
      <p className="text-body-sm text-text-2">{t.t('pipeline.prompt.intro')}</p>
      <ul className="flex flex-col gap-3">
        {views.map((view) => (
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
      {prompt.refusal === null ? null : (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          <span>{prompt.refusal}</span>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t.t('pipeline.cancel')}
        </button>
        <button
          type="button"
          data-action="confirm-move"
          data-requires-connection=""
          disabled={!online || !ready || prompt.sending}
          onClick={() => onConfirm(promptBody(deal.version, prompt.toStageId, views, input))}
          className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
        >
          {t.t('pipeline.prompt.confirm')}
        </button>
      </div>
    </PipelineDialog>
  );
}

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
  const label =
    requirement.kind === 'check' ? <span data-record-text="">{requirement.label}</span> : <span>{t.t(fieldLabel(requirement.field))}</span>;

  let body;
  if (view.met) {
    body = (
      <span className="inline-flex items-center gap-1 text-body-sm text-success-text">
        <Icon name="check_circle" size="sm" />
        {t.t('pipeline.prompt.met')}
      </span>
    );
  } else if (view.locked) {
    body = (
      <span className="inline-flex items-center gap-1 text-body-sm text-text-2">
        <Icon name="lock" size="sm" />
        {t.t('pipeline.prompt.locked')}
      </span>
    );
  } else if (requirement.kind === 'check') {
    body = null;
  } else if (requirement.field === 'primaryContactId' || requirement.field === 'accountId') {
    body = <Picker t={t} id={inputId} requirementId={requirement.id} kind={requirement.field} programmeId={programmeId} input={input} onInput={onInput} />;
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
          className={`${FIELD} min-w-0 flex-1`}
        />
        <select
          aria-label={t.t('pipeline.field.currency')}
          data-requirement-currency={requirement.id}
          value={input.currency[requirement.id] ?? ''}
          onChange={(event) => onInput({ ...input, currency: { ...input.currency, [requirement.id]: event.target.value } })}
          className={FIELD}
        >
          <option value="">{t.t('pipeline.create.currency.choose')}</option>
          {DEAL_CURRENCIES.map((code) => (
            <option key={code} value={code} data-record-text="">
              {code}
            </option>
          ))}
        </select>
        {invalid ? <p className="basis-full text-body-sm text-danger-text">{t.t('pipeline.create.error.amount')}</p> : null}
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
        className={FIELD}
      />
    );
  }

  return (
    <li
      data-requirement={requirement.id}
      data-met={String(view.met)}
      data-locked={view.locked ? 'true' : undefined}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      {requirement.kind === 'check' && !view.met ? (
        <label className="flex min-h-touch items-center gap-3 text-body-sm font-semibold">
          <input
            type="checkbox"
            data-requirement-input={requirement.id}
            checked={input.checks[requirement.id] === true}
            onChange={(event) => onInput({ ...input, checks: { ...input.checks, [requirement.id]: event.target.checked } })}
            className="h-5 w-5 shrink-0 accent-primary"
          />
          {label}
        </label>
      ) : (
        <label htmlFor={view.met || view.locked ? undefined : inputId} className="text-body-sm font-semibold">
          {label}
        </label>
      )}
      {body}
      {conflict ? (
        <p data-conflict="" className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-body-sm text-warning-text">
          <Icon name="info" size="sm" />
          {t.t('pipeline.prompt.conflict')}
        </p>
      ) : null}
    </li>
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
}: {
  t: Translator;
  id: string;
  requirementId: string;
  kind: 'primaryContactId' | 'accountId';
  programmeId: string;
  input: PromptInput;
  onInput: (input: PromptInput) => void;
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
          setFailed(t.t(errorMessage(result.error)));
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
        className={FIELD}
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
                  text: { ...input.text, [requirementId]: row.name },
                  picked: { ...input.picked, [requirementId]: { id: row.id, name: row.name } },
                })
              }
              className={`${MENU_ROW} text-text`}
            >
              <Icon name={kind === 'accountId' ? 'domain' : 'person'} size="sm" className="text-text-muted" />
              <span data-record-text="">{row.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
