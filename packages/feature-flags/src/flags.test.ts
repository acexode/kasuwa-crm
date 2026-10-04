import { InMemoryProvider, OpenFeature } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  assertFlagsAreProductionSafe,
  flagConfiguration,
  toEvaluationContext,
} from './index';

describe('feature flags', () => {
  /**
   * Every flag is here because a task asked for it. This list changing is a
   * review question — which task, and who turns it on — not a refactor.
   */
  it('declares exactly the flags a task has asked for', () => {
    expect(Object.keys(FLAGS)).toEqual(['self_serve_signup', 'admin_live_api', 'crm_records']);
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

  it('marks self_serve_signup not production-ready until T-0016 ships its endpoints', () => {
    expect(FLAGS.self_serve_signup.productionReady).toBe(false);
  });

  it('ships admin_live_api OFF and not production-ready until T-0032 adds the 403s (T-0035)', () => {
    expect(FLAGS.admin_live_api.defaultValue).toBe(false);
    expect(FLAGS.admin_live_api.productionReady).toBe(false);
    expect(flagConfiguration([]).admin_live_api.defaultVariant).toBe('off');
    expect(flagConfiguration(['admin_live_api']).admin_live_api.defaultVariant).toBe('on');
    // Switching one flag on leaves the other at its default.
    expect(flagConfiguration(['admin_live_api']).self_serve_signup.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['admin_live_api'] }),
    ).toThrow(/Refusing to start.*admin_live_api/);
  });

  it('ships crm_records OFF and not production-ready until T-0041 is live (T-0042, D-L64)', () => {
    expect(FLAGS.crm_records.defaultValue).toBe(false);
    expect(FLAGS.crm_records.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records']).crm_records.defaultVariant).toBe('on');
    expect(flagConfiguration(['crm_records']).admin_live_api.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_records'] }),
    ).toThrow(/Refusing to start.*crm_records/);
    expect(() => assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records'] })).not.toThrow();
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

describe('production flag guard', () => {
  /**
   * Fail closed, like stub auth. `KASUWA_FEATURE_FLAGS_ON` is a deployment
   * variable; without this guard one line in a production environment would
   * put self-serve sign-up in front of the public before T-0016's endpoints
   * exist, and every submission would answer 501.
   */
  it('refuses a not-production-ready flag in production', () => {
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['self_serve_signup'] }),
    ).toThrow(/Refusing to start.*self_serve_signup/);
  });

  it('allows it outside production, which is where the e2e flag-on server runs', () => {
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'development', enabled: ['self_serve_signup'] }),
    ).not.toThrow();
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['self_serve_signup'] }),
    ).not.toThrow();
  });

  it('allows production when nothing is switched on', () => {
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: [] }),
    ).not.toThrow();
  });
});
