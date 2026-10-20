'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { withheld, type Deal, type Pipeline, type PipelineStage, type StageTotal } from '../../lib/pipelines-api';
import { DRAG_CLICK_WINDOW_MS, errorMessage, formatCount, formatInstantDate, formatPercent, isUuid, stageById, swallowsClick } from './pipeline-model';
import { nameOrWithheld } from '../records/name';
import { AmountValue, CloseShort, InStageChip, Locked, Money, OwnerAvatar, lockedProps } from './pipeline-parts';
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
  whatsapp = false,
  blockedId = null,
  onLoadMore,
  onDrop,
  onMoveSheet,
  onActiveColumn,
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
  /** `whatsapp_recency` (D-L194): the last-WhatsApp chip, an empty dash. */
  whatsapp?: boolean;
  /** The card P06/07's banner names: outlined in danger. */
  blockedId?: string | null;
  onLoadMore: (stageId: string) => void;
  /** A card dropped on another column: the screen decides what is sent. */
  onDrop: (dealId: string, toStageId: string) => void;
  onMoveSheet: (deal: Deal) => void;
  /** At 360 px, the column the sideways scroller rests on, for the stage chips. */
  onActiveColumn?: (index: number) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  // "Now", read once a minute: days in stage and "overdue" are whole days.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [over, setOver] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hintId = useId();

  // A board that goes away mid-drag (a navigation) takes its ghost with it.
  useEffect(() => () => dragRef.current?.ghost?.remove(), []);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, deal: Deal) => {
    // A mouse or a pen, the primary button, not on a control, and only online.
    if (!online || event.button !== 0 || event.pointerType === 'touch' || pending.has(deal.id)) return;
    // A control is pressed, not dragged; the card's name link is the exception (R15).
    // The drag handle is the exception too: pressed, it opens the move sheet; dragged, it lifts the card.
    if ((event.target as Element).closest('button:not([data-drag-handle]), a:not([data-deal-link]), input, select') !== null) return;
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
  // A column's bar is its total against the largest column total in the same currency.
  const largest = new Map<string, bigint>();
  for (const column of columns) {
    for (const total of column.totals ?? []) {
      const amount = BigInt(total.amountMinor);
      if (amount > (largest.get(total.currency) ?? 0n)) largest.set(total.currency, amount);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="region"
        aria-label={t.t('pipeline.board.label')}
        aria-describedby={hintId}
        tabIndex={0}
        data-testid="board"
        onScroll={(event) => {
          if (onActiveColumn === undefined) return;
          const scroller = event.currentTarget;
          const first = scroller.querySelector<HTMLElement>('[data-stage-column]');
          if (first === null) return;
          onActiveColumn(Math.round(scroller.scrollLeft / (first.offsetWidth + 12)));
        }}
        // `relative`: the cards' visually hidden labels are absolutely
        // positioned, and must not escape the scroller and widen the page.
        className={`relative -mx-4 flex min-w-0 snap-x snap-mandatory items-start gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:snap-none md:px-0 ${dragging === null ? '' : 'select-none'} ${FOCUS}`}
      >
        {columns.map((column) => {
          const stage = stageById(pipeline, column.stageId);
          return (
            <StageColumn
              key={column.stageId}
              t={t}
              locale={locale}
              column={column}
              stage={stage}
              largest={largest}
              closedSince={closedSince}
              amountWithheld={amountWithheld}
              online={online}
              over={over === column.stageId && dragging !== null}
              dragging={dragging}
              pending={pending}
              links={links}
              whatsapp={whatsapp}
              blockedId={blockedId}
              nowMs={nowMs}
              onLoadMore={() => onLoadMore(column.stageId)}
              onDragStart={startDrag}
              onMoveSheet={onMoveSheet}
            />
          );
        })}
      </div>
      <p id={hintId} className="hidden text-caption font-normal text-text-muted md:block">
        {t.t('pipeline.board.hint')}
      </p>
    </div>
  );
}

/** The bar's width, in whole percent of the largest column in that currency. */
function barPercent(totals: readonly StageTotal[] | undefined, largest: ReadonlyMap<string, bigint>): number {
  const total = totals?.[0];
  if (total === undefined) return 0;
  const max = largest.get(total.currency) ?? 0n;
  if (max === 0n) return 0;
  return Number((BigInt(total.amountMinor) * 100n) / max);
}

function StageColumn({
  t,
  locale,
  column,
  stage,
  largest,
  closedSince,
  amountWithheld,
  online,
  over,
  dragging,
  pending,
  links,
  whatsapp,
  blockedId,
  nowMs,
  onLoadMore,
  onDragStart,
  onMoveSheet,
}: {
  t: Translator;
  locale: string;
  column: Column;
  stage: PipelineStage | undefined;
  largest: ReadonlyMap<string, bigint>;
  closedSince: string | null;
  amountWithheld: boolean;
  online: boolean;
  over: boolean;
  dragging: string | null;
  pending: ReadonlySet<string>;
  links: RecordLinks;
  whatsapp: boolean;
  blockedId: string | null;
  nowMs: number;
  onLoadMore: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>, deal: Deal) => void;
  onMoveSheet: (deal: Deal) => void;
}) {
  const headingId = useId();
  const kind = stage?.kind ?? 'open';
  const won = kind === 'won';
  const gated = (stage?.requirements.length ?? 0) > 0;
  const bar = barPercent(column.totals, largest);
  return (
    <section
      data-stage-column={column.stageId}
      data-stage-kind={kind}
      aria-labelledby={headingId}
      // At most a screen tall, its cards scrolling inside it: the page itself
      // never scrolls far, so every column's top stays in reach of a drop.
      className={`flex max-h-screen shrink-0 snap-start flex-col gap-2.5 rounded-lg bg-surface-sunken p-2.5 md:min-h-[420px] ${
        won ? 'w-[300px] md:w-[200px]' : 'w-[300px] md:w-auto md:min-w-[228px] md:flex-1 md:basis-0'
      } ${over ? 'border-2 border-primary' : 'border border-border'}`}
    >
      <header className="flex shrink-0 flex-col gap-1 px-0.5 pb-1 pt-0.5">
        <div className="flex items-center gap-1.5">
          <h2 id={headingId} className="min-w-0 break-words text-body-sm font-bold">
            <span data-field="stage-name" data-record-text="">
              {stage?.name ?? ''}
            </span>
          </h2>
          {gated ? (
            <span title={t.t('pipeline.column.gated')} className="flex text-text-2">
              <Icon name="lock" size={16} />
              <span className="sr-only">{t.t('pipeline.column.gated')}</span>
            </span>
          ) : null}
          <span data-stage-count="" className="rounded-full bg-surface px-1.5 py-px text-caption font-bold text-text-2 tabular-nums">
            <span className="sr-only">{t.t('pipeline.column.countLabel')} </span>
            {formatCount(locale, column.count)}
          </span>
          <span className="flex-1" />
          {stage === undefined ? null : <span className="text-micro text-text-muted">{formatPercent(locale, stage.probabilityBp)}</span>}
        </div>
        {amountWithheld || column.totals === undefined ? (
          <p data-stage-totals="" data-locked="true" className="text-caption">
            <Locked t={t} />
          </p>
        ) : column.totals.length === 0 ? null : (
          <ul data-stage-totals="" className="flex flex-col">
            {column.totals.map((total) => (
              <li key={total.currency} data-stage-total={total.currency} className="flex flex-wrap items-baseline gap-x-1.5">
                <b className="text-label font-bold">
                  <Money t={t} locale={locale} money={{ amountMinor: total.amountMinor, currency: total.currency }} kind="amount" />
                </b>
                <span className="text-caption font-normal text-text-2">
                  {t.t('pipeline.column.weighted')}{' '}
                  <Money t={t} locale={locale} money={{ amountMinor: total.weightedAmountMinor, currency: total.currency }} kind="weighted" className="font-semibold" />
                </span>
              </li>
            ))}
          </ul>
        )}
        <span aria-hidden="true" className="h-1 overflow-hidden rounded-sm bg-surface">
          <span className={`block h-full ${won ? 'bg-success' : 'bg-chart-1'}`} style={{ width: `${bar}%` }} />
        </span>
      </header>

      {won ? (
        // With no won deal yet, the green box is the column's empty state (T-0109's column-empty hook).
        <div
          data-testid={column.cards.length === 0 ? 'column-empty' : undefined}
          className="flex flex-col gap-0.5 rounded-10 bg-success-soft px-3 py-2.5 text-caption font-normal text-success-text"
        >
          <b className="text-meta font-bold">{t.t('pipeline.won.count', { count: column.count })}</b>
          {closedSince === null ? null : (
            <span data-testid="won-since">
              {t.t('pipeline.won.since')} <time dateTime={closedSince}>{formatInstantDate(locale, closedSince)}</time>
            </span>
          )}
          {amountWithheld || column.totals === undefined
            ? null
            : column.totals.map((total) => (
                <Money key={total.currency} t={t} locale={locale} money={{ amountMinor: total.amountMinor, currency: total.currency }} />
              ))}
          <span>{t.t('pipeline.won.drop')}</span>
        </div>
      ) : null}

      {column.cards.length === 0 ? (
        won ? null : (
          <p data-testid="column-empty" className="rounded-10 border border-dashed border-border-strong p-3 text-meta text-text-2">
            {t.t('pipeline.column.empty')}
          </p>
        )
      ) : (
        <ul className="-m-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-1">
          {column.cards.map((deal) => (
            <DealCard
              key={deal.id}
              t={t}
              locale={locale}
              deal={deal}
              online={online}
              lifted={dragging === deal.id}
              pending={pending.has(deal.id)}
              blocked={blockedId === deal.id}
              links={links}
              whatsapp={whatsapp}
              nowMs={nowMs}
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

function DealCard({
  t,
  locale,
  deal,
  online,
  lifted,
  pending,
  blocked,
  links,
  whatsapp,
  nowMs,
  onPointerDown,
  onMoveSheet,
}: {
  t: Translator;
  locale: string;
  deal: Deal;
  online: boolean;
  lifted: boolean;
  pending: boolean;
  blocked: boolean;
  links: RecordLinks;
  whatsapp: boolean;
  nowMs: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onMoveSheet: () => void;
}) {
  const nextWithheld = withheld(deal, 'nextStep');
  const next = deal.nextStep ?? null;
  return (
    <li
      data-deal-card={deal.id}
      data-rotting={deal.rotting ?? undefined}
      aria-busy={pending ? 'true' : undefined}
      onPointerDown={onPointerDown}
      // The platform's own drag (of text or the element) would cancel the
      // pointer events this board moves cards with.
      onDragStart={(event) => event.preventDefault()}
      className={`flex min-w-0 select-none flex-col gap-2 rounded-10 border bg-surface p-3 text-body-sm ${blocked ? 'border-danger ring-1 ring-danger' : 'border-border'} ${
        online && !pending ? 'md:cursor-grab' : ''
      } ${lifted ? 'opacity-60' : 'shadow-1'} ${pending ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <p data-field="name" className="min-w-0 flex-1 break-words text-body-sm font-bold">
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
        {/* The drag handle is also the keyboard's and the screen reader's way to move (WCAG 2.2 SC 2.5.7). */}
        <button
          type="button"
          data-action="move-deal"
          data-drag-handle=""
          data-requires-connection=""
          aria-haspopup="dialog"
          disabled={!online || pending}
          onClick={onMoveSheet}
          className={`-me-1 -mt-0.5 hidden size-6 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-sunken hover:text-text disabled:cursor-not-allowed disabled:text-disabled-text md:flex ${FOCUS}`}
        >
          <Icon name="drag_indicator" size={18} />
          <span className="sr-only">
            {t.t('pipeline.card.move')} <span data-record-text="">{deal.name}</span>
          </span>
        </button>
      </div>
      <Related t={t} deal={deal} links={links} />
      <p data-field="amount" {...lockedProps(deal, 'amount')} className="-mt-0.5 text-label font-semibold">
        <span className="sr-only">{t.t('pipeline.field.amount')} </span>
        <AmountValue t={t} locale={locale} deal={deal} />
      </p>
      {nextWithheld ? (
        <p data-field="nextStep" data-locked="true" className="flex min-w-0 items-start gap-1.5 rounded-6 bg-surface-sunken px-2 py-1.5 text-caption font-semibold">
          <Icon name="flag" size={15} />
          <span className="sr-only">{t.t('pipeline.field.nextStep')} </span>
          <Locked t={t} />
        </p>
      ) : next !== null ? (
        <p data-field="nextStep" className="flex min-w-0 items-start gap-1.5 rounded-6 bg-surface-sunken px-2 py-1.5 text-caption font-semibold text-text">
          <Icon name="flag" size={15} />
          <span className="sr-only">{t.t('pipeline.field.nextStep')} </span>
          <span data-record-text="" className="min-w-0 break-words">
            {next}
          </span>
        </p>
      ) : deal.rotting === null ? null : (
        <p className="flex min-w-0 items-start gap-1.5 rounded-6 bg-warning-soft px-2 py-1.5 text-caption font-semibold text-warning-text">
          <Icon name="warning" size={15} />
          {t.t('pipeline.card.noNextStep')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-caption font-semibold text-text-2">
        <InStageChip t={t} deal={deal} nowMs={nowMs} />
        {withheld(deal, 'expectedCloseDate') || (deal.expectedCloseDate ?? null) !== null ? (
          <span data-field="expectedCloseDate" {...lockedProps(deal, 'expectedCloseDate')} className="inline-flex items-center">
            <span className="sr-only">{t.t('pipeline.field.expectedCloseDate')} </span>
            <CloseShort t={t} locale={locale} deal={deal} nowMs={nowMs} />
          </span>
        ) : null}
        {whatsapp ? (
          <span title={t.t('pipeline.card.whatsappNone')} className="inline-flex items-center gap-0.5 font-normal text-text-muted">
            <Icon name="chat" size={14} />
            <span aria-hidden="true">{'—'}</span>
            <span className="sr-only">{t.t('pipeline.card.whatsappNone')}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        <span data-field="owner" {...lockedProps(deal, 'ownerUserId')} className="inline-flex">
          <span className="sr-only">{t.t('pipeline.field.owner')} </span>
          <OwnerAvatar t={t} deal={deal} locale={locale} />
        </span>
      </div>
      {/* P06/09: on a phone, a full-width Move stage under every card. */}
      <button
        type="button"
        data-action="move-deal"
        data-requires-connection=""
        aria-haspopup="dialog"
        disabled={!online || pending}
        onClick={onMoveSheet}
        className={`flex h-control-base items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface text-body-sm font-semibold text-text disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-text md:hidden ${FOCUS}`}
      >
        <Icon name="move_up" size={18} />
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

/** The account and contact summaries, one plain sub-line ("Account · Contact"): a link only from a well-formed uuid (R15), else text. */
function Related({ t, deal, links }: { t: Translator; deal: Deal; links: RecordLinks }) {
  const account = deal.account ?? null;
  const contact = deal.contact ?? null;
  if (account === null && contact === null) return null;
  return (
    // No negative margin: the name link and these must sit 24px apart, centre to centre (WCAG 2.5.8, axe, T-0147).
    <p className="min-w-0 break-words text-meta font-normal text-text-2">
      {account === null ? null : (
        <span data-related="account">
          <Summary href={links.accounts && isUuid(account.id) ? `/accounts/${account.id}` : null} text={account.name} />
        </span>
      )}
      {account !== null && contact !== null ? <span aria-hidden="true">{' · '}</span> : null}
      {contact === null ? null : (
        <span data-related="contact">
          <Summary href={links.contacts && isUuid(contact.id) ? `/contacts/${contact.id}` : null} text={nameOrWithheld(t, contact.displayName)} />
        </span>
      )}
    </p>
  );
}

function Summary({ href, text }: { href: string | null; text: string }) {
  if (href === null) {
    return <span data-record-text="">{text}</span>;
  }
  return (
    <Link href={href} prefetch={false} data-record-text="" className={`rounded-sm hover:text-primary-text hover:underline ${FOCUS}`}>
      {text}
    </Link>
  );
}
