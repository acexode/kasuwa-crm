import { describe, expect, it } from 'vitest';
import { enabledFeatureFlags } from './feature-flags';

describe('enabledFeatureFlags', () => {
  it('is empty when the variable is absent', () => {
    expect(enabledFeatureFlags({})).toEqual([]);
  });

  it('reads a comma-separated list, trimmed and de-duplicated', () => {
    expect(
      enabledFeatureFlags({ KASUWA_FEATURE_FLAGS_ON: ' self_serve_signup, ,self_serve_signup' }),
    ).toEqual(['self_serve_signup']);
  });

  it('refuses something that is not a flag name rather than ignoring it', () => {
    expect(() => enabledFeatureFlags({ KASUWA_FEATURE_FLAGS_ON: 'Self-Serve' })).toThrow(
      /KASUWA_FEATURE_FLAGS_ON/,
    );
  });
});
