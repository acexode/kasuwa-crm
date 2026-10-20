import {
  COLOUR_SCALES,
  CONTROL_HEIGHT,
  CONTROL_SHADOW,
  CSS_VAR_PREFIX,
  cssKey,
  DESIGN_VERSION,
  ELEVATION,
  FOCUS,
  ICON_SIZE,
  kebab,
  LAYOUT,
  MOTION,
  RADIUS,
  SEMANTIC_TOKEN_NAMES,
  OVERLAY,
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

  // Icon sizes are font sizes with NO weight, line height or tracking: an icon
  // inherits the weight of the text around it, as in the exports (D-L198), and
  // a type step's own weight would override that (T-0127).
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
    ...Object.keys(OVERLAY).map(
      (key) => `    'overlay-${kebab(key)}': 'var(${CSS_VAR_PREFIX}-overlay-${cssKey(key)})',`,
    ),
    ...Object.keys(LAYOUT).map(
      (key) => `    'layout-${kebab(key)}': 'var(${CSS_VAR_PREFIX}-layout-${cssKey(key)})',`,
    ),
  ].join('\n');

  const radius = Object.keys(RADIUS)
    .map((key) => `    '${key}': 'var(${CSS_VAR_PREFIX}-radius-${cssKey(key)})',`)
    .join('\n');

  const shadows = Object.keys(ELEVATION)
    .map((level) => `    '${level}': 'var(${CSS_VAR_PREFIX}-elevation-${level})',`)
    .join('\n');

  // Control shadows are literal values (or var() references resolved on the
  // element), never root custom properties: see CONTROL_SHADOW in tokens.ts.
  const controlShadows = Object.entries(CONTROL_SHADOW)
    .map(([name, value]) => `    '${name}': '${value}',`)
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
    'sheet': 'var(${CSS_VAR_PREFIX}-radius-sheet)',
      },
      boxShadow: {
${shadows}
${controlShadows}
      },
      transitionDuration: {
${durations}
      },
      // \`animate-spin\` turns at the design's speed, not Tailwind's 1s.
      // The overlays' entrances (T-0129, v1.1 Patterns "Dismissal & motion":
      // a 240ms slide; under reduced motion the global layer cuts each to one
      // frame). Distances are percentages of the element, never pixels.
      animation: {
        spin: 'spin var(${CSS_VAR_PREFIX}-duration-spin) linear infinite',
        shimmer: 'k-shimmer var(${CSS_VAR_PREFIX}-duration-shimmer) ease-in-out infinite',
        'fade-in': 'k-fade-in var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
        'pop-in': 'k-pop-in var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
        'drawer-in': 'k-drawer-in var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
        'drawer-in-rtl': 'k-drawer-in-rtl var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
        'sheet-in': 'k-sheet-in var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
        'toast-in': 'k-toast-in var(${CSS_VAR_PREFIX}-duration-base) var(${CSS_VAR_PREFIX}-ease) both',
      },
      keyframes: {
        'k-shimmer': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(100%)' } },
        'k-fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'k-pop-in': { from: { opacity: '0', transform: 'scale(.97)' }, to: { opacity: '1', transform: 'none' } },
        'k-drawer-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
        'k-drawer-in-rtl': { from: { transform: 'translateX(-100%)' }, to: { transform: 'none' } },
        'k-sheet-in': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        'k-toast-in': { from: { opacity: '0', transform: 'translateY(50%)' }, to: { opacity: '1', transform: 'none' } },
      },
      // The v1.1 text links and the bulk bar's "Select all" sit 3px under
      // their text (T-0129).
      textUnderlineOffset: { 3: '3px' },
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
    // behind a variant: \`focus-visible:ring-focus\`. Never combine \`ring-focus\`
    // with a \`ring-N\` width utility: both write box-shadow, and one discards the other.
    //
    // The four state variants (T-0128) are how @kasuwa/ui/components style
    // hover, press and focus. Each also matches \`data-preview\`, so the
    // /design/components gallery can show a state at rest, the way the v1.1
    // Components page does, from the same class that styles the live state:
    //   is-hover          hover, only on devices that hover (a tap on Android
    //                     must not leave a button stuck in its hover colour),
    //                     never on a disabled control
    //   is-active         pressed, never on a disabled control
    //   is-focus-visible  keyboard focus: buttons, checkboxes, chips, tabs
    //   is-focus          any focus: text fields and selects, which show their
    //                     focus while the user types, however they got there
    function ({ addUtilities, addVariant }) {
      addVariant('is-hover', [
        '@media (hover: hover) { &:hover:not(:disabled) }',
        '&[data-preview~="hover"]',
      ]);
      addVariant('is-active', ['&:active:not(:disabled)', '&[data-preview~="active"]']);
      addVariant('is-focus-visible', ['&:focus-visible', '&[data-preview~="focus"]']);
      addVariant('is-focus', ['&:focus', '&[data-preview~="focus"]']);
      addUtilities({
${typeExtras}
        '.ring-focus': {
          'outline-style': 'none',
          'box-shadow': '${FOCUS.ring}',
          '@media (forced-colors: active)': {
            outline: '2px solid transparent',
            'outline-offset': '2px',
          },
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
