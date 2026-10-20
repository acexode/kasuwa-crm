import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildTokensCss } from './css';
import { buildTailwindPreset } from './preset';
import {
  ARABIC_LINE_HEIGHT_MULTIPLIER,
  CONTROL_HEIGHT,
  cssKey,
  FOCUS,
  FONT_WEIGHTS,
  ICON_SIZE,
  ICON_SIZE_ALIAS,
  type IconSize,
  RADIUS,
  resolveIconSize,
  SHELL,
  SPACING,
  TYPE_SCALE,
} from './tokens';

/**
 * The screen exports' vocabulary (T-0127, D-L193): the type steps, radii,
 * control heights, icon sizes and shell dimensions the Claude Design screens
 * use, and how they reach the generated CSS and the Tailwind preset.
 *
 * The acceptance suite pins the values; these pin the mechanics around them
 * that a screenshot would not show until a screen used them: that a half step
 * produces a legal custom property, that an icon size carries no font weight,
 * that the legacy icon names still render at the size they always did.
 */

interface PresetUtility {
  readonly [property: string]: string | PresetUtility;
}

interface Preset {
  theme: {
    extend: {
      fontSize: Record<string, string | [string, Record<string, string>]>;
      spacing: Record<string, string>;
      borderRadius: Record<string, string>;
    };
  };
  plugins: ((api: {
    addUtilities: (u: Record<string, PresetUtility>) => void;
    addVariant: (name: string, selectors: string | string[]) => void;
  }) => void)[];
}

function evaluatePreset(): Preset {
  const sandbox: { module: { exports: unknown } } = { module: { exports: {} } };
  runInNewContext(buildTailwindPreset(), sandbox);
  return sandbox.module.exports as Preset;
}

function presetUtilities(): Record<string, PresetUtility> {
  const utilities: Record<string, PresetUtility> = {};
  for (const plugin of evaluatePreset().plugins) {
    plugin({ addUtilities: (added) => Object.assign(utilities, added), addVariant: () => {} });
  }
  return utilities;
}

describe('type steps from the screen exports', () => {
  it('adds the P01 headline at 44/52/800, measured in the export', () => {
    expect(TYPE_SCALE.headline).toMatchObject({
      size: '44px',
      lineHeight: '52px',
      weight: '800',
      tracking: '-0.02em',
    });
  });

  it('keeps every text step that can wrap at a line height of at least 1.4', () => {
    // Stacked Yoruba and Igbo tone marks collide with the line above below
    // 1.4. The overline is one line of caps and the titles are display text;
    // the steps a paragraph can use must clear it.
    for (const step of ['label', 'meta', 'card-title'] as const) {
      const spec = TYPE_SCALE[step];
      const ratio = Number.parseFloat(spec.lineHeight) / Number.parseFloat(spec.size);
      expect(ratio, step).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('declares every weight a type step uses', () => {
    const weights = new Set<string>(Object.values(FONT_WEIGHTS));
    for (const [step, spec] of Object.entries(TYPE_SCALE)) {
      expect(weights.has(spec.weight), `${step} uses weight ${spec.weight}`).toBe(true);
    }
  });

  it('carries caps and tabular figures as utilities, which Tailwind fontSize drops', () => {
    // Tailwind 3's fontSize reads lineHeight, letterSpacing and fontWeight
    // only: a textTransform there never reached the CSS, so h6 rendered in
    // sentence case. The overline is the second caps step.
    const utilities = presetUtilities();
    expect(utilities['.text-overline']?.['text-transform']).toBe('uppercase');
    expect(utilities['.text-h6']?.['text-transform']).toBe('uppercase');
    expect(utilities['.text-mono']?.['font-feature-settings']).toBe("'tnum' 1");
  });

  it('emits the new steps, and their +10% Arabic line heights, into the CSS', () => {
    const css = buildTokensCss();
    expect(css).toContain('--k-font-size-overline: 11px;');
    expect(css).toContain('--k-tracking-overline: 0.06em;');
    const arabic = css.slice(css.indexOf('[lang="ar"]'));
    const meta = Math.round(19 * ARABIC_LINE_HEIGHT_MULTIPLIER);
    expect(arabic).toContain(`--k-line-height-meta: ${meta}px;`);
  });
});

describe('radii, spacing half steps, control heights and shell', () => {
  it('has exactly the v1.1 radii plus the export steps 6, 10 and 14', () => {
    const pixels = Object.values(RADIUS)
      .map((value) => Number.parseFloat(value))
      .sort((a, b) => a - b);
    expect(pixels).toEqual([4, 6, 8, 10, 12, 14, 16, 999]);
  });

  it('gives the 6/10/14px gaps legal custom-property names', () => {
    expect(SPACING['1.5']).toBe('6px');
    expect(SPACING['2.5']).toBe('10px');
    expect(SPACING['3.5']).toBe('14px');

    const css = buildTokensCss();
    expect(css).toContain('--k-space-1_5: 6px;');
    // A '.' inside a custom property name is not an identifier character; an
    // unescaped one silently drops the declaration.
    expect(css).not.toMatch(/--k-[\w-]*\.[\w-]*\s*:/);

    const { spacing } = evaluatePreset().theme.extend;
    expect(spacing['1.5']).toBe('var(--k-space-1_5)');
  });

  it('keeps the standard control height equal to the touch floor', () => {
    expect(CONTROL_HEIGHT.base).toBe(SPACING.touch);
    expect(Object.values(CONTROL_HEIGHT)).toEqual(['36px', '40px', '44px', '48px', '52px']);
  });

  it('exposes control heights and shell dimensions as spacing utilities', () => {
    const { spacing } = evaluatePreset().theme.extend;
    expect(spacing['control-sm']).toBe('var(--k-control-height-sm)');
    expect(spacing['control-xl']).toBe('var(--k-control-height-xl)');
    expect(spacing['shell-rail']).toBe('var(--k-shell-rail)');
    expect(spacing['shell-admin-nav']).toBe('var(--k-shell-admin-nav)');

    const css = buildTokensCss();
    expect(css).toContain(`--k-shell-admin-nav: ${SHELL.adminNav};`);
    expect(css).toContain(`--k-shell-mobile-header: ${SHELL.mobileHeader};`);
    expect(css).toContain(`--k-control-height-sm: ${CONTROL_HEIGHT.sm};`);
  });

  it('maps camelCase and half-step keys to CSS names', () => {
    expect(cssKey('railItemWidth')).toBe('rail-item-width');
    expect(cssKey('1.5')).toBe('1_5');
    expect(cssKey('sm')).toBe('sm');
  });
});

describe('icon sizes', () => {
  it('maps each legacy name to the pixel size its type step used to give it', () => {
    // sm was body-lg (18), md h4 (20), lg h3 (24), xl h2 (32). Existing
    // screens must not change size when the type classes go.
    expect(ICON_SIZE_ALIAS).toEqual({ sm: 18, md: 20, lg: 24, xl: 32 });
    expect(resolveIconSize('sm')).toBe(18);
    expect(resolveIconSize('md')).toBe(20);
    expect(resolveIconSize('lg')).toBe(24);
    expect(resolveIconSize('xl')).toBe(32);
  });

  it('passes a pixel size through, and every size resolves to a token', () => {
    for (const key of Object.keys(ICON_SIZE)) {
      const size = Number(key) as IconSize;
      expect(resolveIconSize(size)).toBe(size);
      expect(ICON_SIZE[size]).toBe(`${size}px`);
    }
    for (const alias of Object.keys(ICON_SIZE_ALIAS) as (keyof typeof ICON_SIZE_ALIAS)[]) {
      expect(ICON_SIZE[resolveIconSize(alias)]).toBeDefined();
    }
  });

  it('emits icon font sizes that set no weight, line height or tracking', () => {
    // An icon inherits the surrounding weight, as the exports do (D-L198); a
    // weight here would override it, which is the defect the type classes had.
    const { fontSize } = evaluatePreset().theme.extend;
    for (const key of Object.keys(ICON_SIZE)) {
      expect(fontSize[`icon-${key}`], `icon-${key}`).toBe(`var(--k-icon-size-${key})`);
    }
    expect(buildTokensCss()).toContain('--k-icon-size-22: 22px;');
  });
});

describe('focus utilities', () => {
  it('ring-focus is a 2px surface gap and then a 2px focus ring', () => {
    const ring = presetUtilities()['.ring-focus'];
    expect(ring?.['box-shadow']).toBe(FOCUS.ring);
    expect(FOCUS.ring).toBe('0 0 0 2px var(--k-surface), 0 0 0 4px var(--k-focus)');
  });

  it('field-focus is a primary border with a 3px primary-soft-strong halo', () => {
    const field = presetUtilities()['.field-focus'];
    expect(field?.['border-color']).toBe('var(--k-primary)');
    expect(field?.['box-shadow']).toBe('0 0 0 3px var(--k-primary-soft-strong)');
  });

  it('keeps a transparent outline under both, for forced-colours mode', () => {
    // field-focus keeps it everywhere. ring-focus keeps it only where
    // box-shadow is dropped, and has no outline otherwise (T-0128: the v1.1
    // ring is the whole indicator).
    const utilities = presetUtilities();
    expect(utilities['.field-focus']?.outline).toBe('2px solid transparent');
    const forced = utilities['.ring-focus']?.['@media (forced-colors: active)'];
    expect(typeof forced === 'object' ? forced.outline : forced).toBe('2px solid transparent');
  });

  it('never emits the focus shadows as root custom properties', () => {
    // A custom property resolves its var()s where it is declared, so a root
    // --k-focus-ring would carry the ROOT surface into every nested surface.
    expect(buildTokensCss()).not.toMatch(/--k-focus-(ring|field)/);
  });
});
