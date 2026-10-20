import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildTokensCss } from './css';
import { buildTailwindPreset } from './preset';
import { CONTROL_SHADOW, FOCUS, MOTION, SPACING, TYPE_SCALE } from './tokens';

/**
 * The token and preset additions the component library needs (T-0128): the
 * state variants that let the gallery show a state at rest, the focus ring
 * without an outline, and the few values the v1.1 controls use that the scale
 * did not have.
 */

type Rule = { readonly [property: string]: string | Rule };

interface Preset {
  theme: {
    extend: {
      spacing: Record<string, string>;
      boxShadow: Record<string, string>;
      animation: Record<string, string>;
      fontSize: Record<string, unknown>;
    };
  };
  plugins: ((api: {
    addUtilities: (utilities: Record<string, Rule>) => void;
    addVariant: (name: string, selectors: string | readonly string[]) => void;
  }) => void)[];
}

function evaluatePreset(): Preset {
  const sandbox: { module: { exports: unknown } } = { module: { exports: {} } };
  runInNewContext(buildTailwindPreset(), sandbox);
  return sandbox.module.exports as Preset;
}

function plugins(): {
  utilities: Record<string, Rule>;
  variants: Record<string, readonly string[]>;
} {
  const utilities: Record<string, Rule> = {};
  const variants: Record<string, readonly string[]> = {};
  for (const plugin of evaluatePreset().plugins) {
    plugin({
      addUtilities: (added) => Object.assign(utilities, added),
      addVariant: (name, selectors) => {
        variants[name] = typeof selectors === 'string' ? [selectors] : selectors;
      },
    });
  }
  return { utilities, variants };
}

describe('state variants', () => {
  const { variants } = plugins();

  it('styles a live state and the same state previewed with data-preview', () => {
    expect(variants['is-hover']).toContain('&[data-preview~="hover"]');
    expect(variants['is-active']).toContain('&[data-preview~="active"]');
    expect(variants['is-focus-visible']).toContain('&[data-preview~="focus"]');
    expect(variants['is-focus']).toContain('&[data-preview~="focus"]');
  });

  it('never hovers or presses a disabled control', () => {
    expect(variants['is-hover']?.[0]).toContain(':hover:not(:disabled)');
    expect(variants['is-active']?.[0]).toBe('&:active:not(:disabled)');
  });

  it('hovers only on devices that can hover, so a tap does not stick', () => {
    expect(variants['is-hover']?.[0]).toMatch(/^@media \(hover: hover\)/);
  });

  it('shows keyboard focus on buttons and any focus on fields', () => {
    expect(variants['is-focus-visible']?.[0]).toBe('&:focus-visible');
    expect(variants['is-focus']?.[0]).toBe('&:focus');
  });
});

describe('the focus ring', () => {
  const ring = plugins().utilities['.ring-focus'];

  it('is the box-shadow alone: no outline style outside forced-colours mode', () => {
    expect(ring?.['box-shadow']).toBe(FOCUS.ring);
    expect(ring?.['outline-style']).toBe('none');
    expect(ring?.outline).toBeUndefined();
  });

  it('draws a transparent outline in forced-colours mode, where box-shadow is dropped', () => {
    expect(ring?.['@media (forced-colors: active)']).toEqual({
      outline: '2px solid transparent',
      'outline-offset': '2px',
    });
  });
});

describe('values the v1.1 controls need', () => {
  const preset = evaluatePreset().theme.extend;

  it('adds 3, 18 and 26px to the spacing scale, keyed by value / 4', () => {
    expect(SPACING['0.75']).toBe('3px');
    expect(SPACING['4.5']).toBe('18px');
    expect(SPACING['6.5']).toBe('26px');
    for (const key of ['0.75', '4.5', '6.5']) {
      const name = key.replace('.', '_');
      expect(preset.spacing[key]).toBe(`var(--k-space-${name})`);
      expect(buildTokensCss()).toContain(`--k-space-${name}: ${SPACING[key as '0.75']};`);
    }
  });

  it('adds an 11/16/700 step for counts, small tags and keys, in the case written', () => {
    expect(TYPE_SCALE.micro).toEqual({
      size: '11px',
      lineHeight: '16px',
      weight: '700',
      tracking: '0',
    });
    expect(preset.fontSize.micro).toBeDefined();
    expect(plugins().utilities['.text-micro']).toBeUndefined();
  });

  it('turns the spinner at the export speed', () => {
    expect(MOTION.spin.duration).toBe('800ms');
    expect(preset.animation.spin).toBe('spin var(--k-duration-spin) linear infinite');
  });

  it('emits the control shadows as utilities and never as root properties', () => {
    expect(preset.boxShadow.knob).toBe(CONTROL_SHADOW.knob);
    expect(preset.boxShadow['switch-disabled']).toBe('inset 0 0 0 1px var(--k-border)');
    expect(buildTokensCss()).not.toMatch(/--k-shadow-(knob|switch)/);
  });
});
