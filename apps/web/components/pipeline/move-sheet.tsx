'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { MENU_ROW } from '../records/list-classes';
import type { Deal, Pipeline } from '../../lib/pipelines-api';
import { allowedTargets, stageById } from './pipeline-model';
import { PipelineDialog } from './pipeline-dialog';

/**
 * The move sheet (P06/04's "Move stage", T-0109): the keyboard's and the
 * finger's way to do what a drag does (WCAG 2.2 SC 2.5.7), through the same
 * moveDeal. It offers EXACTLY the allow-list's targets from the deal's stage,
 * lost included and the current stage excluded (R9); lost is reached only
 * here. A stage with entry requirements says so, and choosing it opens the
 * requirement prompt.
 */
export function MoveSheet({
  t,
  pipeline,
  deal,
  online,
  onClose,
  onChoose,
}: {
  t: Translator;
  pipeline: Pipeline;
  deal: Deal;
  online: boolean;
  onClose: () => void;
  onChoose: (toStageId: string) => void;
}) {
  const targets = allowedTargets(pipeline, deal.stageId);
  const current = stageById(pipeline, deal.stageId);
  return (
    <PipelineDialog
      testId="move-sheet"
      title={t.t('pipeline.move.title')}
      subtitle={
        <>
          <span data-record-text="">{deal.name}</span>
          <span className="block">
            {t.t('pipeline.move.from')} <b data-record-text="">{current?.name ?? ''}</b>
          </span>
        </>
      }
      closeLabel={t.t('pipeline.dialog.close')}
      onClose={onClose}
    >
      {targets.length === 0 ? (
        <p className="text-body-sm text-text-2">{t.t('pipeline.move.none')}</p>
      ) : (
        <div role="group" aria-label={t.t('pipeline.move.options')} className="flex flex-col gap-1">
          {targets.map((stage) => (
            <button
              key={stage.id}
              type="button"
              data-move-to={stage.id}
              data-requires-connection=""
              disabled={!online}
              onClick={() => onChoose(stage.id)}
              className={`${MENU_ROW} text-text disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <Icon name="arrow_forward" size="sm" className="text-text-muted" />
              <span data-record-text="" className="flex-1">
                {stage.name}
              </span>
              {stage.requirements.length === 0 ? null : (
                <span className="inline-flex items-center gap-1 text-caption text-text-2">
                  <Icon name="task_alt" size="sm" />
                  {t.t('pipeline.move.gated')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </PipelineDialog>
  );
}
