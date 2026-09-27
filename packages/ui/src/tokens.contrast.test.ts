import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import {
  assertContrastPairsAreValid,
  CHART_TOKENS,
  CONTRAST_PAIRS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SEMANTIC_TOKEN_NAMES,
  TYPE_SCALE,
} from './tokens';

/**
 * The contrast contract for Design v1.1.
 *
 * WCAG 2.2 AA is a committed non-functional requirement (PRD 2.13), and tokens
 * are the one place a contrast failure reaches every screen at once. This runs
 * in CI, so a token change that breaks accessibility fails in seconds rather
 * than in an audit months later.
 *
 * If one of these fails, the fix is the token or the role it is used for.
 * Lowering a `minimumRatio` is not a fix; it is deleting the requirement.
 */

const THEMES = [
  ['light', SEMANTIC_LIGHT],
  ['dark', SEMANTIC_DARK],
] as const;

describe('contrast contract', () => {
  it('only names tokens that exist', () => {
    expect(() => assertContrastPairsAreValid()).not.toThrow();
  });

  it('never lowers a threshold below WCAG 2.2 AA', () => {
    // 4.5 for text, 3 for non-text UI boundaries. Anything below either floor
    // means someone relaxed the contract rather than fixing a colour.
    for (const pair of CONTRAST_PAIRS) {
      expect(
        [3, 4.5],
        `${pair.foreground} on ${pair.background} uses a non-AA threshold`,
      ).toContain(pair.minimumRatio);
    }
  });

  for (const [themeName, theme] of THEMES) {
    describe(themeName, () => {
      for (const pair of CONTRAST_PAIRS) {
        it(`${pair.foreground} on ${pair.background} meets ${pair.minimumRatio}:1`, () => {
          const ratio = contrastRatio(theme[pair.foreground], theme[pair.background]);
          expect(
            ratio,
            `${pair.foreground} on ${pair.background} (${pair.note})`,
          ).toBeGreaterThanOrEqual(pair.minimumRatio);
        });
      }
    });
  }

  /**
   * The T-0003 hand-off quoted an independently computed range of 5.5–11.6 for
   * the text pairs. Pinning it here means a token edit that silently moves the
   * whole system — rather than breaking one pair — still gets caught.
   */
  it('keeps every text pair inside the range the hand-off verified (5.5–11.6)', () => {
    const textRatios = CONTRAST_PAIRS.filter((pair) => pair.minimumRatio === 4.5).flatMap((pair) =>
      THEMES.map(([, theme]) => contrastRatio(theme[pair.foreground], theme[pair.background])),
    );

    expect(Math.min(...textRatios)).toBeGreaterThanOrEqual(5.5);
    expect(Math.max(...textRatios)).toBeLessThanOrEqual(11.6);
  });
});

describe('theme completeness', () => {
  it('defines identical token names in both themes', () => {
    // A token present in one theme only renders as `unset` — invisible text or
    // an invisible border, in the theme nobody tested.
    expect(Object.keys(SEMANTIC_DARK).sort()).toEqual(Object.keys(SEMANTIC_LIGHT).sort());
  });

  it('gives every semantic token a non-empty value in both themes', () => {
    for (const token of SEMANTIC_TOKEN_NAMES) {
      expect(SEMANTIC_LIGHT[token], `light: ${token}`).toBeTruthy();
      expect(SEMANTIC_DARK[token], `dark: ${token}`).toBeTruthy();
    }
  });

  it('carries a full seven-colour chart palette in both themes', () => {
    expect(CHART_TOKENS).toHaveLength(7);
    const light = CHART_TOKENS.map((token) => SEMANTIC_LIGHT[token]);
    const dark = CHART_TOKENS.map((token) => SEMANTIC_DARK[token]);
    // Adjacent series that share a colour are unreadable; duplicates would mean
    // a transcription slip in the import.
    expect(new Set(light).size).toBe(7);
    expect(new Set(dark).size).toBe(7);
  });
});

describe('type scale', () => {
  it('never drops body line-height below 1.4', () => {
    // Stacked Yoruba and Igbo tone marks (ọ̀, ẹ́) collide with the line above
    // below this. It is a legibility requirement in three of our languages,
    // not a typographic preference.
    for (const step of ['body-lg', 'body-md', 'body-sm'] as const) {
      const { size, lineHeight } = TYPE_SCALE[step];
      const ratio = Number.parseFloat(lineHeight) / Number.parseFloat(size);
      expect(ratio, `${step} line-height ratio`).toBeGreaterThanOrEqual(1.4);
    }
  });
});

describe('contrast maths', () => {
  it('computes the known extremes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2b2a8c', '#faf8f5')).toBeCloseTo(
      contrastRatio('#faf8f5', '#2b2a8c'),
      10,
    );
  });

  it('rejects values that are not colours', () => {
    expect(() => contrastRatio('rebeccapurple', '#ffffff')).toThrow();
  });
});
