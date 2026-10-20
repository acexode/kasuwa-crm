import type { MessageId } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';

/**
 * P03 Home's widgets, role layouts and layout operations (T-0132, D-L196),
 * transcribed from `docs/design/P03/Kasuwa Home Dashboards.html` (its `W`,
 * `DEF` and `SUG` tables).
 *
 * No `'use client'`: pure data and functions, read by the server page (for the
 * message ids) and the client screen alike.
 *
 * WHERE THE DATA COMES FROM. Three widgets read real data through the existing
 * scoped APIs: Today's agenda (the activities calendar), Deals needing attention
 * (the pipelines and deals API). Every other widget belongs to a module that is
 * not built yet, so it is drawn in the design's own empty state behind its
 * module's flag and never with a number, a name or a total (D-L194). A widget
 * whose source is off in this process is neither drawn nor offered.
 */

export const WIDGET_TYPES = [
  'nba',
  'agenda',
  'deals',
  'quota',
  'wa',
  'pipeline',
  'forecast',
  'leader',
  'approvals',
  'tickets',
  'queues',
  'csat',
  'programme',
  'schedule',
  'news',
  'revenue',
  'cost',
  'profit',
  'sla',
  'ai',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** What a widget needs to be drawn: a live screen for the real ones, a placeholder flag for the rest. */
export type WidgetSource = 'activities' | 'deals' | 'aiNba' | 'whatsapp' | 'quota' | 'approvals' | 'kpis';

/** The widths the design offers: S, M, L and XL of a 12-column grid. */
export const SPANS = [4, 6, 8, 12] as const;
export type Span = (typeof SPANS)[number];

export type HomeRole = 'rep' | 'manager' | 'support' | 'bpo' | 'exec';

/** The subtitle: a fixed line, the selected period, or computed by the widget. */
type Subtitle = 'fixed' | 'range' | 'quarter' | 'live';

export interface WidgetSpec {
  readonly icon: IconName;
  readonly source: WidgetSource;
  readonly subtitle: Subtitle;
  /** The empty state's glyph. */
  readonly emptyIcon: IconName;
  /** The empty state has a call to action (drawn disabled: its module is not built). */
  readonly cta: boolean;
}

export const WIDGETS: Readonly<Record<WidgetType, WidgetSpec>> = {
  nba: { icon: 'auto_awesome', source: 'aiNba', subtitle: 'fixed', emptyIcon: 'auto_awesome', cta: false },
  agenda: { icon: 'today', source: 'activities', subtitle: 'live', emptyIcon: 'event', cta: false },
  deals: { icon: 'priority_high', source: 'deals', subtitle: 'fixed', emptyIcon: 'handshake', cta: true },
  quota: { icon: 'target', source: 'quota', subtitle: 'quarter', emptyIcon: 'target', cta: false },
  wa: { icon: 'chat', source: 'whatsapp', subtitle: 'fixed', emptyIcon: 'chat', cta: true },
  pipeline: { icon: 'view_kanban', source: 'kpis', subtitle: 'range', emptyIcon: 'view_kanban', cta: true },
  forecast: { icon: 'insights', source: 'quota', subtitle: 'quarter', emptyIcon: 'insights', cta: true },
  leader: { icon: 'leaderboard', source: 'quota', subtitle: 'range', emptyIcon: 'leaderboard', cta: false },
  approvals: { icon: 'approval', source: 'approvals', subtitle: 'fixed', emptyIcon: 'task_alt', cta: false },
  tickets: { icon: 'confirmation_number', source: 'kpis', subtitle: 'fixed', emptyIcon: 'inbox', cta: false },
  queues: { icon: 'groups', source: 'kpis', subtitle: 'fixed', emptyIcon: 'groups', cta: false },
  csat: { icon: 'sentiment_satisfied', source: 'kpis', subtitle: 'range', emptyIcon: 'sentiment_satisfied', cta: true },
  programme: { icon: 'badge', source: 'kpis', subtitle: 'fixed', emptyIcon: 'badge', cta: false },
  schedule: { icon: 'schedule', source: 'kpis', subtitle: 'fixed', emptyIcon: 'schedule', cta: false },
  news: { icon: 'campaign', source: 'kpis', subtitle: 'fixed', emptyIcon: 'campaign', cta: false },
  revenue: { icon: 'payments', source: 'kpis', subtitle: 'range', emptyIcon: 'payments', cta: true },
  cost: { icon: 'savings', source: 'kpis', subtitle: 'range', emptyIcon: 'savings', cta: true },
  profit: { icon: 'account_balance', source: 'kpis', subtitle: 'range', emptyIcon: 'account_balance', cta: true },
  sla: { icon: 'verified', source: 'kpis', subtitle: 'range', emptyIcon: 'verified', cta: true },
  ai: { icon: 'auto_awesome', source: 'aiNba', subtitle: 'range', emptyIcon: 'auto_awesome', cta: true },
};

/** The design's default layout per role (`DEF`). */
export const ROLE_LAYOUTS: Readonly<Record<HomeRole, readonly LayoutItem[]>> = {
  rep: [
    { type: 'nba', span: 12 },
    { type: 'agenda', span: 6 },
    { type: 'deals', span: 6 },
    { type: 'wa', span: 8 },
    { type: 'quota', span: 4 },
  ],
  manager: [
    { type: 'forecast', span: 8 },
    { type: 'approvals', span: 4 },
    { type: 'pipeline', span: 6 },
    { type: 'leader', span: 6 },
  ],
  support: [
    { type: 'tickets', span: 8 },
    { type: 'queues', span: 4 },
    { type: 'csat', span: 12 },
  ],
  bpo: [
    { type: 'programme', span: 12 },
    { type: 'schedule', span: 8 },
    { type: 'news', span: 4 },
  ],
  exec: [
    { type: 'revenue', span: 4 },
    { type: 'cost', span: 8 },
    { type: 'profit', span: 8 },
    { type: 'ai', span: 4 },
    { type: 'sla', span: 12 },
  ],
};

/** The Add-widget drawer's "Suggested for …" beyond the role's own defaults (`SUG`). */
const ROLE_SUGGESTIONS: Readonly<Record<HomeRole, readonly WidgetType[]>> = {
  rep: ['leader', 'csat'],
  manager: ['deals', 'quota', 'wa'],
  support: ['wa', 'news'],
  bpo: ['queues', 'csat'],
  exec: ['forecast', 'pipeline'],
};

/**
 * The bottom bar's two object slots on Home (P03 at 360): Tickets and Calls
 * for the agents who live in them, Deals and Calls for everyone else.
 */
export function roleBottomObjects(role: HomeRole): readonly string[] {
  return role === 'support' || role === 'bpo' ? ['tickets', 'calls'] : ['deals', 'calls'];
}

/**
 * The role a layout is chosen by. The session does not carry one (getCurrentUser
 * is identity only, and scope never travels to the client as a fact), so today
 * every user starts from the sales-rep layout, as T-0132 rules. Customise mode
 * reaches every other widget.
 */
export function layoutRole(): HomeRole {
  return 'rep';
}

export interface LayoutItem {
  readonly type: WidgetType;
  readonly span: Span;
}

export type Layout = readonly LayoutItem[];

/** Which widget sources are live in this process (route flags and D-L194 placeholder flags). */
export type LiveSources = Readonly<Record<WidgetSource, boolean>>;

export function available(type: WidgetType, sources: LiveSources): boolean {
  return sources[WIDGETS[type].source];
}

/** A layout with only what this process can draw, each type once. */
export function drawable(layout: Layout, sources: LiveSources): Layout {
  const seen = new Set<WidgetType>();
  return layout.filter((item) => {
    if (seen.has(item.type) || !available(item.type, sources)) return false;
    seen.add(item.type);
    return true;
  });
}

export function defaultLayout(role: HomeRole, sources: LiveSources): Layout {
  return drawable(ROLE_LAYOUTS[role], sources);
}

/** Swaps the widget at `index` with its neighbour in `direction` (-1 earlier, 1 later). */
export function move(layout: Layout, index: number, direction: -1 | 1): Layout {
  const target = index + direction;
  const a = layout[index];
  const b = layout[target];
  if (a === undefined || b === undefined) return layout;
  const next = [...layout];
  next[index] = b;
  next[target] = a;
  return next;
}

/** Moves `from` to just before `to` (a drop on another card). */
export function moveBefore(layout: Layout, from: WidgetType, to: WidgetType): Layout {
  if (from === to) return layout;
  const source = layout.find((item) => item.type === from);
  if (source === undefined) return layout;
  const rest = layout.filter((item) => item.type !== from);
  const at = rest.findIndex((item) => item.type === to);
  if (at === -1) return layout;
  return [...rest.slice(0, at), source, ...rest.slice(at)];
}

/** S → M → L → XL → S, as the design's width button cycles. */
export function nextSpan(span: Span): Span {
  return span === 4 ? 6 : span === 6 ? 8 : span === 8 ? 12 : 4;
}

export function resize(layout: Layout, type: WidgetType, span: Span): Layout {
  return layout.map((item) => (item.type === type ? { ...item, span } : item));
}

/** The span nearest `columns` (a corner drag). */
export function snapSpan(columns: number): Span {
  return SPANS.reduce<Span>((best, span) => (Math.abs(span - columns) < Math.abs(best - columns) ? span : best), 4);
}

export function remove(layout: Layout, type: WidgetType): Layout {
  return layout.filter((item) => item.type !== type);
}

/** A new widget goes last: full width for the wide ones, M otherwise (the design's `addItem`). */
export function add(layout: Layout, type: WidgetType): Layout {
  if (layout.some((item) => item.type === type)) return layout;
  const span: Span = type === 'nba' || type === 'sla' || type === 'csat' || type === 'programme' ? 12 : 6;
  return [...layout, { type, span }];
}

/** The drawer's two lists: the role's own and suggested widgets not on Home, then every other one. */
export function addable(role: HomeRole, layout: Layout, sources: LiveSources): { suggested: WidgetType[]; more: WidgetType[] } {
  const active = new Set(layout.map((item) => item.type));
  const suggested = [...ROLE_LAYOUTS[role].map((item) => item.type), ...ROLE_SUGGESTIONS[role]].filter(
    (type, index, all) => !active.has(type) && all.indexOf(type) === index && available(type, sources),
  );
  const more = WIDGET_TYPES.filter((type) => !active.has(type) && !suggested.includes(type) && available(type, sources));
  return { suggested, more };
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

export const SPAN_IDS: Readonly<Record<Span, { short: MessageId; name: MessageId }>> = {
  4: { short: 'home.widget.size.s', name: 'home.widget.size.small' },
  6: { short: 'home.widget.size.m', name: 'home.widget.size.medium' },
  8: { short: 'home.widget.size.l', name: 'home.widget.size.large' },
  12: { short: 'home.widget.size.xl', name: 'home.widget.size.full' },
};

export function widgetTitle(type: WidgetType): MessageId {
  return `home.w.${type}.title` as MessageId;
}

export function widgetDescription(type: WidgetType): MessageId {
  return `home.w.${type}.desc` as MessageId;
}

/** A fixed subtitle's id; `range` and `quarter` subtitles are computed. */
export function widgetSubtitle(type: WidgetType): MessageId {
  return `home.w.${type}.sub` as MessageId;
}

export function emptyTitle(type: WidgetType): MessageId {
  return `home.w.${type}.empty.title` as MessageId;
}

export function emptyBody(type: WidgetType): MessageId {
  return `home.w.${type}.empty.body` as MessageId;
}

export function emptyCta(type: WidgetType): MessageId {
  return `home.w.${type}.empty.cta` as MessageId;
}

export const RANGES = ['today', 'week', 'month', 'quarter'] as const;
export type Range = (typeof RANGES)[number];

export const ROLES: readonly HomeRole[] = ['rep', 'manager', 'support', 'bpo', 'exec'];

/** Every id P03 may draw, for the server page's bundle. */
export function homeWidgetMessageIds(): MessageId[] {
  return WIDGET_TYPES.flatMap((type) => {
    const spec = WIDGETS[type];
    return [
      widgetTitle(type),
      widgetDescription(type),
      ...(spec.subtitle === 'fixed' || spec.subtitle === 'quarter' ? [widgetSubtitle(type)] : []),
      emptyTitle(type),
      emptyBody(type),
      ...(spec.cta ? [emptyCta(type)] : []),
    ];
  });
}
