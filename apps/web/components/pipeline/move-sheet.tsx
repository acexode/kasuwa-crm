'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';
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
  // P06/09's sheet: the current stage in its place, marked and not a choice, among the allowed targets.
  const rows = [...targets, ...(current === undefined ? [] : [current])].sort(
    (a, b) => (a.kind === 'lost' ? 1 : 0) - (b.kind === 'lost' ? 1 : 0) || a.position - b.position,
  );
  return (
    <PipelineDialog
      testId="move-sheet"
      size="sheet"
      title={t.t('pipeline.move.titleFor', { deal: deal.name })}
      subtitle={
        <span>
          {t.t('pipeline.move.from')} <span data-record-text="">{current?.name ?? ''}</span>
        </span>
      }
      closeLabel={t.t('pipeline.dialog.close')}
      onClose={onClose}
    >
      {targets.length === 0 ? (
        <p className="px-3 text-body-sm text-text-2">{t.t('pipeline.move.none')}</p>
      ) : (
        <div role="group" aria-label={t.t('pipeline.move.options')} className="flex flex-col">
          {rows.map((stage) => {
            const isCurrent = stage.id === deal.stageId;
            const count = stage.requirements.length;
            return (
              <button
                key={stage.id}
                type="button"
                {...(isCurrent ? { 'aria-current': 'true' as const } : { 'data-move-to': stage.id, 'data-requires-connection': '' })}
                disabled={isCurrent || !online}
                onClick={() => onChoose(stage.id)}
                className={`flex min-h-14 items-center gap-3 rounded-10 px-3 text-start text-label disabled:cursor-not-allowed ${
                  isCurrent ? 'bg-primary-soft font-bold text-primary-text' : 'font-medium text-text hover:bg-surface-sunken disabled:text-disabled-text'
                } ${FOCUS}`}
              >
                <Icon name={isCurrent ? 'radio_button_checked' : count > 0 ? 'lock' : stage.kind === 'lost' ? 'thumb_down' : 'arrow_forward'} size={20} />
                <span data-record-text="" className="min-w-0 flex-1 break-words">
                  {stage.name}
                </span>
                <span className="text-caption font-semibold text-text-muted">
                  {isCurrent ? t.t('pipeline.move.current') : count > 0 ? t.t('pipeline.move.toComplete', { count }) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </PipelineDialog>
  );
}
