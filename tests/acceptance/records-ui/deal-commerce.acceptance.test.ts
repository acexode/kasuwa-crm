import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FLAGS,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';

/**
 * ACCEPTANCE — T-0170, wire the P06 deal page commerce placeholders
 * (`deal_products`, `deal_quotes`). `fx_display` stays a flagged empty /
 * disabled state until B5. Lead-authorised suite (Combined tier).
 *
 *   1. Flags registered, DEFAULT OFF, NOT production-ready; `dealModules()` only.
 *   2. Commerce client same-origin Zod-parsed listProducts / price-books / quotes.
 *   3. Deal screen lazy-loads `./deal-commerce` (byte budget).
 *   4. `fx_display` still disabled UsdSwitch; no invented FX.
 *   5. Approvals under deal_quotes stay empty (T-0166).
 *   6. i18n / no colour literals / money as digit strings.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const COMMERCE_CONTRACT = 'docs/api/commerce.openapi.yaml';
const DEAL_SCREEN = 'apps/web/components/deal/deal-screen.tsx';
const DEAL_COMMERCE = 'apps/web/components/deal/deal-commerce.tsx';
const COMMERCE_CLIENT = 'apps/web/lib/commerce-api.ts';
const BOARD_EXTRAS = 'apps/web/components/pipeline/board-extras.tsx';
const MENU_LOCALES = ['en', 'ar', 'fr', 'ha', 'ig', 'pcm', 'sw', 'yo'] as const;

interface SourceFile { file: string; source: string }

function trackedFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', directory], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function webSources(): SourceFile[] {
  return trackedFiles('apps/web')
    .filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file) && existsSync(fromRoot(file)))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

function colourLiterals(source: string): string[] {
  const code = withoutComments(source);
  const patterns = [
    /['"`][^'"`\n]*#[0-9a-fA-F]{3,8}(?![\w-])[^'"`\n]*['"`]/g,
    /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/g,
    /\b[a-z-]+-\[(?:#|rgb|hsl|oklch|color)/g,
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|accent|caret|decoration|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide)-(?:white|black)\b/g,
  ];
  return patterns.flatMap((pattern) => code.match(pattern) ?? []);
}

function moneyHazards(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...(code.match(/[₦₵¢]|GH₵|\bK[Ss]h\b/g) ?? []),
    ...(code.match(/\b(?:Number|parseFloat|parseInt)\s*\(\s*[\w.?![\]]*(?:amountMinor|unitAmountMinor|totalMinor|subtotalMinor|discountMinor)\b/g) ?? []),
  ];
}

function messageIdsIn(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)]
        .map((match) => match[1] ?? '')
        .filter((id) => id.startsWith('deal.')),
    ),
  ];
}

function readersOf(flag: string): string[] {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const named = new RegExp(`['"]${flag}['"]`);
  return [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
    .filter((match) => named.test(match[2] ?? ''))
    .map((match) => match[1] ?? '');
}

type Json = Record<string, unknown>;
interface Contract { paths: Record<string, Record<string, Json>> }
function commerceContract(): Contract {
  return parse(readFileSync(fromRoot(COMMERCE_CONTRACT), 'utf8')) as Contract;
}

describe('acceptance: T-0170 — deal commerce flags', () => {
  it('registers deal_products and deal_quotes off by default, not production-ready', () => {
    expect(FLAGS.deal_products.defaultValue).toBe(false);
    expect(FLAGS.deal_products.productionReady).toBe(false);
    expect(FLAGS.deal_quotes.defaultValue).toBe(false);
    expect(FLAGS.deal_quotes.productionReady).toBe(false);
    expect(FLAGS.fx_display.defaultValue).toBe(false);
    expect(FLAGS.fx_display.productionReady).toBe(false);
  });

  it('dealModules() is the only reader of deal_products and deal_quotes', () => {
    expect(readersOf('deal_products')).toEqual(['dealModules']);
    expect(readersOf('deal_quotes')).toEqual(['dealModules']);
  });

  it('no client module names the flags', () => {
    const named = webSources().filter(
      ({ file, source }) =>
        !file.startsWith('apps/web/lib/feature-flags') &&
        !file.includes('.test.') &&
        /['"]deal_products['"]|['"]deal_quotes['"]/.test(withoutComments(source)),
    );
    expect(named.map(({ file }) => file)).toEqual([]);
  });

  it('defaults evaluate false', async () => {
    await initialiseFeatureFlags();
    const client = featureFlagClient();
    const context = toEvaluationContext({ tenantId: 'acceptance' });
    expect(await client.getBooleanValue('deal_products', false, context)).toBe(false);
    expect(await client.getBooleanValue('deal_quotes', false, context)).toBe(false);
    expect(await client.getBooleanValue('fx_display', false, context)).toBe(false);
  });
});

describe('acceptance: T-0170 — commerce client for the deal page', () => {
  it('ships apps/web/lib/commerce-api.ts naming the commerce list paths', () => {
    expect(existsSync(fromRoot(COMMERCE_CLIENT))).toBe(true);
    const source = withoutComments(readFileSync(fromRoot(COMMERCE_CLIENT), 'utf8'));
    expect(source).toMatch(/\/api\/v1\/programmes\/.*products/);
    expect(source).toMatch(/\/api\/v1\/programmes\/.*price-books/);
    expect(source).toMatch(/\/api\/v1\/programmes\/.*quotes/);
    expect(source).toMatch(/\blistProducts\b/);
    expect(source).toMatch(/\blistQuotes\b/);
    expect(source).toMatch(/\bquotesForDeal\b/);
  });

  it('the commerce contract still serves listProducts and listQuotes', () => {
    const paths = commerceContract().paths;
    expect(paths['/api/v1/programmes/{programmeId}/products']?.get?.['x-kasuwa-implemented']).toBe(true);
    expect(paths['/api/v1/programmes/{programmeId}/price-books']?.get?.['x-kasuwa-implemented']).toBe(true);
    expect(paths['/api/v1/programmes/{programmeId}/quotes']?.get?.['x-kasuwa-implemented']).toBe(true);
  });

  it('never passes a JS number through amount fields', () => {
    expect(moneyHazards(readFileSync(fromRoot(COMMERCE_CLIENT), 'utf8'))).toEqual([]);
  });
});

describe('acceptance: T-0170 — deal screen lazy-loads commerce', () => {
  it('deal-screen.tsx dynamically imports deal-commerce for products and quotes', () => {
    const source = withoutComments(readFileSync(fromRoot(DEAL_SCREEN), 'utf8'));
    expect(source).toMatch(/import\(\s*['"]\.\/deal-commerce['"]\s*\)/);
    expect(source).toMatch(/DealProductsCard/);
    expect(source).toMatch(/DealQuotesRail/);
    expect(source).not.toMatch(/from\s+['"]\.\/deal-commerce['"]/);
  });

  it('deal-commerce.tsx exists and reads the commerce client', () => {
    expect(existsSync(fromRoot(DEAL_COMMERCE))).toBe(true);
    const source = withoutComments(readFileSync(fromRoot(DEAL_COMMERCE), 'utf8'));
    expect(source).toMatch(/listProducts|listQuotes/);
    expect(source).toMatch(/from\s+['"].*commerce-api['"]/);
    expect(source).toMatch(/data-testid=["']deal-products["']/);
    expect(source).toMatch(/data-testid=["']deal-quotes["']/);
    expect(source).toMatch(/data-testid=["']deal-approvals["']/);
  });

  it('commerce-api is not a static import of deal-screen', () => {
    const source = withoutComments(readFileSync(fromRoot(DEAL_SCREEN), 'utf8'));
    expect(source).not.toMatch(/from\s+['"].*commerce-api['"]/);
  });
});

describe('acceptance: T-0170 — fx_display stays a flagged empty state', () => {
  it('UsdSwitch is still disabled with no FX rate or US$ figure', () => {
    const source = withoutComments(readFileSync(fromRoot(BOARD_EXTRAS), 'utf8'));
    expect(source).toMatch(/function UsdSwitch/);
    expect(source).toMatch(/disabled/);
    expect(source).not.toMatch(/exchangeRate|fxRate|convertCurrency|USD\s*\*/i);
  });

  it('deal-commerce invents no FX conversion', () => {
    const source = withoutComments(readFileSync(fromRoot(DEAL_COMMERCE), 'utf8'));
    expect(source).not.toMatch(/exchangeRate|fxRate|convertCurrency|US\$|USD\b/);
  });
});

describe('acceptance: T-0170 — i18n and lint surface for commerce slice', () => {
  it('every deal.* id deal-commerce names is in every menu catalogue', () => {
    const source = readFileSync(fromRoot(DEAL_COMMERCE), 'utf8');
    const ids = messageIdsIn(source).filter((id) => id in catalogue('en'));
    expect(ids.length).toBeGreaterThan(0);
    for (const locale of MENU_LOCALES) {
      const cat = catalogue(locale);
      expect(ids.filter((id) => !(id in cat)), locale).toEqual([]);
    }
  });

  it('commerce status and loading keys exist in en', () => {
    const en = catalogue('en');
    for (const id of [
      'deal.commerce.loading',
      'deal.commerce.unavailable',
      'deal.quotes.status.draft',
      'deal.quotes.status.sent',
      'deal.quotes.status.accepted',
      'deal.quotes.status.rejected',
      'deal.quotes.status.expired',
      'deal.quotes.status.cancelled',
    ]) {
      expect(en[id], id).toBeTypeOf('string');
    }
  });

  it('writes no colour literal in the commerce slice', () => {
    const found = [DEAL_COMMERCE, COMMERCE_CLIENT].flatMap((file) =>
      colourLiterals(readFileSync(fromRoot(file), 'utf8')).map((hit) => `${file}: ${hit}`),
    );
    expect(found).toEqual([]);
  });

  it('commerce UI money stays digit strings through formatDealMoney', () => {
    const source = readFileSync(fromRoot(DEAL_COMMERCE), 'utf8');
    expect(moneyHazards(source)).toEqual([]);
    expect(withoutComments(source)).toMatch(/formatDealMoney/);
  });
});

describe('acceptance: T-0170 — eslint on the commerce web modules', () => {
  it('eslint passes on commerce-api and deal-commerce', () => {
    const require = createRequire(fromRoot('package.json'));
    const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
    const run = spawnSync(process.execPath, [bin, COMMERCE_CLIENT, DEAL_COMMERCE, '--max-warnings=0'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(run.status, `${run.stdout ?? ''}${run.stderr ?? ''}`).toBe(0);
  });
});
