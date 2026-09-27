/**
 * Kasuwa design tokens — PROVISIONAL.
 *
 * ==========================================================================
 * THESE ARE NOT THE BRAND YET. team/DECISIONS.md D-L10.
 *
 * Founding pack Prompt 0 gives three anchors — deep indigo #2B2A8C, saffron
 * #F2A900, a success green #0B8A4B — plus "warm greys", and leaves the tonal
 * scales to Claude Design. The scales below were derived from those anchors so
 * the scaffold has something real to render and to contrast-test. Agent 11's
 * first task is to run Prompt 0 and replace this file wholesale.
 *
 * What IS settled and must survive that replacement:
 *   - this file is the single source of truth for colour, type and spacing
 *   - packages/ui/src/tokens.css is GENERATED from it (pnpm ui:tokens)
 *   - no hex value may appear anywhere else in the repo (lint-enforced)
 *   - every foreground/background pair in SEMANTIC_CONTRAST_PAIRS is asserted
 *     at WCAG 2.2 AA in a unit test, in both themes
 * ==========================================================================
 */

export type ToneKey =
  '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';
export type Scale = Record<ToneKey, string>;

export const COLOUR_SCALES = {
  /** Brand primary. Anchor #2B2A8C sits at 600. */
  primary: {
    '50': '#eeeefb',
    '100': '#dcdcf6',
    '200': '#b9b9ed',
    '300': '#9695e3',
    '400': '#7371da',
    '500': '#4f4dc9',
    '600': '#2b2a8c',
    '700': '#232375',
    '800': '#1b1b5d',
    '900': '#141446',
    '950': '#0c0c2e',
  },
  /** Warm accent. Anchor #F2A900 sits at 500. Used for emphasis, never for text on light. */
  accent: {
    '50': '#fef6e6',
    '100': '#fdebc2',
    '200': '#fbd787',
    '300': '#f9c44d',
    '400': '#f7b524',
    '500': '#f2a900',
    '600': '#c98c00',
    '700': '#a06f00',
    '800': '#775300',
    '900': '#4e3600',
    '950': '#2a1d00',
  },
  /** Success. Anchor #0B8A4B sits at 500. */
  success: {
    '50': '#e7f6ee',
    '100': '#c6ead6',
    '200': '#8dd5ae',
    '300': '#54c085',
    '400': '#24a867',
    '500': '#0b8a4b',
    '600': '#09713d',
    '700': '#07582f',
    '800': '#053f22',
    '900': '#042e19',
    '950': '#021b0f',
  },
  warning: {
    '50': '#fef3e7',
    '100': '#fce0c2',
    '200': '#f9c185',
    '300': '#f5a248',
    '400': '#f28a1b',
    '500': '#d97406',
    '600': '#b25f05',
    '700': '#8b4a04',
    '800': '#653503',
    '900': '#422202',
    '950': '#251301',
  },
  danger: {
    '50': '#fdecec',
    '100': '#fad1d1',
    '200': '#f3a3a3',
    '300': '#ec7575',
    '400': '#e54b4b',
    '500': '#d92d2d',
    '600': '#b62424',
    '700': '#921c1c',
    '800': '#6e1515',
    '900': '#4a0e0e',
    '950': '#2a0808',
  },
  info: {
    '50': '#e9f2fe',
    '100': '#cce0fc',
    '200': '#99c1f9',
    '300': '#66a2f5',
    '400': '#3384f2',
    '500': '#0a66de',
    '600': '#0854b6',
    '700': '#06418e',
    '800': '#042f66',
    '900': '#031f44',
    '950': '#011226',
  },
  /** Warm greys, per Prompt 0 — not blue-greys. */
  neutral: {
    '50': '#faf9f7',
    '100': '#f2f0ec',
    '200': '#e4e1da',
    '300': '#cfcbc1',
    '400': '#a8a398',
    '500': '#807b70',
    '600': '#605c54',
    '700': '#47443e',
    '800': '#2f2d29',
    '900': '#1b1a17',
    '950': '#0e0d0c',
  },
} as const satisfies Record<string, Scale>;

export type ColourFamily = keyof typeof COLOUR_SCALES;

/** Semantic tokens. Components reference these, never a raw scale step. */
export const SEMANTIC_LIGHT = {
  surface: COLOUR_SCALES.neutral['50'],
  'surface-raised': '#ffffff',
  'surface-sunken': COLOUR_SCALES.neutral['100'],
  border: COLOUR_SCALES.neutral['200'],
  // 500, not 300: WCAG 2.2 requires 3:1 for non-text UI boundaries, and a
  // border that only a designer can see is not a boundary. `border` above is
  // decorative hairline separation and is deliberately not held to that bar.
  'border-strong': COLOUR_SCALES.neutral['500'],
  'text-primary': COLOUR_SCALES.neutral['900'],
  'text-secondary': COLOUR_SCALES.neutral['700'],
  'text-muted': COLOUR_SCALES.neutral['600'],
  'text-on-primary': '#ffffff',
  'action-primary': COLOUR_SCALES.primary['600'],
  'action-primary-hover': COLOUR_SCALES.primary['700'],
  'focus-ring': COLOUR_SCALES.primary['500'],
} as const;

export const SEMANTIC_DARK = {
  surface: COLOUR_SCALES.neutral['950'],
  'surface-raised': COLOUR_SCALES.neutral['900'],
  'surface-sunken': '#000000',
  border: COLOUR_SCALES.neutral['800'],
  'border-strong': COLOUR_SCALES.neutral['500'],
  'text-primary': COLOUR_SCALES.neutral['50'],
  'text-secondary': COLOUR_SCALES.neutral['200'],
  'text-muted': COLOUR_SCALES.neutral['400'],
  // Dark theme inverts the button: a light primary fill with a dark label.
  // The instinct is to keep white text and darken the fill, but white on any
  // primary step dark enough to sit on a near-black page measures below 4.5:1.
  // A light fill also reads as the raised, actionable element on a dark ground,
  // which is what a primary button is for.
  'text-on-primary': COLOUR_SCALES.neutral['950'],
  'action-primary': COLOUR_SCALES.primary['300'],
  'action-primary-hover': COLOUR_SCALES.primary['200'],
  'focus-ring': COLOUR_SCALES.primary['300'],
} as const;

export type SemanticToken = keyof typeof SEMANTIC_LIGHT;

/**
 * Pairs asserted at WCAG 2.2 AA by tokens.contrast.test.ts, in both themes.
 * The NFRs commit to AA (PRD 2.13) and agents work at speed; an executable
 * rule beats a note in a style guide.
 */
export const SEMANTIC_CONTRAST_PAIRS: readonly {
  foreground: SemanticToken;
  background: SemanticToken;
  /** 4.5 for body text, 3 for large text and UI boundaries. */
  minimumRatio: number;
}[] = [
  { foreground: 'text-primary', background: 'surface', minimumRatio: 4.5 },
  { foreground: 'text-primary', background: 'surface-raised', minimumRatio: 4.5 },
  { foreground: 'text-secondary', background: 'surface', minimumRatio: 4.5 },
  { foreground: 'text-muted', background: 'surface', minimumRatio: 4.5 },
  { foreground: 'text-on-primary', background: 'action-primary', minimumRatio: 4.5 },
  { foreground: 'text-on-primary', background: 'action-primary-hover', minimumRatio: 4.5 },
  // 3:1 is WCAG 2.2's non-text contrast bar: the button must be distinguishable
  // from the page it sits on, not only legible once you have found it.
  { foreground: 'action-primary', background: 'surface', minimumRatio: 3 },
  { foreground: 'border-strong', background: 'surface', minimumRatio: 3 },
  { foreground: 'focus-ring', background: 'surface', minimumRatio: 3 },
];

/**
 * Type scale. Prompt 0 asks for a humanist sans with full Latin Extended so
 * Yoruba/Igbo/Hausa diacritics (ẹ ọ ṣ ɓ ɗ ƙ) render, plus an Arabic fallback.
 * Mono is for ids, E.164 phone numbers and currency in tables.
 */
export const FONT_FAMILIES = {
  sans: "'Inter', 'Noto Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
  arabic: "'Noto Naskh Arabic', 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Mono', ui-monospace, 'Courier New', monospace",
} as const;

export const TYPE_SCALE = {
  display: { size: '2.75rem', lineHeight: '3.25rem', weight: '700', tracking: '-0.02em' },
  h1: { size: '2rem', lineHeight: '2.5rem', weight: '700', tracking: '-0.015em' },
  h2: { size: '1.5rem', lineHeight: '2rem', weight: '600', tracking: '-0.01em' },
  h3: { size: '1.25rem', lineHeight: '1.75rem', weight: '600', tracking: '0' },
  h4: { size: '1.125rem', lineHeight: '1.625rem', weight: '600', tracking: '0' },
  h5: { size: '1rem', lineHeight: '1.5rem', weight: '600', tracking: '0' },
  h6: { size: '0.875rem', lineHeight: '1.25rem', weight: '600', tracking: '0.01em' },
  'body-lg': { size: '1rem', lineHeight: '1.625rem', weight: '400', tracking: '0' },
  'body-md': { size: '0.875rem', lineHeight: '1.375rem', weight: '400', tracking: '0' },
  'body-sm': { size: '0.8125rem', lineHeight: '1.25rem', weight: '400', tracking: '0' },
  caption: { size: '0.75rem', lineHeight: '1rem', weight: '500', tracking: '0.01em' },
} as const;

export type TypeScaleStep = keyof typeof TYPE_SCALE;

/** 4px base. `touch` is the 44px WCAG 2.2 AA target size from Prompt 0. */
export const SPACING = {
  '0': '0',
  px: '1px',
  '0.5': '0.125rem',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
  '20': '5rem',
  '24': '6rem',
  touch: '2.75rem',
} as const;

export const RADIUS = {
  none: '0',
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  full: '9999px',
} as const;

export const CSS_VAR_PREFIX = '--kasuwa';

export function colourVar(family: ColourFamily, tone: ToneKey): string {
  return `${CSS_VAR_PREFIX}-${family}-${tone}`;
}

export function semanticVar(token: SemanticToken): string {
  return `${CSS_VAR_PREFIX}-${token}`;
}
