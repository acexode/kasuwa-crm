'use client';

import type { ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { OfflineBanner } from '../records/list-parts';
import { formatDealMoney, UnreadableAmountError } from '../../lib/deal-money';
import type { CommerceCurrency } from '../../lib/commerce-api';

/** Shared chrome for P21 catalogue and quotes (T-0171). */
export const COMMERCE_CARD = 'overflow-hidden rounded-10 border border-border bg-surface';
export const COMMERCE_HEAD =
  'px-3 text-micro uppercase tracking-[0.05em] text-text-2';

export type LoadPhase = 'loading' | 'unavailable' | 'ready';

export function CommerceOffline({
  t,
  locale,
  syncedAt,
  onRetry,
}: {
  t: Translator;
  locale: string;
  syncedAt: Date | null;
  onRetry?: () => void;
}) {
  return (
    <OfflineBanner
      t={t}
      locale={locale}
      syncedAt={syncedAt}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

export function CommerceStatus({
  t,
  phase,
}: {
  t: Translator;
  phase: Exclude<LoadPhase, 'ready'>;
}) {
  if (phase === 'loading') {
    return (
      <p aria-busy="true" className="flex items-start gap-2 px-3 py-4 text-meta text-text-2">
        <Icon name="sync" size={18} className="text-text-muted" />
        {t.t('deal.commerce.loading')}
      </p>
    );
  }
  return (
    <p role="alert" className="flex items-start gap-2 px-3 py-4 text-meta text-text-2">
      <Icon name="error" size={18} className="text-danger-text" />
      {t.t('deal.commerce.unavailable')}
    </p>
  );
}

export function MoneyCell({
  t,
  locale,
  amountMinor,
  currency,
}: {
  t: Translator;
  locale: string;
  amountMinor: string;
  currency: CommerceCurrency;
}) {
  try {
    return (
      <span className="whitespace-nowrap font-mono tabular-nums">
        {formatDealMoney(locale, amountMinor, currency)}
      </span>
    );
  } catch (error) {
    if (!(error instanceof UnreadableAmountError)) throw error;
    return <span className="text-danger-text">{t.t('pipeline.money.unreadable')}</span>;
  }
}

export function EmptyRow({ t, message }: { t: Translator; message: MessageId }) {
  return (
    <p className="flex items-start gap-2 border-t border-border px-3 py-4 text-meta text-text-2 first:border-t-0">
      <Icon name="inventory_2" size={18} className="shrink-0 text-text-muted" />
      {t.t(message)}
    </p>
  );
}

export function PageHeader({
  t,
  title,
  subtitle,
  action,
}: {
  t: Translator;
  title: MessageId;
  subtitle: MessageId;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex flex-col gap-1">
        <h1 className="text-page-title">{t.t(title)}</h1>
        <p className="text-body-sm text-text-2">{t.t(subtitle)}</p>
      </div>
      {action === undefined ? null : <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

export function PrimaryAction({ t, label, disabled }: { t: Translator; label: MessageId; disabled: boolean }) {
  return (
    <Button size="compact" icon="add" disabled={disabled}>
      {t.t(label)}
    </Button>
  );
}
