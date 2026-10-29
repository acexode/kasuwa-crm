'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { Pill, SegmentedControl, Tabs, type SegmentedOption, type TabItem } from '@kasuwa/ui/components';
import type { LanguageOption } from '../auth/language-menu';
import { CrmShell } from '../crm/crm-shell';
import { ProgrammePill } from '../records/list-chrome';
import { useMyProgrammes } from '../records/use-my-programmes';
import { useOnline } from '../script-builder/use-online';
import {
  listPriceBooks,
  listProducts,
  listTaxProfiles,
  sortCatalogueProducts,
  type PriceBook,
  type Product,
  type TaxProfile,
} from '../../lib/commerce-api';
import {
  COMMERCE_CARD,
  COMMERCE_HEAD,
  CommerceOffline,
  CommerceStatus,
  EmptyRow,
  PageHeader,
  PrimaryAction,
  type LoadPhase,
} from './commerce-parts';
/**
 * P21/01–04 — Product catalogue and price books (T-0171, D-L194).
 * Reads the programme catalogue the session reaches; write controls stay off
 * until their APIs are wired. No sample rows (D-L194).
 */

type Tab = 'products' | 'pricing';

type CatalogueData =
  | { readonly phase: 'loading' | 'unavailable' }
  | {
      readonly phase: 'ready';
      readonly products: readonly Product[];
      readonly books: readonly PriceBook[];
      readonly tax: readonly TaxProfile[];
    };

function programmeId(programmes: ReturnType<typeof useMyProgrammes>): string | null {
  if (programmes.phase !== 'loaded' || programmes.list === null || programmes.list.length === 0) return null;
  return programmes.list[0]?.id ?? null;
}

export function CatalogueScreen({
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
  const [tab, setTab] = useState<Tab>('products');
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [data, setData] = useState<CatalogueData>({ phase: 'loading' });
  const pid = programmeId(programmes);

  const load = useCallback(() => {
    if (pid === null) {
      setData({ phase: 'ready', products: [], books: [], tax: [] });
      setSyncedAt(new Date());
      return undefined;
    }
    setData({ phase: 'loading' });
    const controller = new AbortController();
    void Promise.all([
      listProducts(pid, controller.signal),
      listPriceBooks(pid, controller.signal),
      listTaxProfiles(pid, controller.signal),
    ]).then(([products, books, tax]) => {
      if (controller.signal.aborted) return;
      if (!products.ok || !books.ok || !tax.ok) {
        setData({ phase: 'unavailable' });
        return;
      }
      setData({
        phase: 'ready',
        products: sortCatalogueProducts(products.value),
        books: books.value,
        tax: tax.value,
      });
      setSyncedAt(new Date());
    });
    return () => controller.abort();
  }, [pid]);

  useEffect(() => {
    return load();
  }, [load]);

  const tabs: readonly TabItem[] = useMemo(
    () => [
      { value: 'products', label: t.t('commerce.catalogue.tab.products') },
      { value: 'pricing', label: t.t('commerce.catalogue.tab.pricing') },
    ],
    [t],
  );

  const viewOptions: readonly SegmentedOption[] = useMemo(
    () => [
      { value: 'products', label: t.t('commerce.catalogue.tab.products') },
      { value: 'pricing', label: t.t('commerce.catalogue.tab.pricing') },
    ],
    [t],
  );

  const phase: LoadPhase = data.phase;
  const ready = data.phase === 'ready' ? data : null;

  return (
    <CrmShell locale={locale} t={t} locales={locales} live={live} current="catalogue">
      <div
        data-testid="p21-catalogue"
        data-locale={locale}
        className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 pb-8 pt-4 md:gap-5 md:px-6 md:pt-6"
      >
        {!online ? <CommerceOffline t={t} locale={locale} syncedAt={syncedAt} onRetry={load} /> : null}
        <PageHeader
          t={t}
          title="commerce.catalogue.title"
          subtitle="commerce.catalogue.subtitle"
          action={
            tab === 'products' ? (
              <PrimaryAction t={t} label="commerce.catalogue.addProduct" disabled={!online} />
            ) : (
              <PrimaryAction t={t} label="commerce.catalogue.addPriceBook" disabled={!online} />
            )
          }
        />
        <ProgrammePill t={t} programmes={programmes.list} />
        <div className="hidden md:block">
          <Tabs items={tabs} value={tab} onValueChange={(value) => setTab(value as Tab)} aria-label={t.t('commerce.catalogue.title')} />
        </div>
        <div className="md:hidden">
          <SegmentedControl
            options={viewOptions}
            value={tab}
            onValueChange={(value) => setTab(value as Tab)}
            aria-label={t.t('commerce.catalogue.title')}
          />
        </div>
        {tab === 'products' ? (
          <section data-testid="catalogue-products" className={COMMERCE_CARD}>
            <div className="hidden grid-cols-[minmax(0,2fr)_120px_120px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
              <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.name')}</span>
              <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.sku')}</span>
              <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.status')}</span>
            </div>
            {phase !== 'ready' ? (
              <CommerceStatus t={t} phase={phase} />
            ) : ready === null || ready.products.length === 0 ? (
              <EmptyRow t={t} message="commerce.catalogue.empty.products" />
            ) : (
              <ul className="flex flex-col">
                {ready.products.map((product) => (
                  <li
                    key={product.id}
                    className="grid gap-1 border-t border-border px-3 py-3 text-meta first:border-t-0 md:grid-cols-[minmax(0,2fr)_120px_120px] md:items-center md:gap-2.5"
                  >
                    <span data-record-text="" className="truncate text-body-sm font-semibold">
                      {product.name}
                    </span>
                    <span className="font-mono text-text-2">{product.sku ?? '—'}</span>
                    <span>
                      <Pill tone={product.status === 'active' ? 'success' : 'neutral'}>
                        {t.t(
                          product.status === 'active'
                            ? 'commerce.catalogue.status.active'
                            : 'commerce.catalogue.status.archived',
                        )}
                      </Pill>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <div className="flex flex-col gap-4">
            <section data-testid="catalogue-price-books" className={COMMERCE_CARD}>
              <div className="hidden grid-cols-[minmax(0,2fr)_100px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
                <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.name')}</span>
                <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.currency')}</span>
              </div>
              {phase !== 'ready' ? (
                <CommerceStatus t={t} phase={phase} />
              ) : ready === null || ready.books.length === 0 ? (
                <EmptyRow t={t} message="commerce.catalogue.empty.priceBooks" />
              ) : (
                <ul className="flex flex-col">
                  {ready.books.map((book) => (
                    <li
                      key={book.id}
                      className="flex items-center justify-between gap-3 border-t border-border px-3 py-3 text-meta first:border-t-0"
                    >
                      <span data-record-text="" className="min-w-0 truncate font-semibold">
                        {book.name}
                      </span>
                      <span className="font-mono text-text-2">{book.currency}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section data-testid="catalogue-tax" className={COMMERCE_CARD}>
              <div className="hidden grid-cols-[minmax(0,2fr)_120px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
                <span className={COMMERCE_HEAD}>{t.t('commerce.catalogue.col.name')}</span>
                <span className={`${COMMERCE_HEAD} text-end`}>{t.t('commerce.catalogue.col.rate')}</span>
              </div>
              {phase !== 'ready' ? (
                <CommerceStatus t={t} phase={phase} />
              ) : ready === null || ready.tax.length === 0 ? (
                <EmptyRow t={t} message="commerce.catalogue.empty.tax" />
              ) : (
                <ul className="flex flex-col">
                  {ready.tax.map((profile) => (
                    <li
                      key={profile.id}
                      className="flex items-center justify-between gap-3 border-t border-border px-3 py-3 text-meta first:border-t-0"
                    >
                      <span data-record-text="" className="min-w-0 truncate font-semibold">
                        {profile.name}
                      </span>
                      <span className="font-mono tabular-nums text-text-2">
                        {t.t('commerce.catalogue.taxRate', { rate: (profile.rateBps / 100).toFixed(2) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </CrmShell>
  );
}
