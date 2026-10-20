'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button, SegmentedControl } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { useLiteMode } from '../auth/lite-mode';
import { CrmShell } from '../crm/crm-shell';
import { AccountMenu } from '../shell/account-menu';
import { ShellLiteToggle } from '../shell/shell-parts';
import { AddWidgetPanel } from './add-widget-panel';
import { AgendaWidget } from './agenda-widget';
import { DealsWidget } from './deals-widget';
import { currencyLabel, firstName, formatClock, formatDay, greetingId, quarterOf, zoneName } from './home-format';
import {
  RANGES,
  WIDGETS,
  add,
  addable,
  defaultLayout,
  drawable,
  emptyBody,
  emptyCta,
  emptyTitle,
  layoutRole,
  move,
  moveBefore,
  nextSpan,
  remove,
  resize,
  roleBottomObjects,
  snapSpan,
  widgetSubtitle,
  widgetTitle,
  type Layout,
  type LiveSources,
  type Range,
  type Span,
  type WidgetType,
} from './home-model';
import { browserLayoutStore } from './layout-store';
import { useHomeData, type HomeData } from './use-home-data';
import { WidgetCard, WidgetEmpty, WidgetError, WidgetSkeleton, type WidgetEditProps } from './widget-card';

/**
 * P03 — Home (T-0132, D-L196, `docs/design/P03/Kasuwa Home Dashboards.html`).
 *
 * ---------------------------------------------------------------------------
 * THE HEADER. "Good morning, {first name}" at 28/800 (22 on a phone), the day
 * and the time in the browser's zone with its name ("10:12 WAT"), then the
 * period control, the currency control (`fx_display`: ₦ selected, US$ drawn
 * disabled until FX exists, D-L69) and Customise.
 *
 * THE GRID. Twelve columns from `md` up, widgets at S, M, L or XL (4, 6, 8, 12
 * columns); one column on a phone. The layout is the sales-rep default until
 * the session can say a role (`layoutRole()`), and a person's own layout once
 * they customise it, kept by `layout-store.ts` under their user id.
 *
 * DATA. Today's agenda and Deals needing attention read the activities and
 * deals APIs, scoped by the session (`use-home-data.ts`). Every other widget
 * is its module's placeholder (D-L194): the design's own empty state, never a
 * number or a name, and not drawn at all where its flag is off.
 *
 * CUSTOMISE MODE (frames 21 to 23). The primary banner with Reset and Done;
 * dashed cards with earlier/later, the S/M/L/XL width and remove; drag a card
 * onto another to reorder and its corner to resize (desktop), or press S, M,
 * L or X on a focused card; a dashed "Add widget" tile opens the drawer
 * (the bottom sheet on a phone).
 *
 * OTHER STATES. Lite mode's strip (frame 24); the new-workspace welcome
 * (frame 28) when there is nothing yet to show; per-widget skeletons while the
 * data widgets load, with the header live (frame 29).
 * ---------------------------------------------------------------------------
 */

export interface HomeFlags {
  readonly aiNba: boolean;
  readonly whatsapp: boolean;
  readonly quota: boolean;
  readonly approvals: boolean;
  readonly kpis: boolean;
  readonly fx: boolean;
  readonly calendar: boolean;
}

const RANGE_LABEL: Readonly<Record<Range, { long: MessageId; short: MessageId; sub: MessageId }>> = {
  today: { long: 'home.range.today', short: 'home.range.today', sub: 'home.range.sub.today' },
  week: { long: 'home.range.week', short: 'home.range.week.short', sub: 'home.range.sub.week' },
  month: { long: 'home.range.month', short: 'home.range.month.short', sub: 'home.range.sub.month' },
  quarter: { long: 'home.range.quarter', short: 'home.range.quarter.short', sub: 'home.range.sub.quarter' },
};

const KEY_SPAN: Readonly<Record<string, Span>> = { s: 4, m: 6, l: 8, x: 12 };

/** "Your Home is empty. Use **Add widget** to choose what you see first." */
function EmptyHome({ t }: { t: Translator }) {
  const marker = '\u0000';
  const [before = '', after = ''] = t.t('home.empty', { add: marker }).split(marker);
  return (
    <p className="m-0 text-body-sm text-text-2">
      {before}
      <b>{t.t('home.add.tile')}</b>
      {after}
    </p>
  );
}

export function HomeScreen({
  locale,
  messages,
  locales,
  live,
  flags,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`). */
  live: readonly string[];
  flags: HomeFlags;
}) {
  const t = createBundleTranslator(locale, messages);
  const { lite } = useLiteMode();
  const role = layoutRole();
  const sources: LiveSources = useMemo(
    () => ({
      activities: live.includes('activities'),
      deals: live.includes('deals'),
      aiNba: flags.aiNba,
      whatsapp: flags.whatsapp,
      quota: flags.quota,
      approvals: flags.approvals,
      kpis: flags.kpis,
    }),
    [live, flags],
  );
  const data = useHomeData({ agendaLive: sources.activities, dealsLive: sources.deals });
  const userId = data.me?.id ?? null;

  const [layout, setLayout] = useState<Layout>(() => defaultLayout(role, sources));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [range, setRange] = useState<Range>('week');
  const [dragId, setDragId] = useState<WidgetType | null>(null);
  const [overId, setOverId] = useState<WidgetType | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const addTileRef = useRef<HTMLButtonElement>(null);

  // The person's own layout, once we know who they are.
  useEffect(() => {
    if (userId === null) return undefined;
    let current = true;
    void browserLayoutStore.load(userId, role).then((saved) => {
      if (current && saved !== null) setLayout(drawable(saved, sources));
    });
    return () => {
      current = false;
    };
  }, [userId, role, sources]);

  const commit = useCallback(
    (next: Layout) => {
      setLayout(next);
      if (userId !== null) void browserLayoutStore.save(userId, role, next);
    },
    [userId, role],
  );

  const reset = useCallback(() => {
    setLayout(defaultLayout(role, sources));
    if (userId !== null) void browserLayoutStore.clear(userId, role);
  }, [role, sources, userId]);

  const startResize = useCallback(
    (type: WidgetType, span: Span) => (event: ReactPointerEvent<HTMLElement>) => {
      const card = event.currentTarget.closest('section');
      const grid = gridRef.current;
      if (card === null || grid === null) return;
      event.preventDefault();
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      const column = (grid.clientWidth + gap) / 12;
      const startWidth = card.getBoundingClientRect().width;
      const startX = event.clientX;
      const rtl = getComputedStyle(grid).direction === 'rtl';
      let last = span;
      const onMove = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) * (rtl ? -1 : 1);
        const snapped = snapSpan((startWidth + delta + gap) / column);
        if (snapped !== last) {
          last = snapped;
          setLayout((current) => resize(current, type, snapped));
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setLayout((current) => {
          if (userId !== null) void browserLayoutStore.save(userId, role, current);
          return current;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [role, userId],
  );

  const now = data.now;
  const name = data.me === null ? null : firstName(data.me.displayName);
  const greeting = now === null ? '' : t.t(greetingId(now, name !== null && name !== ''), name === null ? {} : { name });
  const zone = now === null ? '' : zoneName(locale, now);
  const dateLine = (short: boolean) =>
    now === null ? '' : t.t('home.dateLine', { day: formatDay(locale, now, short), time: formatClock(locale, now), zone });

  const { suggested, more } = addable(role, layout, sources);

  const subtitle = (type: WidgetType): string => {
    const spec = WIDGETS[type];
    if (spec.subtitle === 'fixed') return t.t(widgetSubtitle(type));
    if (spec.subtitle === 'range') return t.t(RANGE_LABEL[range].sub);
    if (spec.subtitle === 'quarter') {
      return now === null ? '' : t.t(widgetSubtitle(type), { quarter: quarterOf(now), year: now.getFullYear() });
    }
    // The agenda: its count once read, and the day.
    const day = now === null ? '' : formatDay(locale, now, true);
    return data.agenda.phase === 'ready' && data.agenda.value.length > 0
      ? t.t('home.agenda.sub', { count: data.agenda.value.length, day })
      : day;
  };

  const editProps = (type: WidgetType, index: number, span: Span): WidgetEditProps => ({
    first: index === 0,
    last: index === layout.length - 1,
    dragging: dragId === type,
    over: overId === type && dragId !== null && dragId !== type,
    onEarlier: () => commit(move(layout, index, -1)),
    onLater: () => commit(move(layout, index, 1)),
    onCycle: () => commit(resize(layout, type, nextSpan(span))),
    onRemove: () => {
      commit(remove(layout, type));
      addTileRef.current?.focus();
    },
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', type);
      setDragId(type);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragId === null) return;
      event.preventDefault();
      if (overId !== type) setOverId(type);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const from = dragId;
      setDragId(null);
      setOverId(null);
      if (from !== null) commit(moveBefore(layout, from, type));
    },
    onDragEnd: () => {
      setDragId(null);
      setOverId(null);
    },
    onResizeStart: startResize(type, span),
  });

  const onCardKey = (type: WidgetType) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const span = KEY_SPAN[event.key.toLowerCase()];
    if (span === undefined) return;
    event.preventDefault();
    commit(resize(layout, type, span));
  };

  const appBar = {
    title: t.t('records.nav.home'),
    brand: true,
    actions: (
      <div className="flex items-center gap-2 pe-3">
        <ShellLiteToggle t={t} compact />
        <AccountMenu t={t} locale={locale} locales={locales} withLite={false} />
      </div>
    ),
  };

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="home"
      live={live}
      appBar={appBar}
      bottomObjects={roleBottomObjects(role)}
    >
      <div data-screen="P03" className="flex max-w-layout-home-max flex-col gap-4 md:gap-5 md:px-2 md:pb-4 md:pt-1">
        {editing ? (
          <div
            role="status"
            data-testid="home-customising"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-10 bg-primary py-2.5 pe-2.5 ps-4 text-on-primary"
          >
            <Icon name="dashboard_customize" size={20} />
            <span className="min-w-0 flex-[1_1_200px] text-body-sm">
              <b>{t.t('home.edit.title')}</b>{' '}
              <span className="md:hidden">{t.t('home.edit.hint.phone')}</span>
              <span className="hidden md:inline">{t.t('home.edit.hint.desktop')}</span>
            </span>
            <button
              type="button"
              onClick={reset}
              className="h-10 rounded-md border border-on-primary bg-transparent px-3 text-body-sm font-semibold outline-none focus-visible:ring-focus"
            >
              {t.t('home.edit.reset')}
            </button>
            <button
              type="button"
              data-testid="home-customise-done"
              onClick={() => {
                setEditing(false);
                setAdding(false);
              }}
              className="h-10 rounded-md bg-accent px-4 text-body-sm font-bold text-on-accent outline-none focus-visible:ring-focus"
            >
              {t.t('home.edit.done')}
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
            <h1 className="m-0 min-h-7 text-title-phone md:min-h-9 md:text-title">{greeting}</h1>
            <span className="min-h-5 text-body-sm text-text-2">
              <span className="md:hidden">{dateLine(true)}</span>
              <span className="hidden md:inline">{dateLine(false)}</span>
            </span>
          </div>
          <SegmentedControl
            aria-label={t.t('home.range.label')}
            value={range}
            onValueChange={(value) => {
              const next = RANGES.find((option) => option === value);
              if (next !== undefined) setRange(next);
            }}
            options={RANGES.map((option) => ({
              value: option,
              label: (
                <>
                  <span className="md:hidden">{t.t(RANGE_LABEL[option].short)}</span>
                  <span className="hidden md:inline">{t.t(RANGE_LABEL[option].long)}</span>
                </>
              ),
            }))}
          />
          {flags.fx ? (
            <SegmentedControl
              aria-label={t.t('home.currency.label')}
              value="NGN"
              className="[&>button]:font-bold"
              options={[
                { value: 'NGN', label: currencyLabel(locale, 'NGN') },
                { value: 'USD', label: currencyLabel(locale, 'USD'), disabled: true },
              ]}
            />
          ) : null}
          {editing ? null : (
            <Button icon="dashboard_customize" aria-label={t.t('home.customise.label')} onClick={() => setEditing(true)} data-testid="home-customise">
              <span className="hidden md:inline">{t.t('home.customise')}</span>
            </Button>
          )}
        </div>

        {lite ? (
          <div role="status" className="flex items-center gap-2.5 rounded-10 bg-accent-soft px-3.5 py-2.5 text-meta text-accent-text">
            <Icon name="network_check" size={18} />
            <span>
              <b>{t.t('home.lite.title')}</b> {t.t('home.lite.body')}
            </span>
          </div>
        ) : null}

        {data.nothingYet && !editing ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-lg border border-primary bg-primary-soft p-5">
            <div className="flex flex-[1_1_280px] flex-col gap-1.5">
              <b className="text-h5 font-bold">
                {name === null || name === '' ? t.t('home.welcome.titleAnon') : t.t('home.welcome.title', { name })}
              </b>
              <span className="text-body-relaxed text-text-2">{t.t('home.welcome.body')}</span>
            </div>
          </div>
        ) : null}

        <div ref={gridRef} className="grid grid-cols-1 items-start gap-4 md:grid-cols-12">
          {layout.map((item, index) => {
            const spec = WIDGETS[item.type];
            const title = t.t(widgetTitle(item.type));
            return (
              <div key={item.type} className="contents" onKeyDown={onCardKey(item.type)}>
                <WidgetCard
                  t={t}
                  type={item.type}
                  icon={spec.icon}
                  title={title}
                  subtitle={subtitle(item.type)}
                  span={item.span}
                  edit={editing ? editProps(item.type, index, item.span) : undefined}
                  onCustomise={() => setEditing(true)}
                  onRemove={() => commit(remove(layout, item.type))}
                >
                  <WidgetBody
                    t={t}
                    locale={locale}
                    type={item.type}
                    title={title}
                    span={item.span}
                    data={data}
                    live={live}
                    calendar={flags.calendar}
                  />
                </WidgetCard>
              </div>
            );
          })}
          {editing ? (
            <button
              ref={addTileRef}
              type="button"
              aria-haspopup="dialog"
              data-testid="home-add-widget"
              onClick={() => setAdding(true)}
              className="col-span-1 flex min-h-layout-home-add-tile flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border-strong bg-transparent text-label font-bold text-primary-text outline-none is-hover:bg-primary-soft focus-visible:ring-focus md:col-span-4"
            >
              <Icon name="add" size={28} />
              {t.t('home.add.tile')}
            </button>
          ) : null}
        </div>
        {layout.length === 0 ? <EmptyHome t={t} /> : null}
      </div>

      <AddWidgetPanel
        t={t}
        open={editing && adding}
        role={role}
        suggested={suggested}
        more={more}
        onAdd={(type) => commit(add(layout, type))}
        onClose={() => setAdding(false)}
      />
    </CrmShell>
  );
}

/** What a widget draws under its header: real data for the agenda and deals, the module's empty state otherwise. */
function WidgetBody({
  t,
  locale,
  type,
  title,
  span,
  data,
  live,
  calendar,
}: {
  t: Translator;
  locale: string;
  type: WidgetType;
  title: string;
  span: Span;
  data: HomeData;
  live: readonly string[];
  /** `calendar_sync` (T-0136): the design's "Connect calendar" empty state, its action disabled (D-P22). */
  calendar: boolean;
}) {
  const tall = span >= 8;
  const now = data.now;
  if (type === 'agenda') {
    if (data.agenda.phase === 'loading' || now === null) return <WidgetSkeleton t={t} title={title} tall={tall} />;
    if (data.agenda.phase === 'error') return <WidgetError t={t} onRetry={data.retryAgenda} />;
    if (data.agenda.value.length === 0) {
      return calendar ? (
        <WidgetEmpty
          icon={WIDGETS.agenda.emptyIcon}
          title={t.t(emptyTitle(type))}
          body={t.t('home.w.agenda.empty.bodyCalendar')}
          action={
            <Button disabled className="!h-control-base !px-3.5 !text-body-sm !font-semibold">
              {t.t('home.w.agenda.empty.cta')}
            </Button>
          }
        />
      ) : (
        <WidgetEmpty icon={WIDGETS.agenda.emptyIcon} title={t.t(emptyTitle(type))} body={t.t(emptyBody(type))} />
      );
    }
    return (
      <AgendaWidget
        t={t}
        locale={locale}
        items={data.agenda.value}
        now={now}
        busy={data.busy}
        done={data.done}
        activitiesLive={live.includes('activities')}
        onComplete={data.complete}
      />
    );
  }
  if (type === 'deals') {
    if (data.deals.phase === 'loading' || now === null) return <WidgetSkeleton t={t} title={title} tall={tall} />;
    if (data.deals.phase === 'error') return <WidgetError t={t} onRetry={data.retryDeals} />;
    if (data.deals.value.attention.length === 0) {
      return data.deals.value.anyOwned ? (
        <WidgetEmpty icon="task_alt" title={t.t('home.deals.clear.title')} body={t.t('home.deals.clear.body')} />
      ) : (
        <WidgetEmpty
          icon={WIDGETS.deals.emptyIcon}
          title={t.t(emptyTitle(type))}
          body={t.t(emptyBody(type))}
          action={
            live.includes('deals') ? (
              <Link
                href="/pipelines"
                className="inline-flex h-control-base items-center rounded-md border border-border-strong bg-surface px-3.5 text-body-sm font-semibold text-text outline-none is-hover:bg-surface-sunken focus-visible:ring-focus"
              >
                {t.t(emptyCta(type))}
              </Link>
            ) : undefined
          }
        />
      );
    }
    return <DealsWidget t={t} locale={locale} rows={data.deals.value.attention} now={now} dealsLive={live.includes('deals')} />;
  }
  // A module that is not built yet (D-L194): its own empty state, its action drawn disabled.
  const spec = WIDGETS[type];
  return (
    <WidgetEmpty
      icon={spec.emptyIcon}
      title={t.t(emptyTitle(type))}
      body={t.t(emptyBody(type))}
      action={
        spec.cta ? (
          <Button disabled className="!h-control-base !px-3.5 !text-body-sm !font-semibold">
            {t.t(emptyCta(type))}
          </Button>
        ) : undefined
      }
    />
  );
}
