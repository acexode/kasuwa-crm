/**
 * Kasuwa design tokens — Design v1.1, approved.
 *
 * This replaces the provisional scales the scaffold generated from three brand
 * anchors (D-L10, now closed). The source of truth is the Claude Design export
 * committed unchanged under `docs/design/v1.1/`.
 *
 * Two halves, for a reason:
 *
 *   - Colours (scales + both semantic token sets) are MACHINE-EXTRACTED into
 *     `tokens.colours.generated.ts` by `pnpm ui:import-design`. That is over a
 *     hundred and fifty hex values; hand-transcription would be wrong somewhere,
 *     and a mistyped digit in a semantic token is a contrast failure nobody
 *     spots by eye.
 *   - Type, spacing, radius, elevation and motion are HAND-ENCODED below,
 *     because the export carries them as rendered markup rather than as data.
 *     Each block cites the section it came from so it can be checked.
 *
 * Nothing here may be edited to make a contrast test pass. If a token cannot
 * meet AA in the role it is used for, that is a finding about the design, and
 * it goes to the human — not into a lowered threshold.
 */

export {
  COLOUR_SCALES,
  DESIGN_VERSION,
  SCALE_ANCHORS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SEMANTIC_TOKEN_NAMES,
  type ColourFamily,
  type Scale,
  type SemanticToken,
  type ToneKey,
} from './tokens.colours.generated';

import { SEMANTIC_LIGHT, type SemanticToken } from './tokens.colours.generated';

/** Every CSS custom property this system emits is prefixed `--k-`. */
export const CSS_VAR_PREFIX = '--k';

// ---------------------------------------------------------------------------
// Typography — export section "02 Typography"
//
// Noto Sans, Noto Sans Arabic and JetBrains Mono: all open-licence, with full
// Latin Extended A/B plus Additional, which is what Yoruba, Igbo and Hausa
// diacritics need (ẹ ọ ṣ ɓ ɗ ƙ ƴ ŋ ɛ ɔ).
//
// The export is explicit that body line-height never drops below 1.4, so
// stacked tone marks (ọ̀, ẹ́) clear the line above. Check that before changing
// any line-height: it is a legibility requirement in three of our languages,
// not a typographic preference.
// ---------------------------------------------------------------------------

export const FONT_FAMILIES = {
  sans: "'Noto Sans', 'Noto Sans Arabic', system-ui, sans-serif",
  arabic: "'Noto Sans Arabic', 'Noto Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace",
  icon: "'Material Symbols Rounded'",
} as const;

export const FONT_WEIGHTS = {
  regular: '400',
  semibold: '600',
  extrabold: '800',
} as const;

export interface TypeStep {
  size: string;
  lineHeight: string;
  weight: string;
  tracking: string;
  /** Set where the export specifies it; h6 is the only caps step. */
  transform?: string;
  /** Tabular figures, so numbers in tables and money do not jitter. */
  fontFeature?: string;
}

export const TYPE_SCALE = {
  display: { size: '56px', lineHeight: '64px', weight: '800', tracking: '-0.02em' },
  h1: { size: '40px', lineHeight: '48px', weight: '700', tracking: '-0.01em' },
  h2: { size: '32px', lineHeight: '40px', weight: '700', tracking: '0' },
  h3: { size: '24px', lineHeight: '32px', weight: '700', tracking: '0' },
  h4: { size: '20px', lineHeight: '28px', weight: '600', tracking: '0' },
  h5: { size: '18px', lineHeight: '26px', weight: '600', tracking: '0' },
  h6: {
    size: '14px',
    lineHeight: '20px',
    weight: '700',
    tracking: '0.06em',
    transform: 'uppercase',
  },
  'body-lg': { size: '18px', lineHeight: '28px', weight: '400', tracking: '0' },
  'body-md': { size: '16px', lineHeight: '24px', weight: '400', tracking: '0' },
  'body-sm': { size: '14px', lineHeight: '20px', weight: '400', tracking: '0' },
  caption: { size: '12px', lineHeight: '16px', weight: '500', tracking: '0' },
  mono: {
    size: '14px',
    lineHeight: '20px',
    weight: '400',
    tracking: '0',
    fontFeature: "'tnum' 1",
  },
} as const satisfies Record<string, TypeStep>;

export type TypeScaleStep = keyof typeof TYPE_SCALE;

/**
 * Arabic script sits taller in the same point size, so the export gives it
 * +10% line-height. Applied via `[lang="ar"]` in the emitted CSS.
 */
export const ARABIC_LINE_HEIGHT_MULTIPLIER = 1.1;

// ---------------------------------------------------------------------------
// Spacing, radius, elevation, motion — export section "03 Foundations"
// ---------------------------------------------------------------------------

/** 4px base. Keys are multiples, so `space-4` is 16px. */
export const SPACING = {
  '0': '0px',
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  /** WCAG 2.2 AA minimum target size. Not from the 4px ramp; it is a floor. */
  touch: '44px',
} as const;

export const RADIUS = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  full: '999px',
} as const;

/**
 * Elevation 0 is flat with a border, not a faint shadow — a border survives
 * both themes and low-quality screens, which a 4% shadow does not.
 * The shadow values themselves are semantic tokens, so they differ per theme:
 * dark elevation is a lighter surface plus a deeper shadow.
 */
export const ELEVATION = {
  '0': { shadow: 'none', use: 'Flat, bordered' },
  '1': { shadow: 'var(--k-shadow-1)', use: 'Cards' },
  '2': { shadow: 'var(--k-shadow-2)', use: 'Menus, toasts' },
  '3': { shadow: 'var(--k-shadow-3)', use: 'Modals, drawers' },
} as const;

export const MOTION = {
  instant: { duration: '100ms', use: 'Hover, press' },
  quick: { duration: '160ms', use: 'Toggles, tabs, chips' },
  base: { duration: '240ms', use: 'Menus, toasts, drawers' },
} as const;

export const MOTION_EASING = 'cubic-bezier(.2,.8,.2,1)';

// ---------------------------------------------------------------------------
// Charts
//
// The seven chart colours are semantic tokens (they differ per theme) and are
// chosen to stay distinguishable for the common forms of colour vision
// deficiency. Series must still carry a label or shape — colour alone is never
// the only channel.
// ---------------------------------------------------------------------------

export const CHART_SERIES_COUNT = 7;

export const CHART_TOKENS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
] as const satisfies readonly SemanticToken[];

// ---------------------------------------------------------------------------
// Contrast contract
//
// These pairs are asserted in both themes by tokens.contrast.test.ts, and the
// suite runs in CI. The thresholds come from the T-0003 hand-off and from
// WCAG 2.2 AA: 4.5:1 for body text, 3:1 for non-text UI boundaries.
//
// DO NOT lower a minimum. If a token cannot meet its threshold, the design
// changes or the token's role changes.
// ---------------------------------------------------------------------------

export interface ContrastPair {
  foreground: SemanticToken;
  background: SemanticToken;
  minimumRatio: number;
  note: string;
}

const STATUS_FAMILIES = ['primary', 'accent', 'success', 'warning', 'danger', 'info'] as const;

/** Every `*-text` colour on its own `*-soft` background. */
const STATUS_TEXT_PAIRS: ContrastPair[] = STATUS_FAMILIES.map((family) => ({
  foreground: `${family}-text` as SemanticToken,
  background: `${family}-soft` as SemanticToken,
  minimumRatio: 4.5,
  note: `${family} text on its own soft fill — badges, banners, chips`,
}));

/** Muted text is the smallest, lowest-contrast text in the system. */
const MUTED_TEXT_PAIRS: ContrastPair[] = (
  ['surface', 'surface-raised', 'surface-sunken'] as SemanticToken[]
).map((background) => ({
  foreground: 'text-muted' as SemanticToken,
  background,
  minimumRatio: 4.5,
  note: 'hints, meta and captions must clear AA like any other text',
}));

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...STATUS_TEXT_PAIRS,
  ...MUTED_TEXT_PAIRS,
  {
    foreground: 'on-primary',
    background: 'primary',
    minimumRatio: 4.5,
    note: 'label on the primary action fill',
  },
  {
    // 3:1 is WCAG 2.2 non-text contrast: an input boundary you cannot see is
    // not a boundary. The export names this token exactly that way.
    foreground: 'border-strong',
    background: 'surface',
    minimumRatio: 3,
    note: 'input and control boundaries',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function semanticVar(token: SemanticToken): string {
  return `${CSS_VAR_PREFIX}-${token}`;
}

export function scaleVar(family: string, tone: string): string {
  return `${CSS_VAR_PREFIX}-scale-${family}-${tone}`;
}

/** Runtime guard: the contrast contract must only name tokens that exist. */
export function assertContrastPairsAreValid(): void {
  for (const pair of CONTRAST_PAIRS) {
    if (!(pair.foreground in SEMANTIC_LIGHT)) {
      throw new Error(`Contrast pair names unknown token "${pair.foreground}"`);
    }
    if (!(pair.background in SEMANTIC_LIGHT)) {
      throw new Error(`Contrast pair names unknown token "${pair.background}"`);
    }
  }
}
