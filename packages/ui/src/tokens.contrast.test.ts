import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { SEMANTIC_CONTRAST_PAIRS, SEMANTIC_DARK, SEMANTIC_LIGHT } from './tokens';

/**
 * WCAG 2.2 AA is a committed non-functional requirement (PRD 2.13), and tokens
 * are the one place a contrast failure affects every screen at once. Asserting
 * it here means a token change that breaks accessibility fails in seconds
 * rather than in a manual audit months later.
 */
describe('semantic token contrast', () => {
  for (const [themeName, theme] of [
    ['light', SEMANTIC_LIGHT],
    ['dark', SEMANTIC_DARK],
  ] as const) {
    describe(themeName, () => {
      for (const pair of SEMANTIC_CONTRAST_PAIRS) {
        it(`${pair.foreground} on ${pair.background} meets ${pair.minimumRatio}:1`, () => {
          const ratio = contrastRatio(theme[pair.foreground], theme[pair.background]);
          expect(ratio).toBeGreaterThanOrEqual(pair.minimumRatio);
        });
      }
    });
  }
});

describe('contrast maths', () => {
  it('computes the known extremes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2b2a8c', '#faf9f7')).toBeCloseTo(
      contrastRatio('#faf9f7', '#2b2a8c'),
      10,
    );
  });

  it('rejects values that are not colours', () => {
    expect(() => contrastRatio('rebeccapurple', '#ffffff')).toThrow();
  });
});
