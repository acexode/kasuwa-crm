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
  /** The caption step, and secondary bottom-bar labels. */
  medium: '500',
  semibold: '600',
  /** Card titles, overlines, badges: the screen exports' most-used weight. */
  bold: '700',
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

  // -------------------------------------------------------------------------
  // The screen exports' vocabulary (T-0127, D-L193).
  //
  // The v1.1 ramp above is the design system page. The screen exports use a
  // second set of sizes that the ramp does not list, hundreds of times each
  // (team/reports/ui-audit/foundations.md section 1 has the counts). Without
  // these steps every builder rounded 13px to 12 or 14 and 28px/800 to
  // 32px/700, and every screen came out bigger and looser than its design.
  // Use the step the export uses; never round to a neighbour.
  // -------------------------------------------------------------------------

  /** P01 brand-panel headline: 44/52/800, -0.88px tracking (measured in the P01 export). */
  headline: { size: '44px', lineHeight: '52px', weight: '800', tracking: '-0.02em' },
  /** Page title on lists (P04, P07): 28/36/800. */
  title: { size: '28px', lineHeight: '36px', weight: '800', tracking: '-0.01em' },
  /** Page title on records and admin (P05, P02): 26/34/800. */
  'title-sm': { size: '26px', lineHeight: '34px', weight: '800', tracking: '0' },
  /** Card and section titles: 16/24/700. */
  'card-title': { size: '16px', lineHeight: '24px', weight: '700', tracking: '0' },
  /** Button labels, input values, settings-nav rows: 15/22/600. */
  label: { size: '15px', lineHeight: '22px', weight: '600', tracking: '0' },
  /** Meta lines, helper text, toolbar chips: 13/19/400 (chips set their own 600). */
  meta: { size: '13px', lineHeight: '19px', weight: '400', tracking: '0' },
  /**
   * Count badges, small tags (network, DND) and kbd keys: 11/16/700, in the
   * case it was written (T-0128). Kbd sets its own 400. The caps step below is
   * a different thing: an overline is a label, these are values.
   */
  micro: { size: '11px', lineHeight: '16px', weight: '700', tracking: '0' },
  /** The logo tile's letter: 17/20/800 (every shell export; T-0130). */
  logo: { size: '17px', lineHeight: '20px', weight: '800', tracking: '0' },
  /** The icon rail's labels under each 22px glyph: 10/14/600 (P03, P04; T-0130). */
  'rail-label': { size: '10px', lineHeight: '14px', weight: '600', tracking: '0' },
  /** Menu section labels, kbd, bottom-nav labels: 11/16/700 caps at 0.06em. */
  overline: {
    size: '11px',
    lineHeight: '16px',
    weight: '700',
    tracking: '0.06em',
    transform: 'uppercase',
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

/**
 * 4px base. Keys are multiples, so `space-4` is 16px.
 *
 * The half steps 6, 10 and 14px are the screen exports' most common gaps (6px
 * alone appears 585 times). They are explicit tokens so `gap-1.5` reads the
 * design system rather than Tailwind's default ramp (T-0127).
 *
 * T-0128 adds the four the v1.1 controls need, keyed the same way (key x 4):
 *   0.75 3px  pill and badge padding (3px 10px), the segmented track's padding,
 *             the switch knob's inset
 *   2.25 9px  a consent pill's side padding (3px 9px)
 *   4.5 18px  how far the switch knob travels (44 - 20 - 3 - 3)
 *   6.5 26px  the switch track's height
 */
export const SPACING = {
  '0': '0px',
  '0.75': '3px',
  '1': '4px',
  '1.5': '6px',
  '2': '8px',
  '2.25': '9px',
  '2.5': '10px',
  '3': '12px',
  '3.5': '14px',
  '4': '16px',
  '4.5': '18px',
  '5': '20px',
  '6': '24px',
  '6.5': '26px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  /** WCAG 2.2 AA minimum target size. Not from the 4px ramp; it is a floor. */
  touch: '44px',
} as const;

/**
 * The named steps are v1.1's. The numeric ones are the screen exports' (T-0127):
 * 6px for menu rows, segmented items and chips; 10px for menus, popovers,
 * toasts, table wrappers and rail items; 14px for dialogs. Named by their pixel
 * value because they sit between the named steps, not after them.
 */
export const RADIUS = {
  sm: '4px',
  '6': '6px',
  md: '8px',
  '10': '10px',
  lg: '12px',
  '14': '14px',
  xl: '16px',
  full: '999px',
} as const;

/**
 * Control heights (T-0127), from the v1.1 Components page and the screen
 * exports:
 *
 *   sm   36  compact desktop controls: toolbar chips, segmented items, Columns.
 *           Desktop only, and the control still keeps a 44px hit area.
 *   md   40  header search, menu rows, table header.
 *   base 44  form controls and standard buttons. The same value as `touch`.
 *   lg   48  mobile inputs, icon buttons and the phone app bar's buttons.
 *   xl   52  mobile full-width primary buttons.
 *
 * `SPACING.touch` stays the WCAG 2.2 floor; this is the visual height, which
 * may be smaller than the target only where the hit area is padded back out.
 */
export const CONTROL_HEIGHT = {
  sm: '36px',
  md: '40px',
  base: '44px',
  lg: '48px',
  xl: '52px',
} as const;

/**
 * Icon sizes (T-0127). An icon's own scale, NOT the type scale: a type step
 * also sets its own font weight. In the Claude Design exports an icon inherits
 * the weight of the text around it, and the browser synthesises bold from the
 * weight-400 face (D-L198); a size class must not override that. Keyed by
 * pixel size so a builder copies the export's number rather than mapping it.
 *
 * Counts in the screen exports: 20 (293), 18 (271), 22 (123: rail, header
 * buttons, icon buttons, bottom nav), 16 (107: table sort, chip close), 15 (63:
 * consent pills), 14 (53), 24, 28 and 32.
 */
export const ICON_SIZE = {
  14: '14px',
  15: '15px',
  16: '16px',
  18: '18px',
  20: '20px',
  22: '22px',
  24: '24px',
  28: '28px',
  32: '32px',
} as const;

export type IconSize = keyof typeof ICON_SIZE;

/**
 * The four names `<Icon size>` took before T-0127, kept so existing screens
 * render unchanged: each is the pixel size its type step used to give it.
 * New code passes the export's pixel size instead.
 */
export const ICON_SIZE_ALIAS = {
  sm: 18,
  md: 20,
  lg: 24,
  xl: 32,
} as const satisfies Record<string, IconSize>;

export type IconSizeAlias = keyof typeof ICON_SIZE_ALIAS;

/** The pixel size an icon renders at, for a pixel size or a legacy alias. */
export function resolveIconSize(size: IconSize | IconSizeAlias): IconSize {
  return typeof size === 'number' ? size : ICON_SIZE_ALIAS[size];
}

/**
 * App-shell dimensions (T-0127), from the screen exports (P03, P04, P05, P02):
 *
 *   header        60  desktop top bar
 *   rail          72  the sunken icon rail, at 1440 and 1024
 *   railItemWidth 56, railItemHeight 52: a rail item
 *   adminNav     272  the admin settings nav
 *   bottomBar     64  the phone bottom bar
 *   mobileHeader  56  the phone's per-screen app bar
 *   search       420  the top bar's inline search field (flex 0 1 420px, T-0130)
 *   fab           56  the phone's extended "+ New" button (T-0130)
 */
export const SHELL = {
  header: '60px',
  rail: '72px',
  railItemWidth: '56px',
  railItemHeight: '52px',
  adminNav: '272px',
  bottomBar: '64px',
  mobileHeader: '56px',
  search: '420px',
  fab: '56px',
} as const;

/**
 * Page-column widths (T-0131), from the P01 export (`Kasuwa Auth and
 * Onboarding`). Every auth and setup screen sits in one of these; the nearest
 * Tailwind widths (448/512/576/672) made each screen looser than its design.
 *
 *   authPanel      520  the brand panel beside every auth screen, desktop
 *   authHeader      64  the auth and setup top bar
 *   column         400  sign in, SSO, locked, slow, two-step verification
 *   columnVerify   440  sign-up verification (P01/4)
 *   columnWide     520  sign up (P01/3) and setup complete (P01/6)
 *   wizard         640  the setup wizard's step body (P01/5.x)
 *   wizardStepper  880  the setup wizard's stepper
 */
export const LAYOUT = {
  authPanel: '520px',
  authHeader: '64px',
  column: '400px',
  columnVerify: '440px',
  columnWide: '520px',
  wizard: '640px',
  wizardStepper: '880px',
} as const;

/**
 * Focus treatments (T-0127), from the v1.1 Components page. Two shapes, not one:
 *
 *   ring   buttons, checkboxes, radios, chips: a 2px surface gap, then a 2px
 *          focus ring, so the ring reads on any fill.
 *   field  inputs and selects: a primary border plus a 3px primary-soft-strong
 *          halo.
 *
 * Both are box-shadows. In forced-colours mode box-shadow is dropped, so each
 * utility also draws a transparent outline there, which the browser paints in
 * the system colour. `ring-focus` draws that outline ONLY in forced-colours
 * mode and sets `outline-style: none` otherwise: the v1.1 ring is the whole
 * focus indicator, and a transparent outline left in place still reports
 * `outline-style: solid` (T-0128). `field-focus` keeps its outline as T-0127
 * built it.
 *
 * Emitted only as the `ring-focus` and `field-focus` utilities, never as a
 * `:root` custom property: a custom property resolves its `var()`s where it is
 * declared, so the ring's surface gap would be the ROOT surface, not the
 * surface the control actually sits on.
 */
export const FOCUS = {
  ring: `0 0 0 2px var(${CSS_VAR_PREFIX}-surface), 0 0 0 4px var(${CSS_VAR_PREFIX}-focus)`,
  field: `0 0 0 3px var(${CSS_VAR_PREFIX}-primary-soft-strong)`,
  fieldBorder: `var(${CSS_VAR_PREFIX}-primary)`,
} as const;

/**
 * Shadows that belong to one control rather than to the elevation scale
 * (T-0128). Emitted only as Tailwind `shadow-*` utilities, never as `:root`
 * custom properties, for the same reason as FOCUS: `switch-disabled` reads
 * `--k-border` on the element that draws it.
 *
 *   knob             the switch knob, v1.1 Components "Toggle". A literal in
 *                    the export, the same in both themes.
 *   switch-disabled  the admin-locked switch's 1px inner edge, from the same
 *                    place: a disabled track is disabled-bg, which on a surface
 *                    needs an edge to read as a control at all.
 */
export const CONTROL_SHADOW = {
  knob: '0 1px 2px rgba(0,0,0,.3)',
  'switch-disabled': `inset 0 0 0 1px var(${CSS_VAR_PREFIX}-border)`,
} as const;

/** `railItemWidth` -> `rail-item-width`, for CSS variable and utility names. */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * A token key as it appears in a CSS custom property name. `1.5` is not a
 * legal identifier character sequence, so a half step becomes `1_5`:
 * `--k-space-1_5`. The Tailwind key stays `1.5` (`gap-1.5`).
 */
export function cssKey(key: string): string {
  return kebab(key).replace('.', '_');
}

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
  /**
   * One turn of the loading spinner (v1.1 Components: `kspin .8s linear
   * infinite`). Under reduced motion the global layer stops it after one frame,
   * which leaves the static ring the export asks for.
   */
  spin: { duration: '800ms', use: 'Loading spinner, one turn' },
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
