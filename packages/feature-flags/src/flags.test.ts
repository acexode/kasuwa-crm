import { describe, expect, it } from 'vitest';
import { FLAGS, toEvaluationContext } from './index';

describe('feature flags', () => {
  /**
   * The scaffold's brief is explicit: feature-flag infrastructure must exist
   * but be unused. This test is what keeps "unused" true - the first flag added
   * without a task fails here and has to justify itself.
   */
  it('declares no flags yet', () => {
    expect(Object.keys(FLAGS)).toEqual([]);
  });

  it('always targets on tenant', () => {
    const context = toEvaluationContext({ tenantId: 't-1', programmeId: 'p-1' });
    expect(context.targetingKey).toBe('t-1');
    expect(context.tenantId).toBe('t-1');
    expect(context.programmeId).toBe('p-1');
  });

  it('omits absent attributes rather than sending undefined', () => {
    const context = toEvaluationContext({ tenantId: 't-1' });
    expect('programmeId' in context).toBe(false);
    expect('userId' in context).toBe(false);
  });
});
