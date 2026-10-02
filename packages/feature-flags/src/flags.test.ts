import { InMemoryProvider, OpenFeature } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';
import { FLAGS, flagConfiguration, toEvaluationContext } from './index';

describe('feature flags', () => {
  /**
   * Every flag is here because a task asked for it. This list changing is a
   * review question — which task, and who turns it on — not a refactor.
   */
  it('declares exactly the flags a task has asked for', () => {
    expect(Object.keys(FLAGS)).toEqual(['self_serve_signup']);
  });

  it('ships self_serve_signup OFF (D-P2)', () => {
    expect(FLAGS.self_serve_signup.defaultValue).toBe(false);
    expect(flagConfiguration([]).self_serve_signup.defaultVariant).toBe('off');
  });

  it('turns a flag on only when the process names it', async () => {
    expect(flagConfiguration(['self_serve_signup']).self_serve_signup.defaultVariant).toBe('on');

    // Through a real provider, so the shape is the one OpenFeature evaluates.
    await OpenFeature.setProviderAndWait(
      'flags-test',
      new InMemoryProvider(flagConfiguration(['self_serve_signup'])),
    );
    const client = OpenFeature.getClient('flags-test');
    await expect(
      client.getBooleanValue('self_serve_signup', false, toEvaluationContext({ tenantId: 't-1' })),
    ).resolves.toBe(true);
  });

  it('refuses an unknown flag name instead of ignoring it', () => {
    expect(() => flagConfiguration(['self_serve_sigup'])).toThrow(/self_serve_sigup/);
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
