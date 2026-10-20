'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { FOCUS } from './list-classes';

/**
 * The phone's dense record card (P04 "Card list · swipe open", T-0133):
 * full-bleed, divided by a rule, a 44px avatar, a 15/700 name with the WA
 * glyph, the phone in mono with its network tag, a 12px meta line and the
 * status. Swiping left — or the ⋮ button, which is the same action for anyone
 * who cannot swipe (WCAG 2.5.7) — slides the card over its actions.
 *
 * Call, WhatsApp and SMS sit behind `quick_actions` and are drawn disabled:
 * telephony and the inbox are not wired yet (D-L194, ADR-0003). A list's own
 * row action (Convert, Edit) is live and always there.
 */

export interface CardAction {
  readonly key: string;
  readonly icon: IconName;
  readonly label: MessageId;
  /** `null`: drawn disabled, with the reason. */
  readonly onClick: (() => void) | null;
  readonly tone: 'primary' | 'success' | 'info' | 'soft';
  readonly attributes?: Readonly<Record<`data-${string}`, string | undefined>>;
  readonly ariaDisabled?: boolean;
}

const TONE: Record<CardAction['tone'], string> = {
  primary: 'bg-primary text-on-primary',
  success: 'bg-success text-on-primary',
  info: 'bg-info text-on-primary',
  soft: 'bg-primary-soft-strong text-primary-text',
};

/** The panel's width, and how far the card slides, by the number of actions. */
const PANEL: Record<number, { width: string; slide: string }> = {
  1: { width: 'w-16', slide: '-translate-x-16 rtl:translate-x-16' },
  2: { width: 'w-32', slide: '-translate-x-32 rtl:translate-x-32' },
  3: { width: 'w-52', slide: '-translate-x-52 rtl:translate-x-52' },
  4: { width: 'w-64', slide: '-translate-x-64 rtl:translate-x-64' },
};

const SWIPE_PX = 40;

export function RecordCard({
  t,
  rowId,
  name,
  actions,
  avatar,
  children,
}: {
  t: Translator;
  rowId: string;
  name: string;
  actions: readonly CardAction[];
  avatar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const start = useRef<number | null>(null);
  const panel = PANEL[Math.min(actions.length, 4)];

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    start.current = event.clientX;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const moved = (event.clientX - start.current) * (rtl ? -1 : 1);
    start.current = null;
    if (moved < -SWIPE_PX) setOpen(true);
    if (moved > SWIPE_PX) setOpen(false);
  };

  return (
    <li data-row-id={rowId} className="relative overflow-hidden border-b border-border bg-surface-sunken">
      {actions.length === 0 || panel === undefined ? null : (
        <div className={`absolute inset-y-0 end-0 flex ${panel.width}`}>
          {actions.map((action) => {
            const live = action.onClick !== null;
            return (
              <button
                key={action.key}
                type="button"
                tabIndex={open ? 0 : -1}
                disabled={!live}
                aria-disabled={action.ariaDisabled === true ? 'true' : undefined}
                title={live ? undefined : t.t('records.action.unavailable')}
                aria-label={`${t.t(action.label)} ${name}`}
                onClick={action.onClick ?? undefined}
                className={`flex flex-1 flex-col items-center justify-center gap-0.75 text-caption font-bold ${FOCUS} ${
                  live ? TONE[action.tone] : 'bg-disabled-bg text-disabled-text'
                }`}
                {...action.attributes}
              >
                <Icon name={action.icon} size={22} />
                {t.t(action.label)}
              </button>
            );
          })}
        </div>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          start.current = null;
        }}
        className={`relative flex touch-pan-y items-start gap-3 bg-surface py-3 pe-1 ps-4 transition-transform duration-base motion-reduce:transition-none ${
          open && panel !== undefined ? panel.slide : 'translate-x-0'
        }`}
      >
        {avatar}
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">{children}</div>
        {actions.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t.t('records.card.actions', { name })}
            onClick={() => setOpen((current) => !current)}
            className={`flex size-touch shrink-0 items-center justify-center rounded-md text-text-2 ${FOCUS}`}
          >
            <Icon name="more_vert" size={22} />
          </button>
        )}
      </div>
    </li>
  );
}

/** The card's first line: the 15/700 name and, when opted in, the WA glyph. */
export function CardName({ t, name, withheld, whatsapp }: { t: Translator; name: string; withheld: boolean; whatsapp: boolean }) {
  return (
    <span data-field="displayName" className="flex min-w-0 items-center gap-1.5">
      <b
        data-record-text={withheld ? undefined : ''}
        data-name-withheld={withheld ? '' : undefined}
        className={`min-w-0 truncate text-label font-bold ${withheld ? 'text-text-muted' : ''}`}
      >
        {name}
      </b>
      {whatsapp ? (
        <span role="img" aria-label={t.t('records.wa.in')} className="flex text-success-text">
          <Icon name="chat" size={16} />
        </span>
      ) : null}
    </span>
  );
}

/** "Swipe left or tap ⋮ to call, WhatsApp or SMS" (P04 phone). */
export function SwipeHint({ t, label }: { t: Translator; label: MessageId }) {
  return (
    <p className="-mx-4 flex items-center gap-1.5 px-4 py-2.5 text-caption text-text-muted md:hidden">
      <Icon name="swipe_left" size={16} />
      {t.t(label)}
    </p>
  );
}

/**
 * The phone's floating "+ New": 56px, radius 16, primary, shadow 2, 16px from
 * the edge and clear of the bottom bar. Drawn here until T-0130's shell offers
 * a FAB slot. `onClick` absent: the create flow is not built (aria-disabled).
 */
export function NewFab({
  t,
  action,
  offline,
  onClick,
}: {
  t: Translator;
  action: string;
  offline: boolean;
  onClick?: () => void;
}) {
  const unavailable = onClick === undefined;
  return (
    <button
      type="button"
      data-fab=""
      data-action={action}
      data-requires-connection=""
      aria-disabled={unavailable || offline ? 'true' : undefined}
      title={unavailable ? t.t('records.action.unavailable') : undefined}
      onClick={unavailable || offline ? undefined : onClick}
      className={`fixed bottom-20 end-4 z-30 flex h-14 items-center gap-2 rounded-xl bg-primary pe-5 ps-4 text-label font-bold text-on-primary shadow-2 aria-disabled:cursor-not-allowed md:hidden ${FOCUS}`}
    >
      <Icon name="add" size={24} />
      {t.t('records.action.newShort')}
      {unavailable ? <span className="sr-only">{t.t('records.action.unavailable')}</span> : null}
    </button>
  );
}
