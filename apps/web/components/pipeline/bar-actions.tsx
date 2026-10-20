'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SHELL_FOCUS } from '../shell/shell-parts';
import { SHELL_SEARCH_STRINGS } from '../search/message-ids';

/** A 48px app-bar button, as the shell draws its own (P06/09: `width:48px;height:48px`, a 24px glyph). */
const BAR_BUTTON = `flex size-control-lg shrink-0 items-center justify-center rounded-md text-text is-hover:bg-surface-sunken disabled:text-disabled-text ${SHELL_FOCUS}`;

/**
 * The P06 phone app bar's actions (P06/09, P06/14): search, where it is live
 * in this process, and the ⊕ for a new deal. Given to the shell's `appBar`.
 */
export function DealsBarActions({
  t,
  live,
  onNew,
  newDisabled = false,
}: {
  t: Translator;
  live: readonly string[];
  /** Left out, there is no ⊕ (the deal detail opens no create form). */
  onNew?: () => void;
  newDisabled?: boolean;
}) {
  return (
    <>
      {live.includes('search') ? (
        <Link href="/search" prefetch={false} aria-label={t.t(SHELL_SEARCH_STRINGS.entry)} className={BAR_BUTTON}>
          <Icon name="search" size={24} />
        </Link>
      ) : null}
      {onNew === undefined ? null : (
        <button
          type="button"
          aria-label={t.t('pipeline.newDeal')}
          data-action="new-deal"
          data-requires-connection=""
          disabled={newDisabled}
          onClick={onNew}
          className={`${BAR_BUTTON} text-primary-text`}
        >
          <Icon name="add_circle" size={24} />
        </button>
      )}
    </>
  );
}
