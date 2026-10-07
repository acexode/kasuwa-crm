'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON } from '../auth/button-classes';
import { FOCUS, MENU_ROW } from '../records/list-classes';
import { LoadMore, OfflineBanner } from '../records/list-parts';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';
import type { ListState } from '../records/list-model';
import { getLead, listLeads, moveLead, type Lead, type LeadStatus } from '../../lib/leads-api';
import {
  LEAD_STATUSES,
  isLeadStatus,
  leadListError,
  moveBody,
  moveRefusal,
  moveTargets,
  statusLabel,
  toColumnQuery,
  withRowFirst,
  withoutRow,
  withheldFromLeadError,
  type LeadColumnView,
  type LeadView,
} from './leads-model';
import { LeadValue, fieldProps } from './lead-parts';

/**
 * `P04/04` — the leads Kanban by status (T-0058, D-L86). Loaded when the
 * board is first opened, so the table's first paint does not carry it.
 *
 * ONE COLUMN PER LEAD STAGE, EACH ITS OWN READ. A column reads `listLeads`
 * for its own status alone and pages on its own cursor, inside the column, so
 * a busy stage cannot push a quiet one off the board. No column shows a count
 * (D-P13); pipeline totals are D-P19, and leads are not the pipeline.
 *
 * A MOVE IS EXACTLY `{ version, status }`, to a lead stage, with the version
 * the screen was last served for the card. Dropping a card on its own column
 * sends nothing. A card moves when the server confirms it, never before (so
 * nothing optimistic is left behind); a refusal is a translated alert, and a
 * 409 re-reads the card, so it is drawn where the server says it is.
 *
 * DRAGGING IS A SHORTCUT, NEVER THE ONLY WAY (WCAG 2.2 SC 2.5.7, 2.1.1). Every
 * card has a "Move" button offering the other lead stages, by pointer or by
 * keyboard. The drag is the platform's pointer events — no library, so it
 * costs the first paint nothing — and is a mouse or pen gesture only: a
 * finger on a 360 px board scrolls it, and moves a card with the button.
 *
 * OFFLINE, NOTHING MOVES (D-P21): the drag does not start and the buttons are
 * off. Nothing is queued for the reconnect, and nothing is put on the device.
 */

/** Module-level, so each column's effect sees one stable function. */
function fetchColumn(q: string, view: LeadColumnView, cursor?: string) {
  return listLeads(toColumnQuery(q, view, cursor));
}

/** Pixels a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

type Columns = Readonly<Record<LeadStatus, KeysetList<Lead, LeadColumnView>>>;

interface Drag {
  readonly row: Lead;
  readonly from: LeadStatus;
  readonly element: HTMLElement;
  readonly x: number;
  readonly y: number;
  active: boolean;
}

/** The lead stage of the column under a point, or `null`. */
function columnAt(x: number, y: number): LeadStatus | null {
  const value = document.elementFromPoint(x, y)?.closest('[data-kanban-column]')?.getAttribute('data-kanban-column');
  return isLeadStatus(value) ? value : null;
}

export function LeadsKanban({
  t,
  locale,
  q,
  view,
  onState,
  onWithheld,
}: {
  t: Translator;
  locale: string;
  q: string;
  view: LeadView;
  onState: (state: ListState) => void;
  onWithheld: (fields: readonly string[]) => void;
}) {
  const views = useMemo(
    () => ({
      new: { ...view, column: 'new' as const },
      contacted: { ...view, column: 'contacted' as const },
      qualified: { ...view, column: 'qualified' as const },
      unqualified: { ...view, column: 'unqualified' as const },
    }),
    [view],
  );
  const columns: Columns = {
    new: useKeysetList(q, views.new, fetchColumn),
    contacted: useKeysetList(q, views.contacted, fetchColumn),
    qualified: useKeysetList(q, views.qualified, fetchColumn),
    unqualified: useKeysetList(q, views.unqualified, fetchColumn),
  };
  const lists = LEAD_STATUSES.map((status) => columns[status]);
  const online = lists.every((list) => list.online);
  const syncedAt = lists.reduce<Date | null>(
    (latest, list) => (list.syncedAt !== null && (latest === null || list.syncedAt > latest) ? list.syncedAt : latest),
    null,
  );

  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [refusal, setRefusal] = useState<MessageId | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<LeadStatus | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hintId = useId();

  const phases = lists.map((list) => list.phase);
  const state: ListState = phases.includes('error') ? 'error' : phases.includes('loading') ? 'loading' : 'ready';
  useEffect(() => onState(state), [state, onState]);

  // Every withheld field a column has been shown, on a row or named by a
  // refusal, locks its filter chip (the screen keeps the set).
  const { new: columnNew, contacted, qualified, unqualified } = columns;
  const rowSets = [columnNew.rows, contacted.rows, qualified.rows, unqualified.rows] as const;
  const errors = [columnNew.error, contacted.error, qualified.error, unqualified.error] as const;
  useEffect(() => {
    onWithheld([
      ...rowSets.flatMap((rows) => rows.flatMap((row) => row.withheldFields)),
      ...errors.flatMap((error) => withheldFromLeadError(error)),
    ]);
    // The arrays above are rebuilt each render; their members are what change.
  }, [...rowSets, ...errors, onWithheld]);

  // After a move by the "Move" control, focus follows the card to its new
  // column, so a keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (refocus === null) return;
    const target = document.querySelector<HTMLElement>(
      `[data-kanban-column] [data-row-id="${CSS.escape(refocus)}"] [data-action="move-lead"]`,
    );
    target?.focus();
    setRefocus(null);
  }, [refocus]);

  // Escape closes an open "Move" menu and gives focus back to its button.
  useEffect(() => {
    if (menu === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const id = menu;
      setMenu(null);
      setRefocus(id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menu]);

  const mutators = useMemo(
    () => ({
      new: columnNew.mutate,
      contacted: contacted.mutate,
      qualified: qualified.mutate,
      unqualified: unqualified.mutate,
    }),
    [columnNew.mutate, contacted.mutate, qualified.mutate, unqualified.mutate],
  );

  const move = useCallback(
    async (row: Lead, from: LeadStatus, target: string, byControl: boolean) => {
      const body = moveBody(row, target);
      if (body === null || !navigator.onLine) return;
      setRefusal(null);
      setAnnouncement('');
      setMenu(null);
      setPending((current) => new Set([...current, row.id]));

      // Applied when the server says so, never before: a card is only ever
      // drawn where the server has it, with the version it last served.
      const result = await moveLead(row.id, body);
      setPending((current) => new Set([...current].filter((id) => id !== row.id)));
      if (result.ok) {
        const served = result.value;
        mutators[from]((rows) => withoutRow(rows, row.id));
        if (isLeadStatus(served.status)) mutators[served.status]((rows) => withRowFirst(rows, served));
        setAnnouncement(t.t('leads.move.moved', { name: served.displayName, stage: t.t(statusLabel(body.status)) }));
        if (byControl) setRefocus(row.id);
        return;
      }

      setRefusal(moveRefusal(result.error));
      if (byControl) setRefocus(row.id);
      if (result.error.code !== 'stale_write') return;
      // Someone else changed it first: show it where the server says it is now.
      const fresh = await getLead(row.id);
      if (!fresh.ok) return;
      const now = fresh.value.status;
      mutators[from]((rows) => (now === from ? rows.map((held) => (held.id === row.id ? fresh.value : held)) : withoutRow(rows, row.id)));
      if (isLeadStatus(now) && now !== from) mutators[now]((rows) => withRowFirst(rows, fresh.value));
    },
    [mutators, t],
  );

  const startDrag = (event: ReactPointerEvent<HTMLElement>, row: Lead, from: LeadStatus) => {
    // A mouse or a pen, the primary button, not on a control, and only online.
    if (!online || event.button !== 0 || event.pointerType === 'touch' || pending.has(row.id)) return;
    if ((event.target as Element).closest('button, a, input') !== null) return;
    dragRef.current = { row, from, element: event.currentTarget, x: event.clientX, y: event.clientY, active: false };

    const onMove = (moved: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = moved.clientX - drag.x;
      const dy = moved.clientY - drag.y;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        // A selection left by an earlier press would turn the next one into a
        // native drag of that text, which cancels the pointer events.
        window.getSelection()?.removeAllRanges();
        // The lifted card must not hide the column under the pointer.
        drag.element.style.pointerEvents = 'none';
        setDragging(drag.row.id);
        setMenu(null);
      }
      moved.preventDefault();
      drag.element.style.transform = `translate(${dx}px, ${dy}px)`;
      setOver(columnAt(moved.clientX, moved.clientY));
    };
    const finish = (ended: PointerEvent, drop: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.element.style.transform = '';
      drag.element.style.pointerEvents = '';
      setDragging(null);
      setOver(null);
      if (!drag.active || !drop) return;
      const target = columnAt(ended.clientX, ended.clientY);
      // Dropped on its own column, or off the board: nothing to write.
      if (target === null || target === drag.from) return;
      void move(drag.row, drag.from, target, false);
    };
    const onUp = (ended: PointerEvent) => finish(ended, true);
    const onCancel = (ended: PointerEvent) => finish(ended, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {online ? null : <OfflineBanner t={t} locale={locale} syncedAt={syncedAt} />}
      <p id={hintId} className="text-body-sm text-text-2">
        {t.t('leads.kanban.hint')}
      </p>
      {refusal === null ? null : (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(refusal)}
        </p>
      )}
      <div
        role="region"
        aria-label={t.t('leads.kanban.label')}
        aria-describedby={hintId}
        tabIndex={0}
        // `relative`: the cards' visually hidden labels are absolutely
        // positioned, and without a positioned ancestor here they escape the
        // scroller and widen the page at 360 px.
        className={`relative flex min-w-0 gap-3 overflow-x-auto pb-2 ${dragging === null ? '' : 'select-none'} ${FOCUS}`}
      >
        {LEAD_STATUSES.map((status) => (
          <Column
            key={status}
            t={t}
            status={status}
            list={columns[status]}
            online={online}
            over={over === status && dragging !== null}
            dragging={dragging}
            pending={pending}
            menu={menu}
            onMenu={setMenu}
            onDragStart={startDrag}
            onMove={(row, target) => void move(row, status, target, true)}
          />
        ))}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function Column({
  t,
  status,
  list,
  online,
  over,
  dragging,
  pending,
  menu,
  onMenu,
  onDragStart,
  onMove,
}: {
  t: Translator;
  status: LeadStatus;
  list: KeysetList<Lead, LeadColumnView>;
  online: boolean;
  over: boolean;
  dragging: string | null;
  pending: ReadonlySet<string>;
  menu: string | null;
  onMenu: (id: string | null) => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>, row: Lead, from: LeadStatus) => void;
  onMove: (row: Lead, target: LeadStatus) => void;
}) {
  const headingId = useId();
  return (
    <section
      data-kanban-column={status}
      aria-labelledby={headingId}
      className={`flex min-w-60 flex-1 basis-0 flex-col gap-2 rounded-lg border p-2 ${
        over ? 'border-primary bg-primary-soft' : 'border-border bg-surface-sunken'
      }`}
    >
      <h2 id={headingId} className="px-2 pt-1 text-body-sm font-bold">
        {t.t(statusLabel(status))}
      </h2>

      {list.phase === 'loading' ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <span role="status" className="sr-only">
            {t.t('leads.loading')}
          </span>
          {[0, 1, 2].map((index) => (
            <span key={index} aria-hidden="true" className="h-20 rounded-md bg-surface" />
          ))}
        </div>
      ) : list.phase === 'error' ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-danger bg-danger-soft p-3 text-body-sm text-danger-text">
          <p>{t.t(leadListError(list.error))}</p>
          <button type="button" data-requires-connection="" disabled={!online} onClick={list.reload} className={QUIET_BUTTON}>
            {t.t('records.retry')}
          </button>
        </div>
      ) : list.rows.length === 0 ? (
        <p className="px-2 py-4 text-body-sm text-text-2">{t.t('leads.kanban.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.rows.map((row) => (
            <Card
              key={row.id}
              t={t}
              row={row}
              online={online}
              lifted={dragging === row.id}
              pending={pending.has(row.id)}
              menuOpen={menu === row.id}
              onMenu={(open) => onMenu(open ? row.id : null)}
              onPointerDown={(event) => onDragStart(event, row, status)}
              onMove={(target) => onMove(row, target)}
            />
          ))}
        </ul>
      )}

      {list.moreError === null ? null : (
        <p role="alert" className="px-2 text-body-sm text-danger-text">
          {t.t(leadListError(list.moreError))}
        </p>
      )}
      {list.nextCursor === null ? null : (
        <LoadMore t={t} loading={list.loadingMore} offline={!online} onLoadMore={list.loadMore} />
      )}
    </section>
  );
}

function Card({
  t,
  row,
  online,
  lifted,
  pending,
  menuOpen,
  onMenu,
  onPointerDown,
  onMove,
}: {
  t: Translator;
  row: Lead;
  online: boolean;
  lifted: boolean;
  pending: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onMove: (target: LeadStatus) => void;
}) {
  const menuId = useId();
  const firstOption = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (menuOpen) firstOption.current?.focus();
  }, [menuOpen]);

  return (
    <li
      data-row-id={row.id}
      aria-busy={pending ? 'true' : undefined}
      onPointerDown={onPointerDown}
      // The platform's own drag (of text or the element) would cancel the
      // pointer events this board moves cards with.
      onDragStart={(event) => event.preventDefault()}
      className={`flex min-w-0 select-none flex-col gap-2 rounded-md border border-border bg-surface p-3 ${
        online && !pending ? 'cursor-grab' : ''
      } ${lifted ? 'relative z-10 cursor-grabbing shadow-3' : 'shadow-1'} ${pending ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon name="drag_indicator" size="sm" className="text-text-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-body-sm">
          <p data-field="displayName" className="break-words font-semibold">
            <span data-record-text="">{row.displayName}</span>
          </p>
          <p {...fieldProps(row, 'companyName')} className="min-w-0 text-text-2">
            <LeadValue t={t} row={row} field="companyName" />
          </p>
          <p {...fieldProps(row, 'owner')} className="min-w-0 text-caption text-text-2">
            <LeadValue t={t} row={row} field="owner" />
          </p>
        </div>
      </div>
      <button
        type="button"
        data-action="move-lead"
        data-requires-connection=""
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        disabled={!online || pending}
        onClick={() => onMenu(!menuOpen)}
        className={`${QUIET_BUTTON} self-start disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Icon name="open_with" size="sm" />
        {t.t('leads.move.button')}
        <span data-record-text="" className="sr-only">
          {row.displayName}
        </span>
      </button>
      {menuOpen ? (
        <div id={menuId} role="group" aria-label={t.t('leads.move.menu')} className="flex flex-col border-t border-border pt-2">
          {moveTargets(row).map((target, index) => (
            <button
              key={target}
              ref={index === 0 ? firstOption : undefined}
              type="button"
              data-move-to={target}
              data-requires-connection=""
              disabled={!online}
              onClick={() => onMove(target)}
              className={`${MENU_ROW} text-text disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <Icon name="arrow_forward" size="sm" className="text-text-muted" />
              {t.t(statusLabel(target))}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
