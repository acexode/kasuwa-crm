import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAGS } from '@kasuwa/feature-flags';

/**
 * ACCEPTANCE — T-0171: P21 screens for catalogue, quotes, approvals and
 * payment status. Invoice frames and refund frames are not routes.
 * Each route is a real 404 while its flag is off.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const root = (...parts: string[]) => resolve(repoRoot, ...parts);

const PAGES = [
  {
    file: 'apps/web/app/commerce/catalogue/page.tsx',
    flag: 'crmProductsEnabled',
    screen: 'P21/01',
  },
  {
    file: 'apps/web/app/commerce/quotes/page.tsx',
    flag: 'crmQuotesEnabled',
    screen: 'P21/05',
  },
  {
    file: 'apps/web/app/commerce/approvals/page.tsx',
    flag: 'quoteApprovalsEnabled',
    screen: 'P21/06',
  },
  {
    file: 'apps/web/app/commerce/payments/page.tsx',
    flag: 'paymentLinksEnabled',
    screen: 'P21/22',
  },
] as const;

describe('acceptance: P21 commerce screens (T-0171)', () => {
  it('keeps the commerce flags off and not production-ready', () => {
    for (const key of ['crm_products', 'crm_quotes', 'quote_approvals', 'payment_links'] as const) {
      expect(FLAGS[key].defaultValue).toBe(false);
      expect(FLAGS[key].productionReady).toBe(false);
    }
  });

  it('gates each screen with notFound and cites its P21 frame', () => {
    for (const page of PAGES) {
      const source = readFileSync(root(page.file), 'utf8');
      expect(source, page.file).toContain('notFound()');
      expect(source, page.file).toContain(page.flag);
      expect(source, page.file).toContain(`screen="${page.screen}"`);
    }
  });

  it('does not ship invoice or refund routes', () => {
    expect(existsSync(root('apps/web/app/commerce/invoices/page.tsx'))).toBe(false);
    expect(existsSync(root('apps/web/app/commerce/refunds/page.tsx'))).toBe(false);
  });

  it('uses existing message ids and no colour literal on the screen', () => {
    const source = readFileSync(root('apps/web/components/commerce/commerce-screen.tsx'), 'utf8');
    const en = JSON.parse(readFileSync(root('packages/i18n/src/locales/en.json'), 'utf8')) as Record<string, string>;
    const ids = [...source.matchAll(/t\.t\((\w+)\)/g)].map((match) => match[1]);
    expect(ids).toEqual(['titleId', 'emptyId']);
    for (const id of [
      'deal.products.title',
      'deal.products.empty',
      'deal.quotes.title',
      'deal.quotes.empty',
      'deal.approvals.title',
      'deal.approvals.empty',
      'record.timeline.filter.payments',
      'notifications.prefs.event.payment',
    ]) {
      expect(en[id], id).toBeTypeOf('string');
    }
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
