'use client';

import { useEffect, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button, Pill } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import {
  listPriceBooks,
  listProducts,
  listQuotes,
  listPriceForProduct,
  quotesForDeal,
  sortCatalogueProducts,
  type PriceBook,
  type Product,
  type Quote,
} from '../../lib/commerce-api';
import { formatDealMoney, UnreadableAmountError } from '../../lib/deal-money';
import type { DealDetail } from '../../lib/deal-detail-api';

/**
 * Deal-page commerce panels (T-0170): catalogue products and quotes for the
 * deal's programme. Loaded only when `deal_products` / `deal_quotes` are on
 * (`clientLazy` from deal-screen), so the flag-off deal first paint does not
 * ship the commerce client. Approvals stay the design empty state until
 * T-0166. No FX here — `fx_display` stays on the board as a disabled switch.
 */

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

type LoadState<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'ready'; readonly value: T };

function MoneyText({
  t,
  locale,
  amountMinor,
  currency,
}: {
  t: Translator;
  locale: string;
  amountMinor: string;
  currency: string;
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

function Dash() {
  return <span className="font-mono">{'—'}</span>;
}

function StatusBody({ t, state }: { t: Translator; state: LoadState<unknown> }) {
  if (state.phase === 'loading') {
    return (
      <p aria-busy="true" className="flex items-start gap-2 border-t border-border px-3 py-4 text-meta text-text-2">
        <Icon name="sync" size={18} className="text-text-muted" />
        {t.t('deal.commerce.loading')}
      </p>
    );
  }
  if (state.phase === 'unavailable') {
    return (
      <p role="alert" className="flex items-start gap-2 border-t border-border px-3 py-4 text-meta text-text-2">
        <Icon name="error" size={18} className="text-danger-text" />
        {t.t('deal.commerce.unavailable')}
      </p>
    );
  }
  return null;
}

/** Products and VAT: programme catalogue with list prices in the deal's currency. */
export function DealProductsCard({
  t,
  locale,
  deal,
  programmeId,
}: {
  t: Translator;
  locale: string;
  deal: DealDetail;
  programmeId: string;
}) {
  const currency = deal.amount?.currency ?? 'NGN';
  const [state, setState] = useState<LoadState<{ products: readonly Product[]; books: readonly PriceBook[] }>>({
    phase: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    void Promise.all([listProducts(programmeId, controller.signal), listPriceBooks(programmeId, controller.signal)]).then(
      ([products, books]) => {
        if (controller.signal.aborted) return;
        if (!products.ok || !books.ok) {
          setState({ phase: 'unavailable' });
          return;
        }
        setState({
          phase: 'ready',
          value: { products: sortCatalogueProducts(products.value), books: books.value },
        });
      },
    );
    return () => controller.abort();
  }, [programmeId, currency]);

  const head = 'px-3 text-micro uppercase tracking-[0.05em] text-text-2';

  return (
    <section data-testid="deal-products" className={PANEL}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-card-title">{t.t('deal.products.title')}</h2>
        <span className="flex-1" />
        <Button size="compact" icon="add" disabled>
          {t.t('deal.products.add')}
        </Button>
      </div>
      <div className="overflow-hidden rounded-10 border border-border">
        <div className="hidden grid-cols-[minmax(0,2.4fr)_100px_130px_56px_64px_140px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
          <span className={head}>{t.t('deal.products.product')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.list')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.unit')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.qty')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.discount')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.total')}</span>
        </div>
        {state.phase !== 'ready' ? (
          <StatusBody t={t} state={state} />
        ) : state.value.products.length === 0 ? (
          <p className="flex items-start gap-2 border-t border-border px-3 py-4 text-meta text-text-2 first:border-t-0 md:first:border-t">
            <Icon name="inventory_2" size={18} className="text-text-muted" />
            {t.t('deal.products.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {state.value.products.map((product) => {
              const list = listPriceForProduct(state.value.books, product.id, currency);
              return (
                <li
                  key={product.id}
                  data-product-id={product.id}
                  data-product-status={product.status}
                  className="grid gap-1 border-t border-border px-3 py-3 text-meta first:border-t-0 md:grid-cols-[minmax(0,2.4fr)_100px_130px_56px_64px_140px] md:items-center md:gap-2.5"
                >
                  <span className="min-w-0">
                    <b data-record-text="" className="block truncate text-body-sm font-semibold">
                      {product.name}
                    </b>
                    {product.sku === null ? null : (
                      <span className="text-caption font-normal text-text-2">{product.sku}</span>
                    )}
                  </span>
                  <span className="text-end">
                    {list === null ? (
                      <Dash />
                    ) : (
                      <MoneyText t={t} locale={locale} amountMinor={list.amountMinor} currency={list.currency} />
                    )}
                  </span>
                  <span className="hidden text-end md:block">
                    <Dash />
                  </span>
                  <span className="hidden text-end md:block">
                    <Dash />
                  </span>
                  <span className="hidden text-end md:block">
                    <Dash />
                  </span>
                  <span className="hidden text-end md:block">
                    <Dash />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-col gap-1 border-t border-border bg-surface-sunken px-3 py-2.5 text-meta">
          {(['deal.products.subtotal', 'deal.products.vat'] as const).map((label) => (
            <span key={label} className="flex justify-end gap-6">
              <span className="text-text-2">{t.t(label)}</span>
              <span className="min-w-[140px] text-end">
                <Dash />
              </span>
            </span>
          ))}
          <span className="flex justify-end gap-6 text-label">
            <b>{t.t('deal.products.total')}</b>
            <b className="min-w-[140px] text-end">
              <Dash />
            </b>
          </span>
        </div>
      </div>
    </section>
  );
}

/** Quotes for this deal, plus the still-empty approvals card (T-0166). */
export function DealQuotesRail({
  t,
  locale,
  dealId,
  programmeId,
}: {
  t: Translator;
  locale: string;
  dealId: string;
  programmeId: string;
}) {
  const [state, setState] = useState<LoadState<readonly Quote[]>>({ phase: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    void listQuotes(programmeId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { phase: 'ready', value: quotesForDeal(result.value, dealId) } : { phase: 'unavailable' });
    });
    return () => controller.abort();
  }, [programmeId, dealId]);

  return (
    <>
      <section data-testid="deal-quotes" className={`${PANEL} gap-1`}>
        <div className="mb-1.5 flex items-center">
          <h2 className="flex-1 text-card-title">{t.t('deal.quotes.title')}</h2>
          <button type="button" disabled className="h-control-sm rounded-6 px-2.5 text-meta font-bold text-disabled-text">
            {t.t('deal.quotes.new')}
          </button>
        </div>
        {state.phase !== 'ready' ? (
          <StatusBody t={t} state={state} />
        ) : state.value.length === 0 ? (
          <p className="flex items-start gap-2 border-t border-border py-2.5 text-caption font-normal text-text-2">
            <Icon name="request_quote" size={16} className="text-text-muted" />
            {t.t('deal.quotes.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {state.value.map((quote) => (
              <li
                key={quote.id}
                data-quote-id={quote.id}
                data-quote-status={quote.status}
                className="flex min-h-[52px] items-center gap-2.5 border-t border-border py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill tone="neutral">{t.t(`deal.quotes.status.${quote.status}` as MessageId)}</Pill>
                    <MoneyText t={t} locale={locale} amountMinor={quote.totalMinor} currency={quote.currency} />
                  </span>
                  <time dateTime={quote.updatedAt} className="text-caption font-normal text-text-2">
                    {formatUpdated(locale, quote.updatedAt)}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="deal-approvals" className={`${PANEL} gap-1`}>
        <div className="mb-1.5 flex items-center">
          <h2 className="flex-1 text-card-title">{t.t('deal.approvals.title')}</h2>
        </div>
        <p className="flex items-start gap-2 border-t border-border py-2.5 text-caption font-normal text-text-2">
          <Icon name="approval" size={16} className="text-text-muted" />
          {t.t('deal.approvals.empty')}
        </p>
      </section>
    </>
  );
}

function formatUpdated(locale: string, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
