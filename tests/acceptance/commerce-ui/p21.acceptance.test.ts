import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FLAGS } from '@kasuwa/feature-flags';
import { describe, expect, it } from 'vitest';

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
  });
});
