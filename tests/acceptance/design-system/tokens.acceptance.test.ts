import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTRAST_PAIRS,
  contrastRatio,
  DESIGN_VERSION,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SEMANTIC_TOKEN_NAMES,
  TYPE_SCALE,
} from '@kasuwa/ui';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — Design v1.1 tokens (T-0003).
 *
 * HONEST NOTE ON WHAT THESE ARE.
 *
 * Addendum A1 section 3.3 principle 3 says acceptance tests are committed
 * FAILING before a task is assigned. These were not: the T-0003 hand-off said
 * not to touch `tests/acceptance/`, so the work landed while this file was
 * still `it.todo`, and these assertions were written afterwards. They pass on
 * their first run.
 *
 * So they are regression tests wearing an acceptance test's clothes, and it is
 * worth saying so rather than letting the directory imply a rigour the history
 * does not have. What they are good for is the next change: a token edit, a
 * design re-import or a refactor that breaks one of these properties fails here.
 *
 * They deliberately assert SYSTEM-level properties the unit suite in
 * `packages/ui` cannot see: that the generated artefacts still match their
 * generators, that the committed export is still the source, that no colour has
 * escaped the design system, and that the fonts a page references exist.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

describe('acceptance: the design export is the source of truth', () => {
  it('ships the approved export, committed', () => {
    for (const file of [
      'Kasuwa Design System.dc.html',
      'Kasuwa Components.dc.html',
      'Kasuwa Patterns.dc.html',
      'support.js',
    ]) {
      expect(existsSync(fromRoot('docs/design/v1.1', file)), file).toBe(true);
    }
  });

  it('declares the design version the export came from', () => {
    expect(DESIGN_VERSION).toBe('v1.1');
  });

  it('traces every semantic token back to the export', () => {
    // If the generated module and the export ever disagree, the values in the
    // repository have stopped being the values the designer approved — which is
    // the whole reason the importer exists rather than a typing exercise.
    const exportSource = readFileSync(
      fromRoot('docs/design/v1.1', 'Kasuwa Design System.dc.html'),
      'utf8',
    );

    for (const token of SEMANTIC_TOKEN_NAMES) {
      expect(exportSource, `--k-${token} is not present in the export`).toContain(`--k-${token}:`);
    }
  });
});

describe('acceptance: generated artefacts match their generators', () => {
  // CI runs the generators and diffs. Asserting it here too means a developer
  // finds out before pushing, and the property survives someone editing the
  // workflow file.
  const generated = [
    'packages/ui/src/tokens.colours.generated.ts',
    'packages/ui/src/tokens.generated.css',
    'packages/ui/tailwind-preset.cjs',
  ];

  it('regenerating changes nothing', () => {
    const before = generated.map((path) => readFileSync(fromRoot(path), 'utf8'));

    execFileSync('node', [fromRoot('packages/ui/scripts/import-design-tokens.mjs')], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    execFileSync('npx', ['tsx', 'scripts/generate-tokens-css.ts'], {
      cwd: fromRoot('packages/ui'),
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    generated.forEach((path, index) => {
      expect(readFileSync(fromRoot(path), 'utf8'), `${path} drifted`).toBe(before[index]);
    });
  });

  it('marks generated files so nobody hand-edits them', () => {
    for (const path of generated) {
      expect(readFileSync(fromRoot(path), 'utf8').slice(0, 400)).toMatch(/GENERATED FILE/);
    }
  });
});

describe('acceptance: the contrast contract holds', () => {
  const THEMES = [
    ['light', SEMANTIC_LIGHT],
    ['dark', SEMANTIC_DARK],
  ] as const;

  it('meets every minimum in both themes', () => {
    for (const [themeName, theme] of THEMES) {
      for (const pair of CONTRAST_PAIRS) {
        const ratio = contrastRatio(theme[pair.foreground], theme[pair.background]);
        expect(
          ratio,
          `${themeName}: ${pair.foreground} on ${pair.background}`,
        ).toBeGreaterThanOrEqual(pair.minimumRatio);
      }
    }
  });

  it('uses only WCAG 2.2 AA thresholds', () => {
    // 4.5 for text, 3 for non-text UI boundaries. Anything else means someone
    // relaxed the contract rather than fixing a colour.
    for (const pair of CONTRAST_PAIRS) {
      expect([3, 4.5]).toContain(pair.minimumRatio);
    }
  });

  /**
   * Regression guard for a real mistake, kept because it is an easy one to
   * repeat.
   *
   * The T-0003 hand-off quoted 3.79 for `border-strong on surface`. It turned
   * out to be the DARK token measured against the LIGHT surface — a cross-theme
   * pairing, which produces a plausible-looking number that means nothing,
   * because no user ever sees those two colours together.
   *
   * The figures below pin the correct within-theme values. If anything starts
   * mixing themes again, these move and this fails.
   */
  it('evaluates pairs within a single theme, never across two', () => {
    const light = contrastRatio(SEMANTIC_LIGHT['border-strong'], SEMANTIC_LIGHT.surface);
    const dark = contrastRatio(SEMANTIC_DARK['border-strong'], SEMANTIC_DARK.surface);
    expect(light).toBeCloseTo(4.12, 2);
    expect(dark).toBeCloseTo(4.56, 2);

    const crossTheme = contrastRatio(SEMANTIC_DARK['border-strong'], SEMANTIC_LIGHT.surface);
    expect(crossTheme).toBeCloseTo(3.79, 2);
    expect(crossTheme).not.toBeCloseTo(light, 2);
  });
});

describe('acceptance: both themes are complete', () => {
  it('defines the same tokens in light and dark', () => {
    expect(Object.keys(SEMANTIC_DARK).sort()).toEqual(Object.keys(SEMANTIC_LIGHT).sort());
  });

  it('gives every token a value in both themes', () => {
    for (const token of SEMANTIC_TOKEN_NAMES) {
      expect(SEMANTIC_LIGHT[token], `light: ${token}`).toBeTruthy();
      expect(SEMANTIC_DARK[token], `dark: ${token}`).toBeTruthy();
    }
  });

  it('emits both themes and the accessibility layers into the generated CSS', () => {
    const css = readFileSync(fromRoot('packages/ui/src/tokens.generated.css'), 'utf8');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('prefers-color-scheme: dark');
    // Reduced motion is a global layer, not a per-component convention.
    expect(css).toContain('prefers-reduced-motion: reduce');
    // Arabic script needs the taller line-height the export specifies.
    expect(css).toContain('[lang="ar"]');
  });
});

describe('acceptance: no colour escapes the design system', () => {
  it('has no hex literal in application or package source', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((path) => /^(apps|packages|tools)\/.*\.(ts|tsx|mjs|cjs)$/.test(path))
      // packages/ui IS the design system; everything else reads tokens from it.
      .filter((path) => !path.startsWith('packages/ui/'));

    expect(tracked.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const path of tracked) {
      const source = readFileSync(fromRoot(path), 'utf8');
      const matches = source.match(/['"]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})['"]/g);
      if (matches !== null) {
        offenders.push(`${path}: ${[...new Set(matches)].join(', ')}`);
      }
    }

    expect(offenders, 'use a semantic token from @kasuwa/ui instead').toEqual([]);
  });
});

describe('acceptance: self-hosted fonts', () => {
  const fontsCss = () => readFileSync(fromRoot('packages/ui/src/fonts.generated.css'), 'utf8');

  it('references only font files that exist', () => {
    const referenced = [...fontsCss().matchAll(/url\('\/fonts\/([^']+)'\)/g)].map(
      (match) => match[1] as string,
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(
        existsSync(fromRoot('apps/web/public/fonts', file)),
        `${file} is referenced but not committed`,
      ).toBe(true);
    }
  });

  it('keeps Google Fonts as a fallback rather than the primary source', () => {
    // Local first, CDN second, in every src. A third-party font host is an
    // extra origin that can be slow or blocked on the connections Kasuwa
    // targets, plus a request carrying the user's IP on every page load.
    const faces = fontsCss().split('@font-face').slice(1);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const localIndex = face.indexOf("url('/fonts/");
      const remoteIndex = face.indexOf('https://fonts.gstatic.com');
      expect(localIndex, 'no self-hosted src').toBeGreaterThan(-1);
      if (remoteIndex > -1) {
        expect(localIndex, 'CDN listed before the local file').toBeLessThan(remoteIndex);
      }
    }
  });

  it('ships the icon font subset rather than the whole family', () => {
    const subset = fromRoot('apps/web/public/fonts/material-symbols-rounded-subset.woff2');
    expect(existsSync(subset)).toBe(true);
    // Whole, Material Symbols Rounded is several megabytes. If this grows past
    // a few hundred KB the subsetting has silently stopped working.
    expect(readFileSync(subset).byteLength).toBeLessThan(300 * 1024);
  });
});

describe('acceptance: type scale supports the languages we ship', () => {
  it('never drops body line-height below 1.4', () => {
    // Stacked Yoruba and Igbo tone marks (ọ̀, ẹ́) collide with the line above
    // below this. A legibility requirement in three of our languages.
    for (const step of ['body-lg', 'body-md', 'body-sm'] as const) {
      const spec = TYPE_SCALE[step];
      const ratio = Number.parseFloat(spec.lineHeight) / Number.parseFloat(spec.size);
      expect(ratio, step).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('declares an Arabic-capable family for RTL', () => {
    const css = readFileSync(fromRoot('packages/ui/src/tokens.generated.css'), 'utf8');
    expect(css).toContain('Noto Sans Arabic');
  });
});

describe('acceptance: the tokens are no longer provisional', () => {
  it('does not describe itself as PROVISIONAL', () => {
    const source = readFileSync(fromRoot('packages/ui/src/tokens.ts'), 'utf8');
    expect(source).not.toContain('PROVISIONAL');
  });
});
