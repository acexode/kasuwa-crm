import {
  COLOUR_SCALES,
  CONTROL_HEIGHT,
  CSS_VAR_PREFIX,
  cssKey,
  DESIGN_VERSION,
  ELEVATION,
  FOCUS,
  ICON_SIZE,
  kebab,
  MOTION,
  RADIUS,
  SEMANTIC_TOKEN_NAMES,
  SHELL,
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

  const fontSizes = Object.keys(TYPE_SCALE)
    .map((step) => {
      const extras = [
        `lineHeight: 'var(${CSS_VAR_PREFIX}-line-height-${step})'`,
        `fontWeight: 'var(${CSS_VAR_PREFIX}-font-weight-${step})'`,
        `letterSpacing: 'var(${CSS_VAR_PREFIX}-tracking-${step})'`,
      ];
      return `    '${step}': ['var(${CSS_VAR_PREFIX}-font-size-${step})', { ${extras.join(', ')} }],`;
    })
    .join('\n');

  // Tailwind's fontSize config reads lineHeight, letterSpacing and fontWeight
  // only. A textTransform or fontFeatureSettings there is silently dropped, so
  // `text-h6` and `text-overline` rendered in sentence case and `text-mono`
  // without tabular figures. They are emitted as utilities on the same class
  // instead, which Tailwind merges with the font-size rule.
  const typeExtras = Object.entries(TYPE_SCALE)
    .flatMap(([step, spec]) => {
      const declarations = [
        'transform' in spec ? `'text-transform': '${spec.transform}'` : null,
        'fontFeature' in spec ? `'font-feature-settings': "${spec.fontFeature}"` : null,
      ].filter((line): line is string => line !== null);
      return declarations.length === 0
        ? []
        : [`        '.text-${step}': { ${declarations.join(', ')} },`];
    })
    .join('\n');

  // Icon sizes are font sizes with NO weight, line height or tracking: a type
  // step's weight on the icon font draws a faux-bold glyph (T-0127).
  const iconSizes = Object.keys(ICON_SIZE)
    .map((key) => `    'icon-${key}': 'var(${CSS_VAR_PREFIX}-icon-size-${cssKey(key)})',`)
    .join('\n');

  // Control heights and shell dimensions join the spacing scale, so one token
  // drives h-, w-, min-h-, inset and padding alike: `h-control-sm`,
  // `w-shell-rail`, `top-shell-header`, `pb-shell-bottom-bar`.
  const spacing = [
    ...Object.keys(SPACING).map(
      (key) => `    '${key}': 'var(${CSS_VAR_PREFIX}-space-${cssKey(key)})',`,
    ),
    ...Object.keys(CONTROL_HEIGHT).map(
      (key) =>
        `    'control-${kebab(key)}': 'var(${CSS_VAR_PREFIX}-control-height-${cssKey(key)})',`,
    ),
    ...Object.keys(SHELL).map(
      (key) => `    'shell-${kebab(key)}': 'var(${CSS_VAR_PREFIX}-shell-${cssKey(key)})',`,
    ),
  ].join('\n');

  const radius = Object.keys(RADIUS)
    .map((key) => `    '${key}': 'var(${CSS_VAR_PREFIX}-radius-${cssKey(key)})',`)
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
${iconSizes}
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
  plugins: [
    // Type-step properties Tailwind's fontSize cannot carry, then the two focus
    // shapes (T-0127; values in tokens.ts FOCUS). A plain function rather than
    // tailwindcss/plugin, so the preset needs no import. Use the focus shapes
    // behind a variant: \`focus-visible:ring-focus\`.
    function ({ addUtilities }) {
      addUtilities({
${typeExtras}
        '.ring-focus': {
          outline: '2px solid transparent',
          'outline-offset': '2px',
          'box-shadow': '${FOCUS.ring}',
        },
        '.field-focus': {
          outline: '2px solid transparent',
          'outline-offset': '2px',
          'border-color': '${FOCUS.fieldBorder}',
          'box-shadow': '${FOCUS.field}',
        },
      });
    },
  ],
};
`;
}
