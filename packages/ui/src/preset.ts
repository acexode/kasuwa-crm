import {
  COLOUR_SCALES,
  CSS_VAR_PREFIX,
  DESIGN_VERSION,
  ELEVATION,
  MOTION,
  RADIUS,
  SEMANTIC_TOKEN_NAMES,
  SPACING,
  TYPE_SCALE,
} from './tokens';

/**
 * Renders the Tailwind preset.
 *
 * Generated rather than hand-written, for the same reason the colours are
 * imported rather than typed: there are 53 semantic tokens and 77 scale steps,
 * and a preset that lists them by hand goes stale the first time a token is
 * added. A stale preset does not fail — it silently omits a utility, and
 * someone works around the gap with a raw value, which is how a design system
 * starts leaking.
 *
 * Every value points at a CSS custom property rather than a literal, so themes
 * (light/dark, and later per-tenant white-label) switch by swapping variables
 * on `:root` without rebuilding CSS. White-label theming is a P0 requirement
 * (PRD M1) and this is the mechanism that makes it possible.
 */
export function buildTailwindPreset(): string {
  const semanticColours = SEMANTIC_TOKEN_NAMES.map(
    (token) => `    '${token}': 'var(${CSS_VAR_PREFIX}-${token})',`,
  ).join('\n');

  const scaleColours = Object.entries(COLOUR_SCALES)
    .map(([family, scale]) => {
      const tones = Object.keys(scale)
        .map((tone) => `      '${tone}': 'var(${CSS_VAR_PREFIX}-scale-${family}-${tone})',`)
        .join('\n');
      return `    '${family}-scale': {\n${tones}\n    },`;
    })
    .join('\n');

  const fontSizes = Object.entries(TYPE_SCALE)
    .map(([step, spec]) => {
      const extras = [
        `lineHeight: 'var(${CSS_VAR_PREFIX}-line-height-${step})'`,
        `fontWeight: 'var(${CSS_VAR_PREFIX}-font-weight-${step})'`,
        `letterSpacing: 'var(${CSS_VAR_PREFIX}-tracking-${step})'`,
      ];
      if ('transform' in spec) {
        extras.push(`textTransform: '${spec.transform}'`);
      }
      if ('fontFeature' in spec) {
        extras.push(`fontFeatureSettings: "${spec.fontFeature}"`);
      }
      return `    '${step}': ['var(${CSS_VAR_PREFIX}-font-size-${step})', { ${extras.join(', ')} }],`;
    })
    .join('\n');

  const spacing = Object.keys(SPACING)
    .map((key) => `    '${key}': 'var(${CSS_VAR_PREFIX}-space-${key})',`)
    .join('\n');

  const radius = Object.keys(RADIUS)
    .map((key) => `    '${key}': 'var(${CSS_VAR_PREFIX}-radius-${key})',`)
    .join('\n');

  const shadows = Object.keys(ELEVATION)
    .map((level) => `    '${level}': 'var(${CSS_VAR_PREFIX}-elevation-${level})',`)
    .join('\n');

  const durations = Object.keys(MOTION)
    .map((name) => `    '${name}': 'var(${CSS_VAR_PREFIX}-duration-${name})',`)
    .join('\n');

  return `/* eslint-disable */
/**
 * GENERATED FILE — do not edit. Source: packages/ui/src/preset.ts (Design ${DESIGN_VERSION})
 * Regenerate with: pnpm ui:tokens
 *
 * Usage in an app:
 *   presets: [require('@kasuwa/ui/tailwind-preset')]
 */
const colors = {
${semanticColours}
${scaleColours}
};

module.exports = {
  theme: {
    extend: {
      colors,
      fontFamily: {
        sans: ['var(${CSS_VAR_PREFIX}-font-sans)'],
        arabic: ['var(${CSS_VAR_PREFIX}-font-arabic)'],
        mono: ['var(${CSS_VAR_PREFIX}-font-mono)'],
        icon: ['var(${CSS_VAR_PREFIX}-font-icon)'],
      },
      fontSize: {
${fontSizes}
      },
      spacing: {
${spacing}
      },
      borderRadius: {
${radius}
      },
      boxShadow: {
${shadows}
      },
      transitionDuration: {
${durations}
      },
      transitionTimingFunction: {
        DEFAULT: 'var(${CSS_VAR_PREFIX}-ease)',
        kasuwa: 'var(${CSS_VAR_PREFIX}-ease)',
      },
      ringColor: { DEFAULT: 'var(${CSS_VAR_PREFIX}-focus)' },
      outlineColor: { DEFAULT: 'var(${CSS_VAR_PREFIX}-focus)' },
      // WCAG 2.2 AA minimum target size, available as min-h-touch / min-w-touch.
      minHeight: { touch: 'var(${CSS_VAR_PREFIX}-space-touch)' },
      minWidth: { touch: 'var(${CSS_VAR_PREFIX}-space-touch)' },
    },
  },
};
`;
}
