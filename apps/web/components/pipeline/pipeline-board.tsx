'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { withheld, type Deal, type Pipeline } from '../../lib/pipelines-api';
import { DRAG_CLICK_WINDOW_MS, errorMessage, formatCount, formatInstantDate, isUuid, stageById, swallowsClick } from './pipeline-model';
import { AmountValue, CloseValue, Locked, Money, OwnerValue, lockedProps } from './pipeline-parts';
import type { Column } from './use-pipeline-board';

/**
 * `P06/01` — the board's columns and cards (T-0109), and `P06/04` at 360 px:
 * the same columns as a sideways list that snaps per stage, inside its own
 * scroller, so the PAGE never scrolls sideways.
 *
 * EVERY NUMBER IS THE SERVER'S (R4, R6). The count, the per-currency totals
 * and their weighted amounts are drawn exactly as served, one line per
 * currency in served order, never summed across currencies and never
 * compacted (D-P19). With `amount` withheld the totals are a lock, never a
 * zero; the count stays.
 *
 * ROTTING IS SERVED (R8): `fresh`, `stale` or `rotting`, from the stage's own
 * days. Never recomputed from the design's fixed 7 and 14 days. Won rots not.
 *
 * DRAGGING IS A SHORTCUT, NEVER THE ONLY WAY (WCAG 2.2 SC 2.5.7). Every card
 * has a "Move stage" button opening the move sheet, which sends the same
 * moveDeal. The drag is the platform's pointer events, mouse or pen only (a
 * finger scrolls the board); no library, so it costs the first paint nothing.
 * Each column is at most a screen tall and scrolls its own cards, so the page
 * barely scrolls and every column stays a reachable drop target.
 * Dropping a card on its own column, or off the board, sends nothing.
 *
 * NO CARD LINKS TO A DEAL YET (R15): the deal detail is T-0110's. A contact or
 * account summary links only from a well-formed uuid; anything else is text.
 */

/** Whether the record routes a summary would link to answer in this process. */
export interface RecordLinks {
  readonly contacts: boolean;
  readonly accounts: boolean;
}

/** Pixels a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

interface Drag {
  readonly dealId: string;
  readonly from: string;
  readonly element: HTMLElement;
  readonly x: number;
  readonly y: number;
  active: boolean;
  /** The copy that follows the pointer, above every column's scroller. */
  ghost: HTMLElement | null;
}

/**
 * A detached, inert copy of the lifted card, fixed over the page so a column's
 * own scroller cannot clip it. It carries no hooks (`data-*`), no ids and no
 * accessible content: the card itself stays where it is until the server says.
 */
function liftGhost(card: HTMLElement): HTMLElement {
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>('*'))]) {
    for (const name of node.getAttributeNames()) {
      if (name.startsWith('data-') || name === 'id' || name.startsWith('aria-')) node.removeAttribute(name);
    }
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.add('pointer-events-none', 'fixed', 'z-50', 'shadow-3', 'cursor-grabbing');
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  document.body.appendChild(ghost);
  return ghost;
}

/** The stage of the column under a point, or `null`. */
function columnAt(x: number, y: number): string | null {
  return document.elementFromPoint(x, y)?.closest('[data-stage-column]')?.getAttribute('data-stage-column') ?? null;
}

export function PipelineBoard({
  t,
  locale,
  pipeline,
  columns,
  closedSince,
  withheldFields,
  online,
  pending,
  links,
  onLoadMore,
  onDrop,
  onMoveSheet,
}: {
  t: Translator;
  locale: string;
  pipeline: Pipeline;
  columns: readonly Column[];
  closedSince: string | null;
  withheldFields: readonly string[];
  online: boolean;
  pending: ReadonlySet<string>;
  links: RecordLinks;
  onLoadMore: (stageId: string) => void;
  /** A card dropped on another column: the screen decides what is sent. */
  onDrop: (dealId: string, toStageId: string) => void;
  onMoveSheet: (deal: Deal) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hintId = useId();

  // A board that goes away mid-drag (a navigation) takes its ghost with it.
  useEffect(() => () => dragRef.current?.ghost?.remove(), []);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, deal: Deal) => {
    // A mouse or a pen, the primary button, not on a control, and only online.
    if (!online || event.button !== 0 || event.pointerType === 'touch' || pending.has(deal.id)) return;
    // A control is pressed, not dragged; the card's name link is the exception (R15).
    if ((event.target as Element).closest('button, a:not([data-deal-link]), input, select') !== null) return;
    dragRef.current = { dealId: deal.id, from: deal.stageId, element: event.currentTarget, x: event.clientX, y: event.clientY, active: false, ghost: null };

    const onMove = (moved: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = moved.clientX - drag.x;
      const dy = moved.clientY - drag.y;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        // A selection left by an earlier press would turn this one into a
        // native drag of that text, which cancels the pointer events.
        window.getSelection()?.removeAllRanges();
        drag.ghost = liftGhost(drag.element);
        setDragging(drag.dealId);
      }
      moved.preventDefault();
      if (drag.ghost !== null) drag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      setOver(columnAt(moved.clientX, moved.clientY));
    };
    const finish = (ended: PointerEvent, drop: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.ghost?.remove();
      setDragging(null);
      setOver(null);
      if (!drag.active) return;
      swallowNextClick(drag.element);
      if (!drop) return;
      const target = columnAt(ended.clientX, ended.clientY);
      // Dropped on its own column, or off the board: nothing to write.
      if (target === null || target === drag.from) return;
      onDrop(drag.dealId, target);
    };
    const onUp = (ended: PointerEvent) => finish(ended, true);
    const onCancel = (ended: PointerEvent) => finish(ended, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const amountWithheld = withheldFields.includes('amount');

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p id={hintId} className="text-body-sm text-text-2">
        {t.t('pipeline.board.hint')}
      </p>
      <div
        role="region"
        aria-label={t.t('pipeline.board.label')}
        aria-describedby={hintId}
        tabIndex={0}
        data-testid="board"
        // `relative`: the cards' visually hidden labels are absolutely
        // positioned, and must not escape the scroller and widen the page.
        className={`relative flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none ${dragging === null ? '' : 'select-none'} ${FOCUS}`}
      >
        {columns.map((column) => {
          const stage = stageById(pipeline, column.stageId);
          return (
            <StageColumn
              key={column.stageId}
              t={t}
              locale={locale}
              column={column}
              name={stage?.name ?? ''}
              kind={stage?.kind ?? 'open'}
              closedSince={closedSince}
              amountWithheld={amountWithheld}
              online={online}
              over={over === column.stageId && dragging !== null}
              dragging={dragging}
              pending={pending}
              links={links}
              onLoadMore={() => onLoadMore(column.stageId)}
              onDragStart={startDrag}
              onMoveSheet={onMoveSheet}
            />
          );
        })}
      </div>
    </div>
  );
}

function StageColumn({
  t,
  locale,
  column,
  name,
  kind,
  closedSince,
  amountWithheld,
  online,
  over,
  dragging,
  pending,
  links,
  onLoadMore,
  onDragStart,
  onMoveSheet,
}: {
  t: Translator;
  locale: string;
  column: Column;
  name: string;
  kind: 'open' | 'won' | 'lost';
  closedSince: string | null;
  amountWithheld: boolean;
  online: boolean;
  over: boolean;
  dragging: string | null;
  pending: ReadonlySet<string>;
  links: RecordLinks;
  onLoadMore: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>, deal: Deal) => void;
  onMoveSheet: (deal: Deal) => void;
}) {
  const headingId = useId();
  return (
    <section
      data-stage-column={column.stageId}
      data-stage-kind={kind}
      aria-labelledby={headingId}
      // At most a screen tall, its cards scrolling inside it: the page itself
      // never scrolls far, so every column's top stays in reach of a drop.
      className={`flex max-h-screen w-72 shrink-0 snap-start flex-col gap-2 rounded-lg border p-2 ${
        over ? 'border-primary bg-primary-soft' : 'border-border bg-surface-sunken'
      }`}
    >
      <header className="flex shrink-0 flex-col gap-1 px-2 pt-1">
        <div className="flex items-baseline gap-2">
          <h2 id={headingId} className="min-w-0 flex-1 break-words text-body-md font-bold">
            <span data-field="stage-name" data-record-text="">
              {name}
            </span>
          </h2>
          <span data-stage-count="" className="rounded-full bg-surface px-2 text-body-sm font-semibold tabular-nums">
            <span className="sr-only">{t.t('pipeline.column.countLabel')} </span>
            {formatCount(locale, column.count)}
          </span>
        </div>
        {kind === 'won' && closedSince !== null ? (
          <p data-testid="won-since" className="text-caption text-text-2">
            {t.t('pipeline.won.since')} <time dateTime={closedSince}>{formatInstantDate(locale, closedSince)}</time>
          </p>
        ) : null}
        {amountWithheld || column.totals === undefined ? (
          <p data-stage-totals="" data-locked="true" className="text-caption">
            <Locked t={t} />
          </p>
        ) : column.totals.length === 0 ? null : (
          <ul data-stage-totals="" className="flex flex-col text-caption text-text-2">
            {column.totals.map((total) => (
              <li key={total.currency} data-stage-total={total.currency} className="flex flex-wrap items-baseline gap-x-2">
                <b className="text-body-sm text-text">
                  <Money t={t} locale={locale} money={{ amountMinor: total.amountMinor, currency: total.currency }} kind="amount" />
                </b>
                <span>
                  {t.t('pipeline.column.weighted')}{' '}
                  <Money t={t} locale={locale} money={{ amountMinor: total.weightedAmountMinor, currency: total.currency }} kind="weighted" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </header>

      {column.cards.length === 0 ? (
        <p data-testid="column-empty" className="px-2 py-4 text-body-sm text-text-2">
          {t.t('pipeline.column.empty')}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {column.cards.map((deal) => (
            <DealCard
              key={deal.id}
              t={t}
              locale={locale}
              deal={deal}
              online={online}
              lifted={dragging === deal.id}
              pending={pending.has(deal.id)}
              links={links}
              onPointerDown={(event) => onDragStart(event, deal)}
              onMoveSheet={() => onMoveSheet(deal)}
            />
          ))}
        </ul>
      )}

      {column.moreError === null ? null : (
        <p role="alert" data-testid="column-error" className="px-2 text-body-sm text-danger-text">
          {t.t(errorMessage(column.moreError, 'read'))}
        </p>
      )}
      {column.nextCursor === null ? null : (
        <button
          type="button"
          data-testid="column-more"
          data-requires-connection=""
          disabled={!online || column.loadingMore}
          onClick={onLoadMore}
          className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {t.t(column.loadingMore ? 'records.loadingMore' : 'records.loadMore')}
        </button>
      )}
    </section>
  );
}

const ROTTING_TONE = {
  fresh: 'border-border',
  stale: 'border-warning',
  rotting: 'border-danger',
} as const;

function DealCard({
  t,
  locale,
  deal,
  online,
  lifted,
  pending,
  links,
  onPointerDown,
  onMoveSheet,
}: {
  t: Translator;
  locale: string;
  deal: Deal;
  online: boolean;
  lifted: boolean;
  pending: boolean;
  links: RecordLinks;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onMoveSheet: () => void;
}) {
  const tone = deal.rotting === null ? 'border-border' : ROTTING_TONE[deal.rotting];
  return (
    <li
      data-deal-card={deal.id}
      data-rotting={deal.rotting ?? undefined}
      aria-busy={pending ? 'true' : undefined}
      onPointerDown={onPointerDown}
      // The platform's own drag (of text or the element) would cancel the
      // pointer events this board moves cards with.
      onDragStart={(event) => event.preventDefault()}
      className={`flex min-w-0 select-none flex-col gap-2 rounded-md border bg-surface p-3 text-body-sm ${tone} ${
        online && !pending ? 'cursor-grab' : ''
      } ${lifted ? 'opacity-60' : 'shadow-1'} ${pending ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon name="drag_indicator" size="sm" className="text-text-muted" />
        <p data-field="name" className="min-w-0 flex-1 break-words font-semibold">
          {isUuid(deal.id) ? (
            // The deal detail (T-0110, R15). A drag may start on the name: the
            // board's pointer handler lets this link through, and a click that
            // ends a drag is swallowed rather than followed.
            <Link
              href={`/deals/${deal.id}`}
              prefetch={false}
              draggable={false}
              data-deal-link=""
              data-record-text=""
              className={`rounded-sm text-text hover:text-primary-text hover:underline ${FOCUS}`}
            >
              {deal.name}
            </Link>
          ) : (
            <span data-record-text="">{deal.name}</span>
          )}
        </p>
      </div>
      <Related deal={deal} links={links} />
      <p data-field="amount" {...lockedProps(deal, 'amount')} className="font-semibold">
        <span className="sr-only">{t.t('pipeline.field.amount')} </span>
        <AmountValue t={t} locale={locale} deal={deal} />
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-2">
        <p data-field="owner" {...lockedProps(deal, 'ownerUserId')} className="inline-flex min-w-0 items-center gap-1">
          <Icon name="person" size="sm" />
          <span className="sr-only">{t.t('pipeline.field.owner')} </span>
          <OwnerValue t={t} deal={deal} />
        </p>
        {withheld(deal, 'expectedCloseDate') || (deal.expectedCloseDate ?? null) !== null ? (
          <p data-field="expectedCloseDate" {...lockedProps(deal, 'expectedCloseDate')} className="inline-flex items-center gap-1">
            <Icon name="event" size="sm" />
            <span className="sr-only">{t.t('pipeline.field.expectedCloseDate')} </span>
            <CloseValue t={t} locale={locale} deal={deal} />
          </p>
        ) : null}
      </div>
      {withheld(deal, 'nextStep') || (deal.nextStep ?? null) !== null ? (
        <p data-field="nextStep" {...lockedProps(deal, 'nextStep')} className="flex min-w-0 items-start gap-1 text-caption text-text-2">
          <Icon name="arrow_forward" size="sm" />
          <span className="sr-only">{t.t('pipeline.field.nextStep')} </span>
          {withheld(deal, 'nextStep') ? (
            <Locked t={t} />
          ) : (
            <span data-record-text="" className="min-w-0 break-words">
              {deal.nextStep}
            </span>
          )}
        </p>
      ) : null}
      {deal.rotting === 'stale' ? (
        <p className="flex items-center gap-1 text-caption font-semibold text-warning-text">
          <Icon name="schedule" size="sm" />
          {t.t('pipeline.rotting.stale')}
        </p>
      ) : deal.rotting === 'rotting' ? (
        <p className="flex items-center gap-1 text-caption font-semibold text-danger-text">
          <Icon name="warning" size="sm" />
          {t.t('pipeline.rotting.rotting')}
        </p>
      ) : null}
      <button
        type="button"
        data-action="move-deal"
        data-requires-connection=""
        disabled={!online || pending}
        onClick={onMoveSheet}
        className={`${QUIET_BUTTON} self-start disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Icon name="open_with" size="sm" />
        {t.t('pipeline.card.move')}
        <span data-record-text="" className="sr-only">
          {deal.name}
        </span>
      </button>
    </li>
  );
}

/**
 * A drag that began on a card (its name link included, R15) and ends over that
 * card would otherwise be followed as a click. The drag arms a one-shot guard
 * on the card: the next click inside it within `DRAG_CLICK_WINDOW_MS` is
 * swallowed. The guard disarms on that click, on the next pointerdown, or when
 * the window passes, so it never depends on how a browser orders the click
 * against timers, and it never eats a later, deliberate click.
 */
function swallowNextClick(card: Element): void {
  const armedAt = performance.now();
  const disarm = () => {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerdown', disarm, true);
    window.clearTimeout(timer);
  };
  const onClick = (event: MouseEvent) => {
    const inside = event.target instanceof Node && card.contains(event.target);
    if (swallowsClick(armedAt, performance.now(), inside)) {
      event.preventDefault();
      event.stopPropagation();
    }
    disarm();
  };
  const timer = window.setTimeout(disarm, DRAG_CLICK_WINDOW_MS);
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerdown', disarm, true);
}

/** The account and contact summaries: a link only from a well-formed uuid (R15), else text. */
function Related({ deal, links }: { deal: Deal; links: RecordLinks }) {
  const account = deal.account ?? null;
  const contact = deal.contact ?? null;
  if (account === null && contact === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-caption text-text-2">
      {account === null ? null : (
        <p data-related="account" className="flex min-w-0 items-center gap-1">
          <Icon name="domain" size="sm" />
          <Summary href={links.accounts && isUuid(account.id) ? `/accounts/${account.id}` : null} text={account.name} />
        </p>
      )}
      {contact === null ? null : (
        <p data-related="contact" className="flex min-w-0 items-center gap-1">
          <Icon name="person" size="sm" />
          <Summary href={links.contacts && isUuid(contact.id) ? `/contacts/${contact.id}` : null} text={contact.displayName} />
        </p>
      )}
    </div>
  );
}

function Summary({ href, text }: { href: string | null; text: string }) {
  if (href === null) {
    return (
      <span data-record-text="" className="min-w-0 break-words">
        {text}
      </span>
    );
  }
  return (
    <Link href={href} prefetch={false} data-record-text="" className={`min-w-0 break-words font-semibold text-primary-text underline ${FOCUS}`}>
      {text}
    </Link>
  );
}
