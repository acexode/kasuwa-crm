import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { formatSyncedAt } from '../records/list-model';
import { formatDealMoney } from '../../lib/deal-money';
import { withheld, type Deal, type DealMoney } from '../../lib/pipelines-api';
import { formatCalendarDate } from './pipeline-model';

/**
 * The pieces the P06 board, list and dialogs draw the same way (T-0109): an
 * exact amount, a lock, an owner, a close date and the offline banner. One
 * copy, so a lock or a former owner reads the same on a card and in a row.
 */

/** An exact amount in its currency's own format (R5). The digits come from the string, never a number. */
export function Money({ locale, money, kind }: { locale: string; money: DealMoney; kind?: 'amount' | 'weighted' }) {
  return (
    <span data-money={kind} className="whitespace-nowrap tabular-nums">
      {formatDealMoney(locale, money.amountMinor, money.currency)}
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
export function AmountValue({ t, locale, deal }: { t: Translator; locale: string; deal: Deal }) {
  if (withheld(deal, 'amount')) return <Locked t={t} />;
  if (deal.amount === null || deal.amount === undefined) return <span className="text-text-muted">{t.t('pipeline.card.noAmount')}</span>;
  return <Money locale={locale} money={deal.amount} />;
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
