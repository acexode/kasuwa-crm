'use client';

import { useCallback, useEffect, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Pill } from '@kasuwa/ui/components';
import type { LanguageOption } from '../auth/language-menu';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import { ProgrammePill } from '../records/list-chrome';
import { useMyProgrammes } from '../records/use-my-programmes';
import { useOnline } from '../script-builder/use-online';
import { listQuotes, type Quote } from '../../lib/commerce-api';
import {
  COMMERCE_CARD,
  COMMERCE_HEAD,
  CommerceOffline,
  CommerceStatus,
  EmptyRow,
  MoneyCell,
  PageHeader,
  PrimaryAction,
  type LoadPhase,
} from './commerce-parts';

/**
 * P21 — Quotes list with approvals and payment placeholders (T-0171, D-L194).
 * The builder, send and payment panels stay empty until their modules land.
 */

function programmeId(programmes: ReturnType<typeof useMyProgrammes>): string | null {
  if (programmes.phase !== 'loaded' || programmes.list === null || programmes.list.length === 0) return null;
  return programmes.list[0]?.id ?? null;
}

function formatUpdated(locale: string, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function QuotesScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const programmes = useMyProgrammes();
  const online = useOnline();
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [quotes, setQuotes] = useState<readonly Quote[]>([]);
  const pid = programmeId(programmes);

  const load = useCallback(() => {
    if (pid === null) {
      setPhase('ready');
      setQuotes([]);
      setSyncedAt(new Date());
      return undefined;
    }
    setPhase('loading');
    const controller = new AbortController();
    void listQuotes(pid, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setPhase('unavailable');
        return;
      }
      setQuotes(result.value);
      setPhase('ready');
      setSyncedAt(new Date());
    });
    return () => controller.abort();
  }, [pid]);

  useEffect(() => {
    return load();
  }, [load]);

  return (
    <CrmShell locale={locale} t={t} locales={locales} live={live} current="quotes">
      <div
        data-testid="p21-quotes"
        data-locale={locale}
        className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 pb-8 pt-4 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:gap-5 md:px-6 md:pt-6"
      >
        <div className="flex min-w-0 flex-col gap-4 md:col-span-1">
          {!online ? <CommerceOffline t={t} locale={locale} syncedAt={syncedAt} onRetry={load} /> : null}
          <PageHeader
            t={t}
            title="commerce.quotes.title"
            subtitle="commerce.quotes.subtitle"
            action={<PrimaryAction t={t} label="commerce.quotes.new" disabled={!online} />}
          />
          <ProgrammePill t={t} programmes={programmes.list} />
          <section data-testid="quotes-list" className={COMMERCE_CARD}>
            <div className="hidden grid-cols-[minmax(0,1.2fr)_120px_140px_160px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
              <span className={COMMERCE_HEAD}>{t.t('commerce.quotes.col.status')}</span>
              <span className={`${COMMERCE_HEAD} text-end`}>{t.t('commerce.quotes.col.total')}</span>
              <span className={`${COMMERCE_HEAD} text-end`}>{t.t('commerce.quotes.col.updated')}</span>
            </div>
            {phase !== 'ready' ? (
              <CommerceStatus t={t} phase={phase} />
            ) : quotes.length === 0 ? (
              <EmptyRow t={t} message="commerce.quotes.empty" />
            ) : (
              <ul className="flex flex-col">
                {quotes.map((quote) => (
                  <li
                    key={quote.id}
                    data-quote-id={quote.id}
                    data-quote-status={quote.status}
                    className="grid gap-2 border-t border-border px-3 py-3 text-meta first:border-t-0 md:grid-cols-[minmax(0,1.2fr)_120px_140px] md:items-center"
                  >
                    <span>
                      <Pill tone="neutral">{t.t(`deal.quotes.status.${quote.status}` as MessageId)}</Pill>
                    </span>
                    <span className="text-end">
                      <MoneyCell t={t} locale={locale} amountMinor={quote.totalMinor} currency={quote.currency} />
                    </span>
                    <time dateTime={quote.updatedAt} className="text-end text-caption text-text-2">
                      {formatUpdated(locale, quote.updatedAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <section data-testid="quotes-approvals" className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-card-title">{t.t('commerce.quotes.approvals.title')}</h2>
            <p className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-meta text-text-2">
              <Icon name="approval" size={18} className="text-text-muted" />
              {t.t('commerce.quotes.approvals.empty')}
            </p>
          </section>
          <section data-testid="quotes-payments" className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-card-title">{t.t('commerce.quotes.payments.title')}</h2>
            <p className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-meta text-text-2">
              <Icon name="payments" size={18} className="text-text-muted" />
              {t.t('commerce.quotes.payments.empty')}
            </p>
          </section>
        </aside>
      </div>
    </CrmShell>
  );
}
