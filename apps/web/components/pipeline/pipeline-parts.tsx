import type { Translator } from '@kasuwa/i18n/bundle';
import { initials } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { formatSyncedAt } from '../records/list-model';
import { UnreadableAmountError, formatDealMoney, formatDealMoneyCompact, formatDealMoneyWhole } from '../../lib/deal-money';
import { withheld, type Deal, type DealMoney, type PipelineStage } from '../../lib/pipelines-api';
import { formatCalendarDate, formatShortDate } from './pipeline-model';

/**
 * The pieces the P06 board, list and dialogs draw the same way (T-0109): an
 * exact amount, a lock, an owner, a close date and the offline banner. One
 * copy, so a lock or a former owner reads the same on a card and in a row.
 */

/** How an amount is drawn: exact to the minor unit, whole units, or the design's short form ("₦40M"). */
export type MoneyShape = 'exact' | 'whole' | 'compact';

const MONEY_FORMAT: Record<MoneyShape, (locale: string, amountMinor: string, currency: string) => string> = {
  exact: formatDealMoney,
  whole: formatDealMoneyWhole,
  compact: formatDealMoneyCompact,
};

/**
 * An amount in its currency's own format, with Intl's narrow symbol (R5,
 * T-0135). The digits come from the string, never a number (the compact form
 * excepted, which is a label); an amount that is not a digit run is said to be
 * unreadable, never drawn as a zero. JetBrains Mono, as P06 draws money.
 */
export function Money({
  t,
  locale,
  money,
  kind,
  shape = 'exact',
  className = '',
}: {
  t: Translator;
  locale: string;
  money: DealMoney;
  kind?: 'amount' | 'weighted';
  shape?: MoneyShape;
  className?: string;
}) {
  let text: string;
  try {
    text = MONEY_FORMAT[shape](locale, money.amountMinor, money.currency);
  } catch (error) {
    if (!(error instanceof UnreadableAmountError)) throw error;
    return (
      <span data-money={kind} data-unreadable="true" className="text-danger-text">
        {t.t('pipeline.money.unreadable')}
      </span>
    );
  }
  return (
    <span data-money={kind} className={`whitespace-nowrap font-mono tabular-nums ${className}`}>
      {text}
    </span>
  );
}

/**
 * A withheld value: a lock and "Restricted". Never a blank and never a zero —
 * a lock says the value exists and this role cannot see it (R5, R6).
 */
export function Locked({ t }: { t: Translator }) {
  return (
    <span className="inline-flex items-center gap-1 text-text-2">
      <Icon name="lock" size="sm" />
      {t.t('records.locked')}
    </span>
  );
}

/** The amount, a lock, or "No amount" — a deal with no amount is not a zero (R5). */
export function AmountValue({ t, locale, deal, shape = 'exact' }: { t: Translator; locale: string; deal: Deal; shape?: MoneyShape }) {
  if (withheld(deal, 'amount')) return <Locked t={t} />;
  if (deal.amount === null || deal.amount === undefined) return <span className="font-sans text-meta font-normal text-text-muted">{t.t('pipeline.card.noAmount')}</span>;
  return <Money t={t} locale={locale} money={deal.amount} shape={shape} />;
}

/** The owner by name, a lock, "Unassigned", or a former owner — never an id (D-P23). */
export function OwnerValue({ t, deal }: { t: Translator; deal: Deal }) {
  if (withheld(deal, 'ownerUserId')) return <Locked t={t} />;
  if (deal.owner === null || deal.owner === undefined) return <span className="text-text-muted">{t.t('pipeline.card.unassigned')}</span>;
  if (deal.owner.displayName === null) return <span className="text-text-muted">{t.t('records.owner.former')}</span>;
  return <span data-record-text="">{deal.owner.displayName}</span>;
}

/** The expected close date as a calendar date, a lock, or nothing. */
export function CloseValue({ t, locale, deal }: { t: Translator; locale: string; deal: Deal }) {
  if (withheld(deal, 'expectedCloseDate')) return <Locked t={t} />;
  if (deal.expectedCloseDate === null || deal.expectedCloseDate === undefined) return null;
  return <time dateTime={deal.expectedCloseDate}>{formatCalendarDate(locale, deal.expectedCloseDate)}</time>;
}

/** The owner's initials in a round chip, the name for a screen reader and a tooltip (P06 cards and rows). */
export function OwnerAvatar({ t, deal, locale, size = 'card' }: { t: Translator; deal: Deal; locale: string; size?: 'card' | 'row' }) {
  const box = size === 'card' ? 'size-7 text-micro' : 'size-[30px] text-micro';
  if (withheld(deal, 'ownerUserId')) {
    return (
      <span className={`inline-flex ${box} items-center justify-center rounded-full bg-surface-sunken text-text-2`}>
        <Icon name="lock" size={14} />
        <span className="sr-only">{t.t('records.locked')}</span>
      </span>
    );
  }
  const name = deal.owner?.displayName ?? null;
  if (deal.owner === null || deal.owner === undefined || name === null) {
    const label = deal.owner === null || deal.owner === undefined ? t.t('pipeline.card.unassigned') : t.t('records.owner.former');
    return (
      <span title={label} className={`inline-flex ${box} items-center justify-center rounded-full border border-dashed border-border-strong text-text-muted`}>
        <Icon name="person" size={14} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span title={name} className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full bg-primary-soft-strong font-bold text-primary-text`}>
      <span aria-hidden="true">{initials(name, locale)}</span>
      <span data-record-text="" className="sr-only">
        {name}
      </span>
    </span>
  );
}

const DAY_MS = 86_400_000;

/** Whole days since an instant, never negative: the design's "4d in stage". */
export function daysSince(instant: string, nowMs: number): number {
  const at = new Date(instant).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((nowMs - at) / DAY_MS));
}

/** Today as a calendar date in the reader's own zone. */
export function todayIso(nowMs: number): string {
  const now = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The design's in-stage chip: "4d in stage" on sunken, "8d · stale" on
 * warning, "16d · rotting" on danger. The tone is the SERVED `rotting` (R8),
 * never the design's fixed 7 and 14 days. A won or lost deal has none.
 */
export function InStageChip({ t, deal, nowMs }: { t: Translator; deal: Deal; nowMs: number }) {
  if (deal.rotting === null) return null;
  const days = daysSince(deal.stageEnteredAt, nowMs);
  const tone =
    deal.rotting === 'rotting'
      ? 'bg-danger-soft text-danger-text'
      : deal.rotting === 'stale'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-surface-sunken text-text-2';
  const label =
    deal.rotting === 'rotting'
      ? t.t('pipeline.card.rotting', { days })
      : deal.rotting === 'stale'
        ? t.t('pipeline.card.stale', { days })
        : t.t('pipeline.card.inStage', { days });
  return (
    <span data-in-stage={deal.rotting} className={`inline-flex h-6 items-center gap-0.75 whitespace-nowrap rounded-full px-1.5 text-micro ${tone}`}>
      <Icon name={deal.rotting === 'fresh' ? 'schedule' : 'hourglass_top'} size={14} />
      {label}
    </span>
  );
}

/** The close date, short ("15 Dec"), in danger with "Overdue" once it has passed. */
export function CloseShort({ t, locale, deal, nowMs, withIcon = true }: { t: Translator; locale: string; deal: Deal; nowMs: number; withIcon?: boolean }) {
  if (withheld(deal, 'expectedCloseDate')) return <Locked t={t} />;
  const date = deal.expectedCloseDate ?? null;
  if (date === null) return null;
  const overdue = deal.rotting !== null && date < todayIso(nowMs);
  const short = formatShortDate(locale, date);
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap ${overdue ? 'text-danger-text' : ''}`}>
      {withIcon ? <Icon name="event" size={14} /> : null}
      <time dateTime={date}>{overdue ? t.t('pipeline.card.overdue', { date: short }) : short}</time>
    </span>
  );
}

/** The tone a stage pill takes, by kind and probability (P06/03's select pills). */
export function stageTone(stage: PipelineStage | undefined): { readonly pill: string; readonly icon: string } {
  if (stage === undefined) return { pill: 'border-border-strong bg-surface-sunken text-text-2', icon: 'text-text-2' };
  if (stage.kind === 'won') return { pill: 'border-success bg-success-soft text-success-text', icon: 'text-success-text' };
  if (stage.kind === 'lost') return { pill: 'border-danger bg-danger-soft text-danger-text', icon: 'text-danger-text' };
  if (stage.probabilityBp < 3_000) return { pill: 'border-border-strong bg-surface-sunken text-text-2', icon: 'text-text-2' };
  if (stage.probabilityBp < 6_000) return { pill: 'border-info bg-info-soft text-info-text', icon: 'text-info-text' };
  if (stage.probabilityBp < 8_000) return { pill: 'border-primary bg-primary-soft text-primary-text', icon: 'text-primary-text' };
  return { pill: 'border-accent bg-accent-soft text-accent-text', icon: 'text-accent-text' };
}

/** `data-locked` on a field whose value is withheld. */
export function lockedProps(deal: Deal, field: string): { 'data-locked'?: 'true' } {
  return withheld(deal, field) ? { 'data-locked': 'true' } : {};
}

/** Offline: the board is still here, in memory (D-L64), and says when it was read. Nothing queues. */
export function OfflineBanner({ t, locale, syncedAt }: { t: Translator; locale: string; syncedAt: Date | null }) {
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex items-start gap-3 rounded-lg border border-warning bg-warning-soft p-3 text-body-sm text-warning-text"
    >
      <Icon name="cloud_off" size="sm" />
      <p>
        <b>{t.t('records.offline.title')}</b>{' '}
        {syncedAt === null ? t.t('records.offline.never') : t.t('pipeline.offline.synced', { time: formatSyncedAt(locale, syncedAt) })}
      </p>
    </div>
  );
}
