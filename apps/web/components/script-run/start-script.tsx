'use client';

import dynamic from 'next/dynamic';
import { useId, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SECONDARY_BUTTON } from '../auth/button-classes';

/**
 * `P10/04` — the "Start script" control on the contact record (T-0116, R1, R2).
 *
 * The record pays nothing for scripting until the agent asks: the menu, and
 * its listContactScripts read, load only when this control opens. On a
 * 256 kbps link the record's first paint carries one button and two strings.
 *
 * Drawn only where the record's SERVER page found the scripts flag on; this
 * module never reads a flag. Offline it is off, like every write (D-P21).
 */
const ScriptMenu = dynamic(() => import('./script-menu').then((module) => module.ScriptMenu), { ssr: false });

export function StartScript({ t, contactId, offline }: { t: Translator; contactId: string; offline: boolean }) {
  const [open, setOpen] = useState(false);
  const menu = useId();
  return (
    <>
      <button
        type="button"
        data-action="start-script"
        data-requires-connection=""
        aria-expanded={open}
        aria-controls={open ? menu : undefined}
        disabled={offline}
        onClick={() => setOpen((value) => !value)}
        className={`${SECONDARY_BUTTON} disabled:opacity-60`}
      >
        <Icon name="description" size="sm" />
        {t.t('scripting.start')}
      </button>
      {open ? (
        <div id={menu} className="basis-full">
          <ScriptMenu t={t} contactId={contactId} offline={offline} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
