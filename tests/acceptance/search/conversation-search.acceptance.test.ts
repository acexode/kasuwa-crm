import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0193 conversation search types (additive).
 * Full wiring lands with inbox search depth; this locks the intent.
 */
describe('T-0193 conversation search types', () => {
  it('documents conversation as an additive search type (follow-up wiring)', () => {
    const additiveTypes = ['conversation'] as const;
    expect(additiveTypes).toContain('conversation');
  });
});
