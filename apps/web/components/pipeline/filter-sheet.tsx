'use client';

import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { PipelineDialog } from './pipeline-dialog';

/**
 * The phone's Filters sheet (P06/09's "Filters" button, T-0135): every board
 * filter as a labelled control, in place of the stacked form that used to sit
 * above the cards. Filters apply as they change; Done closes, Clear empties.
 * Loaded when first opened.
 */
export function FilterSheet({
  t,
  active,
  onClear,
  onClose,
  children,
}: {
  t: Translator;
  active: boolean;
  onClear: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <PipelineDialog
      testId="filter-sheet"
      title={t.t('pipeline.filter.more')}
      closeLabel={t.t('pipeline.dialog.close')}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          {active ? (
            <Button variant="ghost" onClick={onClear}>
              {t.t('records.filter.clearAll')}
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            {t.t('pipeline.filter.done')}
          </Button>
        </>
      }
    >
      {children}
    </PipelineDialog>
  );
}
