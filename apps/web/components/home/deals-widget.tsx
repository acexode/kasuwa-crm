'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { formatDealMoneyWhole } from '../../lib/deal-money';
import { isUuid } from '../pipeline/pipeline-model';
import { daysSince, formatCloseDate } from './home-format';
import type { Attention, AttentionDeal } from './use-home-data';

/**
 * "Deals needing attention" (P03 frame 01): the caller's own open deals that
 * are rotting, going stale or have no next step, worst first.
 *
 * Each row: the deal's name over its account and close date, the amount in
 * mono at the end, then a pill saying why and a text action that opens the
 * deal ("Update deal", or "Add next step"). The pill tones are the design's:
 * danger for rotting, warning for stale, info for no next step.
 *
 * A withheld field is never shown and never guessed: no amount when the amount
 * is withheld, no close date when that is, and `use-home-data` never flags a
 * deal for a field the caller cannot read. Not drawn: the account's city
 * ("Durban"), which nothing on the wire carries (D-L195).
 */

const PILL: Readonly<Record<Attention, { className: string; icon: IconName }>> = {
  rotting: { className: 'bg-danger-soft text-danger-text', icon: 'hourglass_bottom' },
  stale: { className: 'bg-warning-soft text-warning-text', icon: 'hourglass_bottom' },
  noNextStep: { className: 'bg-info-soft text-info-text', icon: 'flag' },
};

export function DealsWidget({
  t,
  locale,
  rows,
  now,
  dealsLive,
}: {
  t: Translator;
  locale: string;
  rows: readonly AttentionDeal[];
  now: Date;
  dealsLive: boolean;
}) {
  return (
    <div className="flex flex-col">
      {rows.map(({ deal, reason, stage }) => {
        const days = daysSince(deal.stageEnteredAt, now);
        const label =
          reason === 'rotting'
            ? stage === null
              ? t.t('home.deals.rottingNoStage', { days })
              : t.t('home.deals.rotting', { days, stage: stage.name })
            : reason === 'stale'
              ? t.t('home.deals.stale', { days })
              : t.t('home.deals.noNextStep');
        const who = deal.account?.name ?? deal.contact?.displayName ?? null;
        const close =
          deal.expectedCloseDate === null || deal.expectedCloseDate === undefined
            ? null
            : formatCloseDate(locale, deal.expectedCloseDate);
        const meta = [who, close === null || close === '' ? null : t.t('home.deals.closes', { date: close })]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ');
        const amount =
          deal.amount === null || deal.amount === undefined ? '' : formatDealMoneyWhole(locale, deal.amount.amountMinor, deal.amount.currency);
        const pill = PILL[reason];
        const action = t.t(reason === 'noNextStep' ? 'home.deals.addNext' : 'home.deals.update');
        return (
          <div key={deal.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border py-2.5">
            <div className="flex min-w-0 flex-[1_1_var(--k-layout-home-deal-name)] flex-col gap-px">
              <b className="text-body-sm font-bold">{deal.name}</b>
              {meta === '' ? null : <span className="text-caption font-normal text-text-2">{meta}</span>}
            </div>
            {amount === '' ? null : <span className="font-mono text-body-sm font-semibold">{amount}</span>}
            <div className="flex flex-[1_1_100%] flex-wrap items-center gap-2">
              <span className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-caption font-bold ${pill.className}`}>
                <Icon name={pill.icon} size={14} />
                {label}
              </span>
              <span className="flex-1" />
              {dealsLive && isUuid(deal.id) ? (
                <Link
                  href={`/deals/${deal.id}`}
                  aria-label={`${action}: ${deal.name}`}
                  className="flex h-control-sm items-center rounded-6 px-2.5 text-meta font-bold text-primary-text outline-none is-hover:bg-primary-soft focus-visible:ring-focus"
                >
                  {action}
                </Link>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
