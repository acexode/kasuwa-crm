'use client';

import { useEffect, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Button, Menu, MenuItem, SLOW_LOADING_MS } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { SPAN_IDS, type Span, type WidgetType } from './home-model';

/**
 * A P03 widget: the card, its header and, in customise mode, its controls
 * (`Kasuwa Home Dashboards`, the `section[data-card]` template).
 *
 *   card     surface, 1px border, radius 12, 16px 18px (14px on a phone),
 *            12px between header and body; the 12-column span from `md` up,
 *            the whole row on a phone
 *   header   an 18px primary glyph and the 16/700 title, the 12px muted
 *            subtitle under it, and a 40px "…" menu at the end
 *   editing  a dashed strong border with shadow-1, a drag handle, and 40px
 *            controls: earlier, later, the width (S/M/L/XL, desktop only) and
 *            remove; a corner grip resizes by dragging (desktop only)
 */

const SPAN_CLASS: Readonly<Record<Span, string>> = {
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
};

const CONTROL = 'flex size-10 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-focus';

export interface WidgetEditProps {
  readonly first: boolean;
  readonly last: boolean;
  readonly dragging: boolean;
  readonly over: boolean;
  readonly onEarlier: () => void;
  readonly onLater: () => void;
  readonly onCycle: () => void;
  readonly onRemove: () => void;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function WidgetCard({
  t,
  type,
  icon,
  title,
  subtitle,
  span,
  edit,
  onCustomise,
  onRemove,
  children,
}: {
  t: Translator;
  type: WidgetType;
  icon: IconName;
  title: string;
  subtitle: string;
  span: Span;
  /** Customise mode's controls, or `undefined` outside it. */
  edit: WidgetEditProps | undefined;
  onCustomise: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const editing = edit !== undefined;
  return (
    <section
      aria-label={title}
      data-widget={type}
      draggable={editing}
      onDragStart={edit?.onDragStart}
      onDragOver={edit?.onDragOver}
      onDrop={edit?.onDrop}
      onDragEnd={edit?.onDragEnd}
      className={`relative col-span-1 flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-3.5 md:px-4.5 md:py-4 ${SPAN_CLASS[span]} ${
        editing ? 'border-dashed border-border-strong' : 'border-border'
      } ${edit?.over === true ? 'shadow-1 ring ring-primary' : editing ? 'shadow-1' : ''} ${edit?.dragging === true ? 'opacity-40' : ''}`}
    >
      <div className="flex min-h-10 items-start gap-2">
        {editing ? (
          <span aria-hidden="true" className="hidden cursor-grab pt-0.5 text-text-muted md:inline-flex">
            <Icon name="drag_indicator" size={22} />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="m-0 flex items-center gap-1.5 text-card-title">
            <span className="flex shrink-0 text-primary-text">
              <Icon name={icon} size={18} />
            </span>
            <span className="min-w-0">{title}</span>
          </h2>
          <span className="text-caption font-normal text-text-muted">{subtitle}</span>
        </div>
        {edit === undefined ? (
          <Menu
            align="end"
            aria-label={t.t('home.widget.options')}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                aria-label={t.t('home.widget.options')}
                className={`${CONTROL} -me-1.5 -mt-1 text-text-2 is-hover:bg-surface-sunken`}
              >
                <Icon name="more_horiz" size={20} />
              </button>
            )}
            panelClassName="w-56"
          >
            <MenuItem icon="dashboard_customize" onSelect={onCustomise}>
              {t.t('home.widget.menu.customise')}
            </MenuItem>
            <MenuItem icon="close" tone="danger" onSelect={onRemove}>
              {t.t('home.widget.menu.remove')}
            </MenuItem>
          </Menu>
        ) : (
          <div className="-me-1.5 -mt-1 flex gap-0.5">
            <button
              type="button"
              disabled={edit.first}
              aria-label={t.t('home.widget.moveEarlier', { title })}
              onClick={edit.onEarlier}
              className={`${CONTROL} bg-surface-sunken text-text disabled:text-disabled-text`}
            >
              <span className="flex md:hidden">
                <Icon name="arrow_upward" size={20} />
              </span>
              <span className="hidden md:flex rtl:-scale-x-100">
                <Icon name="arrow_back" size={20} />
              </span>
            </button>
            <button
              type="button"
              disabled={edit.last}
              aria-label={t.t('home.widget.moveLater', { title })}
              onClick={edit.onLater}
              className={`${CONTROL} bg-surface-sunken text-text disabled:text-disabled-text`}
            >
              <span className="flex md:hidden">
                <Icon name="arrow_downward" size={20} />
              </span>
              <span className="hidden md:flex rtl:-scale-x-100">
                <Icon name="arrow_forward" size={20} />
              </span>
            </button>
            <button
              type="button"
              aria-label={t.t('home.widget.width', { size: t.t(SPAN_IDS[span].name) })}
              onClick={edit.onCycle}
              className="hidden h-10 items-center rounded-md bg-surface-sunken px-2.5 font-mono text-caption font-semibold text-text outline-none focus-visible:ring-focus md:flex"
            >
              {t.t(SPAN_IDS[span].short)}
            </button>
            <button
              type="button"
              aria-label={t.t('home.widget.remove', { title })}
              onClick={edit.onRemove}
              className={`${CONTROL} bg-danger-soft text-danger-text`}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        )}
      </div>
      {children}
      {editing ? (
        <span
          role="separator"
          aria-label={t.t('home.widget.resize')}
          onPointerDown={edit.onResizeStart}
          className="absolute bottom-0.5 end-0.5 hidden size-6 cursor-ew-resize touch-none items-end justify-end text-text-muted md:flex"
        >
          <span className="flex rotate-90 rtl:-rotate-180">
            <Icon name="signal_cellular_4_bar" size={20} />
          </span>
        </span>
      ) : null}
    </section>
  );
}

/**
 * The design's widget empty state (P03 frames 28 and 30): a 44px sunken disc
 * with a 24px glyph, a 15/700 title, one 14/21 line, then the action.
 */
export function WidgetEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 pb-1 pt-2">
      <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-full bg-surface-sunken text-text-2">
        <Icon name={icon} size={24} />
      </span>
      <b className="text-label font-bold">{title}</b>
      <span className="text-pretty text-body-relaxed text-text-2">{body}</span>
      {action}
    </div>
  );
}

/** A widget's own failure: say so, and offer to read it again. */
export function WidgetError({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <WidgetEmpty
      icon="cloud_off"
      title={t.t('home.widget.error.title')}
      body={t.t('home.widget.error.body')}
      action={<Button onClick={onRetry}>{t.t('home.widget.error.retry')}</Button>}
    />
  );
}

/**
 * The design's loading skeleton (P03 frames 29 and 31): a 28px block at 40%,
 * two 12px lines at 85% and 70%, then an 80px block (120px for L and XL).
 * The header stays live above it. After 8s on a slow link it says so, in a
 * polite live region: the 256 kbps NFR made visible.
 */
export function WidgetSkeleton({ t, title, tall }: { t: Translator; title: string; tall: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOADING_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col">
      <div role="progressbar" aria-busy="true" aria-label={t.t('home.widget.loading', { title })} className="flex flex-col gap-2.5">
        <span className="block h-7 w-2/5 rounded-6 bg-surface-sunken" />
        <span className="block h-3 w-[85%] rounded-sm bg-surface-sunken" />
        <span className="block h-3 w-[70%] rounded-sm bg-surface-sunken" />
        <span className={`block rounded-md bg-surface-sunken ${tall ? 'h-layout-home-skeleton-tall' : 'h-20'}`} />
      </div>
      <p role="status" className={`m-0 text-meta text-text-muted ${slow ? 'mt-2.5' : ''}`}>
        {slow ? t.t('home.widget.slow') : null}
      </p>
    </div>
  );
}
