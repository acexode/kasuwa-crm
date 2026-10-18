'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { MENU_ROW, POPOVER } from './list-classes';
import { CheckMark } from './list-parts';

/**
 * The column chooser every P04 list can open (T-0042, T-0057): hide and restore
 * a column. Its own module so a list can load it when it is opened and not
 * before: it is not on the first paint, and a closed popover costs bytes at
 * 256 kbps all the same.
 */

export interface ChooserColumn<K extends string> {
  readonly key: K;
  readonly label: MessageId;
  /** The name column: always shown, never offered for hiding. */
  readonly fixed?: true;
}

/** The column chooser: hide and restore, a lock on what the role cannot see, and why. */
export interface ChooserProps<K extends string> {
  readonly t: Translator;
  readonly columns: readonly ChooserColumn<K>[];
  readonly hidden: readonly K[];
  readonly locked: readonly K[];
  readonly onToggle: (key: K) => void;
}

export function ColumnChooser<K extends string>({ t, columns, hidden, locked, onToggle }: ChooserProps<K>) {
  const titleId = useId();
  return (
    <div
      data-testid="column-chooser-panel"
      role="group"
      aria-labelledby={titleId}
      className={`absolute end-0 top-full mt-1 w-72 ${POPOVER}`}
    >
      <p id={titleId} className="px-2 py-1 text-caption font-bold text-text-muted">
        {t.t('records.columns.title')}
      </p>
      {columns.map((column) => {
        const shown = !hidden.includes(column.key);
        const isLocked = locked.includes(column.key);
        return (
          <button
            key={column.key}
            type="button"
            data-column-option={column.key}
            data-locked={isLocked ? 'true' : undefined}
            aria-pressed={shown}
            disabled={column.fixed === true}
            onClick={() => onToggle(column.key)}
            className={`${MENU_ROW} text-text disabled:hover:bg-transparent`}
          >
            <CheckMark on={shown} />
            <span className="flex-1">{t.t(column.label)}</span>
            {column.fixed === true ? <span className="text-caption text-text-muted">{t.t('records.columns.always')}</span> : null}
            {isLocked ? (
              <>
                <Icon name="lock" size="sm" className="text-text-muted" />
                <span className="sr-only">{t.t('records.locked.header')}</span>
              </>
            ) : null}
          </button>
        );
      })}
      {locked.length > 0 ? (
        <p data-testid="locked-columns-note" className="mt-2 flex gap-2 border-t border-border px-2 pt-2 text-caption text-text-2">
          <Icon name="lock" size="sm" />
          {t.t('records.columns.lockedNote')}
        </p>
      ) : null}
    </div>
  );
}
