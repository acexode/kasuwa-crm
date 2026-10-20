'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { listMyProgrammes } from '../../lib/accounts-api';
import { listPipelines, type PipelineSummary } from '../../lib/pipelines-api';
import { pipelineHref } from './pipeline-model';

/**
 * The P06 header's pipeline dropdown ("B2B sales · Lagos", T-0135): the
 * design folds the choice of pipeline into the board's header.
 *
 * TWO PIPELINES OF ONE NAME ARE TOLD APART BY PROGRAMME. A BPO runs the same
 * pipeline for several clients, so "B2B sales" twice is normal; the label then
 * carries the programme's name ("B2B sales · Sahel Lagos"), read from the
 * caller's own programmes (listMyProgrammes, which the session scopes). A name
 * no other pipeline shares is drawn alone. Nothing here is a scope: the API
 * decides which pipelines come back.
 */

export interface PipelineChoice {
  readonly id: string;
  readonly name: string;
  /** The programme's name, only where the pipeline's name alone is ambiguous. */
  readonly qualifier: string | null;
}

/** The labels, with a programme qualifier only where two pipelines share a name. */
export function pipelineChoices(
  pipelines: readonly PipelineSummary[],
  programmes: ReadonlyMap<string, string>,
): PipelineChoice[] {
  const seen = new Map<string, number>();
  for (const pipeline of pipelines) seen.set(pipeline.name, (seen.get(pipeline.name) ?? 0) + 1);
  return pipelines.map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    qualifier:
      (seen.get(pipeline.name) ?? 0) > 1 && pipeline.programmeId !== undefined
        ? (programmes.get(pipeline.programmeId) ?? null)
        : null,
  }));
}

export function choiceLabel(t: Translator, choice: PipelineChoice): string {
  return choice.qualifier === null
    ? choice.name
    : t.t('pipeline.select.qualified', { name: choice.name, programme: choice.qualifier });
}

export type ChoicesState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | {
      readonly phase: 'ready';
      readonly choices: readonly PipelineChoice[];
      readonly more: boolean;
    };

/** The caller's pipelines (the first page) and their programmes' names, read once. */
export function usePipelineChoices(retry = 0): ChoicesState {
  const [state, setState] = useState<ChoicesState>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    void Promise.all([listPipelines(), listMyProgrammes()]).then(([pipelines, programmes]) => {
      if (!live) return;
      if (!pipelines.ok) {
        setState({ phase: 'error' });
        return;
      }
      // Without the programmes' names a duplicate is still drawn, just unqualified.
      const names = new Map(
        programmes.ok
          ? programmes.value.map((programme) => [programme.id, programme.name] as const)
          : [],
      );
      setState({
        phase: 'ready',
        choices: pipelineChoices(pipelines.value.data, names),
        more: pipelines.value.nextCursor !== null,
      });
    });
    return () => {
      live = false;
    };
  }, [retry]);
  return state;
}

/**
 * The dropdown: a native select (the phone's own picker), 44px, 15/700, as
 * P06/01 draws it. Choosing a pipeline opens its board.
 */
export function PipelineSelect({
  t,
  state,
  currentId,
  currentName,
  placeholder,
  className = '',
}: {
  t: Translator;
  state: ChoicesState;
  /** The pipeline on screen, or `null` on the index. */
  currentId: string | null;
  /** Its name, drawn while the list loads. */
  currentName?: string;
  /** The empty choice on the index ("Choose a pipeline"). */
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const choices = state.phase === 'ready' ? state.choices : [];
  const known = currentId !== null && choices.some((choice) => choice.id === currentId);
  return (
    <label className={`relative flex min-w-0 ${className}`}>
      <span className="sr-only">{t.t('pipeline.select.label')}</span>
      <select
        data-testid="pipeline-select"
        value={currentId ?? ''}
        onChange={(event) => {
          const href = pipelineHref(event.target.value);
          if (href !== null) router.push(href);
        }}
        className="h-control-base w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-border-strong bg-surface pe-10 ps-3 text-label font-bold text-text is-hover:border-text-2 is-focus:field-focus"
      >
        {currentId === null ? (
          <option value="">{placeholder ?? t.t('pipeline.select.label')}</option>
        ) : null}
        {currentId !== null && !known ? (
          <option value={currentId} data-record-text="">
            {currentName ?? ''}
          </option>
        ) : null}
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} data-record-text="">
            {choiceLabel(t, choice)}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute inset-y-0 end-2.5 flex items-center text-text">
        <Icon name="expand_more" size={22} />
      </span>
    </label>
  );
}
