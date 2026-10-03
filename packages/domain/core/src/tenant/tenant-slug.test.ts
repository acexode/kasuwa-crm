import { describe, expect, it } from 'vitest';
import { slugSkeleton, tenantSlugProblem } from './tenant-slug';

describe('tenantSlugProblem', () => {
  it('accepts ordinary slugs at both length limits', () => {
    for (const slug of ['sahel-bpo', 'ab', 'a1', 'a'.repeat(63), 'rift-valley-contact', '9ja']) {
      expect(tenantSlugProblem(slug), slug).toBeNull();
    }
  });

  it('refuses the D-L54 reserved words', () => {
    for (const slug of ['admin', 'api', 'www']) {
      expect(tenantSlugProblem(slug)).toBe('reserved');
    }
  });

  it('refuses lengths outside 2..63', () => {
    expect(tenantSlugProblem('')).toBe('length');
    expect(tenantSlugProblem('a')).toBe('length');
    expect(tenantSlugProblem('a'.repeat(64))).toBe('length');
  });

  it('refuses upper case, spaces, underscores, edge hyphens and non-ASCII', () => {
    for (const slug of [
      'Sahel-BPO',
      'has space',
      'under_score',
      '-leading',
      'trailing-',
      'ѕahel-bpo', // Cyrillic U+0455
      'café',
      'dot.ted',
    ]) {
      expect(tenantSlugProblem(slug), slug).toBe('characters');
    }
  });

  it('refuses punycode and every other double-hyphen label', () => {
    expect(tenantSlugProblem('xn--sahel-bpo-9xc')).toBe('double-hyphen');
    expect(tenantSlugProblem('sahel--bpo')).toBe('double-hyphen');
  });
});

describe('slugSkeleton', () => {
  it('folds ASCII look-alikes and hyphens to one skeleton', () => {
    const base = slugSkeleton('sahel-bpo');
    for (const lookalike of ['sahelbpo', 'saheI-bpo', 'sahe1-bpo', 'sahel-bp0', 'sa-hel-bpo']) {
      expect(slugSkeleton(lookalike), lookalike).toBe(base);
    }
    expect(slugSkeleton('modem')).toBe(slugSkeleton('rnodem'));
    expect(slugSkeleton('wave')).toBe(slugSkeleton('vvave'));
  });

  it('keeps genuinely different slugs apart', () => {
    expect(slugSkeleton('sahel-bpo')).not.toBe(slugSkeleton('rift-valley-contact'));
    expect(slugSkeleton('harmattan')).not.toBe(slugSkeleton('sirocco'));
  });
});
