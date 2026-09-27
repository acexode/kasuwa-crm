import { describe, it } from 'vitest';

/**
 * ACCEPTANCE STUB — T-0003, the real design system (Agent 11, M19 + all UIs).
 *
 * `todo` rather than failing, for the reason explained in
 * `tests/acceptance/auth/authentication.acceptance.test.ts`.
 *
 * Note that two of these are already enforced elsewhere and will simply have to
 * keep passing: contrast is asserted by `packages/ui/src/tokens.contrast.test.ts`
 * and generated-CSS drift by the `lint` job in CI. They are restated here
 * because after T-0003 they become acceptance criteria for a deliverable rather
 * than internal invariants of a placeholder.
 */
describe('acceptance (stub): design tokens', () => {
  it.todo('every semantic token resolves to a colour in both light and dark themes');

  it.todo('every SEMANTIC_CONTRAST_PAIRS entry meets its minimum ratio in both themes');

  it.todo('no minimumRatio in SEMANTIC_CONTRAST_PAIRS has been lowered below WCAG 2.2 AA');

  it.todo('pnpm ui:tokens is idempotent — generated CSS matches the committed tokens.css');

  it.todo('no hex colour literal exists anywhere outside packages/ui');

  it.todo('the type scale renders Yoruba, Igbo and Hausa diacritics without fallback');

  it.todo('the token source file no longer declares itself PROVISIONAL');
});
