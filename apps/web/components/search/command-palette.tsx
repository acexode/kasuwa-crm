'use client';

import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';
import { SearchPanel } from './search-panel';

/**
 * The Ctrl/Cmd+K command palette (T-0087, P27/D1's record rows): the search
 * panel in a modal dialog, opened from anywhere in the CRM shell.
 *
 * LOADED ON FIRST OPEN (R29). The shell reaches this module only through a
 * dynamic `import()`, so not one byte of it is in any screen's first load: a
 * 256 kbps user who never presses Ctrl+K never downloads it.
 *
 * A REAL DIALOG (R4, R5): `role="dialog"`, `aria-modal`, a name; focus moves
 * into the search box on open and Tab is trapped inside; Escape, the close
 * button and a press on the backdrop close it. The shell makes everything
 * behind it inert and gives focus back to whatever had it before.
 *
 * NOTHING SURVIVES A CLOSE (R19). The shell unmounts this on close, so the
 * next open starts empty: no last query, no recent searches, in memory or on
 * the device.
 *
 * Commands, programme switching, calls and Ask AI (D, D2, D3) are overruled
 * or unserved (D-L133) and are not here.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * What Tab can reach inside the dialog. The hits are `tabindex="-1"` links
 * (the combobox owns focus; arrows move the active option), so they are NOT
 * stops: counting them let Tab escape after a lookup with hits and no "see
 * all" (D-L137 M2).
 */
export function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.tabIndex >= 0);
}

export function CommandPalette({
  t,
  onClose,
  dealsLive = false,
}: {
  t: Translator;
  onClose: () => void;
  /** The deal screen answers in this process (`crmLiveNav()` lists `deals`): deal hits may link to it. */
  dealsLive?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes the palette and NOTHING ELSE (D-L137 M1). Caught in the
  // capture phase and stopped there, so a popover or dialog the page left open
  // behind the palette, listening on `document`, never sees it.
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [onClose]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (panel === null) return;
    const focusable = tabStops(panel);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const inside = panel.contains(document.activeElement);
    if (event.shiftKey && (!inside || document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center sm:p-4 sm:pt-16"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-inverse opacity-60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="command-palette"
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-xl flex-col gap-3 overflow-y-auto bg-surface-raised p-4 shadow-3 sm:rounded-lg"
      >
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-h4 font-bold">{t.t('search.palette.title')}</h2>
          <button
            type="button"
            aria-label={t.t('search.palette.close')}
            onClick={onClose}
            className={`flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken ${FOCUS}`}
          >
            <Icon name="close" />
          </button>
        </div>
        <SearchPanel
          t={t}
          autoFocus
          onNavigate={onClose}
          dealsLive={dealsLive}
          footer={<p className="hidden text-caption text-text-muted sm:block">{t.t('search.palette.keys')}</p>}
        />
      </div>
    </div>
  );
}
