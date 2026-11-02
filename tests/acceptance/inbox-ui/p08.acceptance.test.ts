import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLAGS } from '@kasuwa/feature-flags';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0192 P08 inbox screens (route gates).
 * Full UI fidelity is iterative; this suite locks the flag-gated route shell.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

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

describe('T-0192 P08 inbox screens', () => {
  it('registers crm_inbox off by default', () => {
    expect(FLAGS.crm_inbox.defaultValue).toBe(false);
    expect(FLAGS.crm_inbox.productionReady).toBe(false);
  });

  it('ships the inbox route module', () => {
    expect(existsSync(resolve(repoRoot, 'apps/web/app/inbox/page.tsx'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'apps/web/components/inbox/inbox-screen.tsx'))).toBe(true);
  });

  it('does not claim axe exemptions in the inbox slice sources', () => {
    const sources = [
      resolve(repoRoot, 'apps/web/app/inbox/page.tsx'),
      ...collectSources(resolve(repoRoot, 'apps/web/components/inbox')),
    ];
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(AXE_EXEMPTION_CLAIM);
    }
  });
});
