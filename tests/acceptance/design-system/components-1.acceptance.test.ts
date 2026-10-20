import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0128, the component library part 1 (D-L193, D-L197).
 *
 * Committed FAILING by the lead before assignment.
 *
 * The visual and computed-style contract is `tests/e2e/design-components.spec.ts`
 * (every `@t0128` journey must pass). This file pins what the browser cannot
 * see: where the components live, what they may import, and that they are the
 * one place a control's look is defined.
 *
 * WHERE: `packages/ui/src/components/`, published as `@kasuwa/ui/components`.
 * A separate entry point, because `@kasuwa/ui` itself exports the colour tables
 * and generators, and a client component importing it would ship them to the
 * browser on every page (T-0127 kept `icon.tsx` to type-only imports for the
 * same reason). React is a peer dependency, supplied by the app.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const uiRoot = resolve(repoRoot, 'packages/ui');
const componentsDir = join(uiRoot, 'src/components');

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const EXPORTS = [
  'Button',
  'IconButton',
  'TextField',
  'Select',
  'Checkbox',
  'Radio',
  'Switch',
  'Chip',
  'Pill',
  'Tag',
  'CountBadge',
  'SegmentedControl',
  'Tabs',
  'Avatar',
  'Kbd',
] as const;

describe('acceptance: @kasuwa/ui/components exists as its own entry point (T-0128)', () => {
  const pkg = JSON.parse(readFileSync(join(uiRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it('publishes ./components', () => {
    expect(pkg.exports?.['./components']).toBeDefined();
  });

  it('takes React as a peer dependency, never a dependency of its own', () => {
    expect(pkg.peerDependencies?.react).toBeDefined();
    expect(pkg.dependencies?.react).toBeUndefined();
  });

  it.each(EXPORTS)('exports %s', async (name) => {
    const entry = pkg.exports?.['./components'];
    expect(entry, 'no ./components entry').toBeDefined();
    const source = readFileSync(join(uiRoot, entry ?? 'missing'), 'utf8');
    expect(source, `${name} is not exported from ${entry}`).toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe('acceptance: the components import nothing that ships token tables to the browser (T-0128)', () => {
  it('has component sources', () => {
    expect(sources(componentsDir).length).toBeGreaterThan(0);
  });

  it('never imports the @kasuwa/ui root, the colour tables or the generators at run time', () => {
    const offenders = sources(componentsDir).filter((file) => {
      const text = readFileSync(file, 'utf8');
      const runtime = text
        .split('\n')
        .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line));
      return runtime.some((line) =>
        /from\s+['"](@kasuwa\/ui['"]|\.\.\/(index|tokens|tokens\.colours\.generated|css|contrast)['"])/.test(
          line,
        ),
      );
    });
    expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });

  it('uses no colour literal and no arbitrary pixel value: tokens only', () => {
    const offenders = sources(componentsDir).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /#[0-9a-fA-F]{3,8}\b|rgba?\(|\[\d+px\]/.test(text);
    });
    expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });
});

describe('acceptance: the gallery page exists (T-0128)', () => {
  it('serves /design/components from apps/web', () => {
    expect(existsSync(resolve(repoRoot, 'apps/web/app/design/components/page.tsx'))).toBe(true);
  });
});
