'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { LINK, SECONDARY_BUTTON } from '../auth/button-classes';
import type { MergeView } from './merge-model';
import { PersonName, When } from './duplicates-parts';

/**
 * What a merge leaves behind: where the kept contact is, until when the merge
 * can be undone, and — after an undo — what the undo did.
 *
 * The kept contact is linked; the merged-away one is NEVER linked, because it
 * is the one 404 (D-P27) and the contract has no "merged into" pointer. Undo is
 * offered once and only while the server has not said otherwise: a 410 turns
 * it into "undo expired", and a 403, 404 or 409 takes the control away.
 */
export function MergeResult({ t, locale, view, onUndo }: { t: Translator; locale: string; view: MergeView; onUndo: () => void }) {
  const merge = view.merge;
  if (merge === null) return null;

  if (view.step === 'undone') {
    return (
      <section data-testid="merge-undone" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <h3 className="flex items-center gap-2 text-h4">
          <Icon name="check_circle" size="sm" />
          {t.t('duplicates.undone')}
        </h3>
        <p className="text-body-md text-text-2">{t.t('duplicates.undone.body')}</p>
        {merge.survivorReverted === false ? (
          <p data-testid="merge-kept-edits" className="text-body-sm text-text-2">
            {t.t('duplicates.keptEdits')}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section data-testid="merge-done" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="flex items-center gap-2 text-h4">
        <Icon name="check_circle" size="sm" />
        {t.t('duplicates.done.title')}
      </h3>
      <p className="text-body-md text-text-2">{t.t('duplicates.done.body')}</p>
      <p className="flex flex-wrap items-center gap-2 text-body-md">
        <span className="text-text-2">{t.t('duplicates.role.kept')}</span>
        <PersonName t={t} name={merge.survivor.displayName} />
      </p>
      <Link href={`/contacts/${encodeURIComponent(merge.survivor.id)}`} prefetch={false} data-testid="merge-survivor-link" className={LINK}>
        {t.t('duplicates.done.open')}
      </Link>
      {view.undoable && !view.expired ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm text-text-2">
            {t.t('duplicates.undoUntil')} <When locale={locale} iso={merge.undoUntil} />
          </span>
          <button type="button" data-testid="merge-undo" disabled={view.step === 'undoing'} onClick={onUndo} className={SECONDARY_BUTTON}>
            {t.t('duplicates.undo')}
          </button>
        </div>
      ) : (
        <p className="text-body-sm text-text-2">{view.expired ? t.t('duplicates.expired') : t.t('duplicates.undo.unavailable')}</p>
      )}
    </section>
  );
}
