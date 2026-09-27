/**
 * GENERATED FILE — do not edit.
 *
 * Source: docs/design/v1.1/Kasuwa Design System.dc.html
 * Regenerate: pnpm ui:import-design
 *
 * CI regenerates this and fails on any diff, so editing it by hand will be
 * reverted by the next run. Change the design export, or change the importer.
 */

export const DESIGN_VERSION = 'v1.1';

export type ToneKey =
  '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';

export type Scale = Record<ToneKey, string>;

/** The seven 50–950 scales from the export. */
export const COLOUR_SCALES = {
  /** Primary · Indigo. Brand anchor at 700. */
  primary: {
    '50': '#eeeefa',
    '100': '#dcdcf5',
    '200': '#bbbaec',
    '300': '#9391df',
    '400': '#6d6acf',
    '500': '#4e4bbe',
    '600': '#3c39a8',
    '700': '#2b2a8c',
    '800': '#22216f',
    '900': '#1a1955',
    '950': '#100f36',
  },
  /** Accent · Saffron. Brand anchor at 500. */
  accent: {
    '50': '#fef8e7',
    '100': '#fdeec2',
    '200': '#fbdd85',
    '300': '#f8c947',
    '400': '#f5b81a',
    '500': '#f2a900',
    '600': '#cc8a00',
    '700': '#a06a00',
    '800': '#7a5104',
    '900': '#5c3d07',
    '950': '#362303',
  },
  /** Success · Green. Brand anchor at 600. */
  success: {
    '50': '#e8f6ee',
    '100': '#c6ead5',
    '200': '#93d6af',
    '300': '#58bd84',
    '400': '#27a262',
    '500': '#129553',
    '600': '#0b8a4b',
    '700': '#086e3c',
    '800': '#075630',
    '900': '#064226',
    '950': '#032716',
  },
  /** Warning · Orange. */
  warning: {
    '50': '#fff4eb',
    '100': '#ffe3cc',
    '200': '#ffc599',
    '300': '#ffa15c',
    '400': '#f97f2a',
    '500': '#e8650f',
    '600': '#c4500a',
    '700': '#9c3f0b',
    '800': '#7a330f',
    '900': '#5e2a10',
    '950': '#361606',
  },
  /** Danger · Red. */
  danger: {
    '50': '#fdeeee',
    '100': '#fad5d5',
    '200': '#f4aaaa',
    '300': '#ec7777',
    '400': '#e04a4a',
    '500': '#cc2e2e',
    '600': '#b02222',
    '700': '#8f1c1c',
    '800': '#721a1a',
    '900': '#5a1717',
    '950': '#340b0b',
  },
  /** Info · Blue. */
  info: {
    '50': '#e9f4fb',
    '100': '#cbe5f5',
    '200': '#97cbeb',
    '300': '#5caedd',
    '400': '#2e92cc',
    '500': '#1479b4',
    '600': '#0e6396',
    '700': '#0d4f78',
    '800': '#0e405f',
    '900': '#0d334a',
    '950': '#07202f',
  },
  /** Neutral · Warm grey. */
  neutral: {
    '50': '#faf8f5',
    '100': '#f3f0eb',
    '200': '#e6e1d9',
    '300': '#d2cbc0',
    '400': '#aba398',
    '500': '#847c71',
    '600': '#665f56',
    '700': '#4e4841',
    '800': '#37322d',
    '900': '#24201c',
    '950': '#151210',
  },
} as const satisfies Record<string, Scale>;

export type ColourFamily = keyof typeof COLOUR_SCALES;

/** Step that carries the brand anchor, where the scale has one. */
export const SCALE_ANCHORS: Partial<Record<ColourFamily, number>> = {
  primary: 700,
  accent: 500,
  success: 600,
};

/** Semantic tokens, light theme. Keys are the `--k-` name without the prefix. */
export const SEMANTIC_LIGHT = {
  bg: '#FAF8F5',
  surface: '#FFFFFF',
  'surface-raised': '#FFFFFF',
  'surface-sunken': '#F3F0EB',
  border: '#E6E1D9',
  'border-strong': '#847C71',
  text: '#24201C',
  'text-2': '#4E4841',
  'text-muted': '#665F56',
  primary: '#2B2A8C',
  'primary-hover': '#22216F',
  'primary-active': '#1A1955',
  'on-primary': '#FFFFFF',
  'primary-soft': '#EEEEFA',
  'primary-soft-strong': '#DCDCF5',
  'primary-text': '#3C39A8',
  accent: '#F2A900',
  'accent-soft': '#FEF8E7',
  'on-accent': '#24201C',
  'accent-text': '#7A5104',
  success: '#0B8A4B',
  'success-soft': '#E8F6EE',
  'success-text': '#086E3C',
  warning: '#E8650F',
  'warning-soft': '#FFF4EB',
  'warning-text': '#9C3F0B',
  danger: '#B02222',
  'danger-hover': '#8F1C1C',
  'danger-active': '#721A1A',
  'danger-soft': '#FDEEEE',
  'danger-text': '#8F1C1C',
  info: '#0E6396',
  'info-soft': '#E9F4FB',
  'info-text': '#0D4F78',
  'disabled-bg': '#F3F0EB',
  'disabled-text': '#ABA398',
  focus: '#4E4BBE',
  'shadow-1': '0 1px 2px rgba(36,32,28,.08)',
  'shadow-2': '0 4px 12px rgba(36,32,28,.10)',
  'shadow-3': '0 16px 40px rgba(36,32,28,.18)',
  scrim: 'rgba(21,18,16,.48)',
  'wa-bubble': '#DDF4E6',
  'note-bg': '#FEF8E7',
  inverse: '#24201C',
  'on-inverse': '#FAF8F5',
  shimmer: 'rgba(255,255,255,.7)',
  'chart-1': '#2B2A8C',
  'chart-2': '#E69F00',
  'chart-3': '#56B4E9',
  'chart-4': '#009E73',
  'chart-5': '#D55E00',
  'chart-6': '#CC79A7',
  'chart-7': '#847C71',
} as const;

/** Semantic tokens, dark theme. Same key set as light — the importer enforces it. */
export const SEMANTIC_DARK = {
  bg: '#151210',
  surface: '#1E1A17',
  'surface-raised': '#29241F',
  'surface-sunken': '#171411',
  border: '#37322D',
  'border-strong': '#8A8277',
  text: '#FAF8F5',
  'text-2': '#D2CBC0',
  'text-muted': '#ABA398',
  primary: '#5754C4',
  'primary-hover': '#6360CB',
  'primary-active': '#4E4BBE',
  'on-primary': '#FFFFFF',
  'primary-soft': '#232150',
  'primary-soft-strong': '#2F2D68',
  'primary-text': '#BBBAEC',
  accent: '#F5B81A',
  'accent-soft': '#2E2308',
  'on-accent': '#151210',
  'accent-text': '#F8C947',
  success: '#27A262',
  'success-soft': '#0C2618',
  'success-text': '#58BD84',
  warning: '#F97F2A',
  'warning-soft': '#2B190B',
  'warning-text': '#FFA15C',
  danger: '#CC2E2E',
  'danger-hover': '#D63B3B',
  'danger-active': '#B02222',
  'danger-soft': '#2E1111',
  'danger-text': '#EC7777',
  info: '#2E92CC',
  'info-soft': '#0C2230',
  'info-text': '#5CAEDD',
  'disabled-bg': '#29241F',
  'disabled-text': '#665F56',
  focus: '#F8C947',
  'shadow-1': '0 1px 2px rgba(0,0,0,.4)',
  'shadow-2': '0 4px 12px rgba(0,0,0,.45)',
  'shadow-3': '0 16px 40px rgba(0,0,0,.6)',
  scrim: 'rgba(0,0,0,.62)',
  'wa-bubble': '#123A25',
  'note-bg': '#2E2308',
  inverse: '#F3F0EB',
  'on-inverse': '#24201C',
  shimmer: 'rgba(255,255,255,.07)',
  'chart-1': '#8B89E0',
  'chart-2': '#E69F00',
  'chart-3': '#56B4E9',
  'chart-4': '#19B388',
  'chart-5': '#E8732A',
  'chart-6': '#D98CB6',
  'chart-7': '#ABA398',
} as const;

export type SemanticToken = keyof typeof SEMANTIC_LIGHT;

export const SEMANTIC_TOKEN_NAMES = Object.keys(SEMANTIC_LIGHT) as SemanticToken[];
