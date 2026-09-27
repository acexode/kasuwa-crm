/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Tailwind preset for Kasuwa.
 *
 * Every value points at a CSS custom property rather than a literal, so themes
 * (light/dark, and later per-tenant white-label) switch by swapping variables
 * on :root without rebuilding CSS. White-label theming is a P0 requirement
 * (PRD M1) and this is the mechanism that makes it possible.
 *
 * The variable NAMES here must match packages/ui/src/tokens.ts. They are
 * stable strings by design: when Claude Design output replaces the token
 * VALUES (D-L10), this file does not change.
 *
 * Structured so `apps/web/tailwind.config.ts` is three lines:
 *   presets: [require('@kasuwa/ui/tailwind-preset')]
 */

const FAMILIES = ['primary', 'accent', 'success', 'warning', 'danger', 'info', 'neutral'];
const TONES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const TYPE_STEPS = [
  'display', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'body-lg', 'body-md', 'body-sm', 'caption',
];
const SPACE_KEYS = [
  '0', 'px', '0.5', '1', '2', '3', '4', '5', '6', '8', '10', '12', '16', '20', '24', 'touch',
];
const RADIUS_KEYS = ['none', 'sm', 'md', 'lg', 'xl', 'full'];
const SEMANTIC_KEYS = [
  'surface', 'surface-raised', 'surface-sunken',
  'border', 'border-strong',
  'text-primary', 'text-secondary', 'text-muted', 'text-on-primary',
  'action-primary', 'action-primary-hover',
  'focus-ring',
];

function scale() {
  const colours = {};
  for (const family of FAMILIES) {
    colours[family] = Object.fromEntries(
      TONES.map((tone) => [tone, `var(--kasuwa-${family}-${tone})`]),
    );
  }
  for (const token of SEMANTIC_KEYS) {
    colours[token] = `var(--kasuwa-${token})`;
  }
  return colours;
}

module.exports = {
  theme: {
    extend: {
      colors: scale(),
      fontFamily: {
        sans: ['var(--kasuwa-font-sans)'],
        arabic: ['var(--kasuwa-font-arabic)'],
        mono: ['var(--kasuwa-font-mono)'],
      },
      fontSize: Object.fromEntries(
        TYPE_STEPS.map((step) => [
          step,
          [
            `var(--kasuwa-font-size-${step})`,
            {
              lineHeight: `var(--kasuwa-line-height-${step})`,
              fontWeight: `var(--kasuwa-font-weight-${step})`,
              letterSpacing: `var(--kasuwa-tracking-${step})`,
            },
          ],
        ]),
      ),
      spacing: Object.fromEntries(SPACE_KEYS.map((key) => [key, `var(--kasuwa-space-${key})`])),
      borderRadius: Object.fromEntries(
        RADIUS_KEYS.map((key) => [key, `var(--kasuwa-radius-${key})`]),
      ),
      ringColor: { DEFAULT: 'var(--kasuwa-focus-ring)' },
      minHeight: { touch: 'var(--kasuwa-space-touch)' },
      minWidth: { touch: 'var(--kasuwa-space-touch)' },
    },
  },
};
