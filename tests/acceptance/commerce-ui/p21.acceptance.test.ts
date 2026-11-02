import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLAGS } from '@kasuwa/feature-flags';
import { describe, expect, it } from 'vitest';

const AXE_EXEMPTION_CLAIM = /axeExempt|skipA11y|a11yExempt|AXE_EXEMPT/i;

function collectSources(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return out;
}

/**
 * ACCEPTANCE — T-0171 P21 commerce screens (route gates).
 * Full UI fidelity is iterative; this suite locks the flag-gated routes.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

describe('T-0171 P21 commerce screens', () => {
  it('registers commerce flags off by default', () => {
    expect(FLAGS.crm_products.defaultValue).toBe(false);
    expect(FLAGS.crm_quotes.defaultValue).toBe(false);
    expect(FLAGS.payment_links.defaultValue).toBe(false);
  });

  it('ships catalogue and quotes route modules', () => {
    expect(existsSync(resolve(repoRoot, 'apps/web/app/catalogue/page.tsx'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'apps/web/app/quotes/page.tsx'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'apps/web/components/commerce/catalogue-screen.tsx'))).toBe(
      true,
    );
    expect(existsSync(resolve(repoRoot, 'apps/web/components/commerce/quotes-screen.tsx'))).toBe(
      true,
    );
  });

  it('does not claim axe exemptions in the P21 slice sources', () => {
    const sources = [
      resolve(repoRoot, 'apps/web/app/catalogue/page.tsx'),
      resolve(repoRoot, 'apps/web/app/quotes/page.tsx'),
      ...collectSources(resolve(repoRoot, 'apps/web/components/commerce')),
    ];
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(AXE_EXEMPTION_CLAIM);
    }
  });
});
