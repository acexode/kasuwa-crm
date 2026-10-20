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
    expect(Object.keys(FLAGS)).toEqual([
      'self_serve_signup',
      'admin_live_api',
      'crm_records',
      'crm_accounts',
      'crm_record_view',
      'whatsapp_composer',
      'ai_summary',
      'ai_nba',
      'call_bar',
      'record_related',
      'identity_check',
      'record_addresses',
      'record_follow',
      'crm_leads',
      'crm_activities',
      'crm_scripts',
      'crm_pipeline',
      'crm_search',
      'crm_custom_fields',
      'crm_import',
      'crm_notifications',
      'crm_duplicates',
      'crm_inbox',
      'crm_tickets',
      'crm_calls',
      'crm_reports',
      'calendar_sync',
      'booking_pages',
      'field_checkin',
      'activity_priority',
      'activity_reminders',
      'fx_display',
      'pipeline_summary',
      'pipeline_templates',
      'whatsapp_recency',
      'deal_products',
      'deal_risk',
      'deal_relationships',
      'deal_quotes',
      'product_tour',
      'map_view',
      'bulk_actions',
      'saved_views',
      'last_activity',
      'quick_actions',
      'more_filters',
      'data_management',
      'data_migration',
      'data_export',
      'dsr',
      'merge_three_way',
      'admin_placeholders',
      'recent_searches',
      'programme_scope_search',
      'ai_assistant',
      'search_filters',
      'crm_home',
      'whatsapp_inbox',
      'quota',
      'approvals',
      'home_kpis',
      'notification_types',
      'notification_preferences',
      'crm_studio',
      'ai_script_hints',
      'script_programme_assignment',
      'script_preview',
      'script_version_changes',
    ]);
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

  it('ships crm_accounts OFF, separate from crm_records, and not production-ready (T-0057, D-L84)', () => {
    expect(FLAGS.crm_accounts.defaultValue).toBe(false);
    expect(FLAGS.crm_accounts.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_accounts.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_accounts']).crm_accounts.defaultVariant).toBe('on');
    // Its own switch: neither flag turns the other on.
    expect(flagConfiguration(['crm_accounts']).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records']).crm_accounts.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_accounts'] }),
    ).toThrow(/Refusing to start.*crm_accounts/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_accounts'] }),
    ).not.toThrow();
  });

  it('ships crm_record_view OFF and not production-ready, apart from crm_records (T-0062, D-L85)', () => {
    expect(FLAGS.crm_record_view.defaultValue).toBe(false);
    expect(FLAGS.crm_record_view.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_record_view.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records']).crm_record_view.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_record_view']).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records', 'crm_record_view']).crm_record_view.defaultVariant).toBe('on');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_record_view'] }),
    ).toThrow(/Refusing to start.*crm_record_view/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_record_view'] }),
    ).not.toThrow();
  });

  it('ships crm_leads OFF, separate from the other CRM flags, and not production-ready (T-0058, D-L86)', () => {
    expect(FLAGS.crm_leads.defaultValue).toBe(false);
    expect(FLAGS.crm_leads.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_leads.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_leads']).crm_leads.defaultVariant).toBe('on');
    // Its own switch: no CRM flag turns another on.
    expect(flagConfiguration(['crm_leads']).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_leads']).crm_accounts.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records', 'crm_accounts']).crm_leads.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_leads'] }),
    ).toThrow(/Refusing to start.*crm_leads/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_accounts', 'crm_leads'] }),
    ).not.toThrow();
  });

  it('ships crm_activities OFF, separate from the other CRM flags, and not production-ready (T-0083)', () => {
    expect(FLAGS.crm_activities.defaultValue).toBe(false);
    expect(FLAGS.crm_activities.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_activities.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_activities']).crm_activities.defaultVariant).toBe('on');
    // Its own switch: it rides on the records process but turns no other flag on.
    expect(flagConfiguration(['crm_activities']).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads']).crm_activities.defaultVariant).toBe(
      'off',
    );
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_activities'] }),
    ).toThrow(/Refusing to start.*crm_activities/);
    expect(() =>
      assertFlagsAreProductionSafe({
        nodeEnv: 'test',
        enabled: ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities'],
      }),
    ).not.toThrow();
  });

  it('ships crm_scripts OFF, separate from the other CRM flags, and not production-ready (T-0115, T-0116, D-L114)', () => {
    expect(FLAGS.crm_scripts.defaultValue).toBe(false);
    expect(FLAGS.crm_scripts.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_scripts.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_scripts']).crm_scripts.defaultVariant).toBe('on');
    // Its own switch: it turns no record flag on, and no record flag turns it on.
    expect(flagConfiguration(['crm_scripts']).crm_records.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_scripts']).crm_record_view.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_records', 'crm_record_view', 'crm_leads']).crm_scripts.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_scripts'] }),
    ).toThrow(/Refusing to start.*crm_scripts/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_record_view', 'crm_scripts'] }),
    ).not.toThrow();
  });

  it('ships crm_pipeline OFF, separate from the other CRM flags, and not production-ready (T-0109)', () => {
    expect(FLAGS.crm_pipeline.defaultValue).toBe(false);
    expect(FLAGS.crm_pipeline.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_pipeline.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_pipeline']).crm_pipeline.defaultVariant).toBe('on');
    // Its own switch: it rides on the records process but turns no other flag on.
    expect(flagConfiguration(['crm_pipeline']).crm_records.defaultVariant).toBe('off');
    expect(
      flagConfiguration(['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities', 'crm_scripts']).crm_pipeline
        .defaultVariant,
    ).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_pipeline'] }),
    ).toThrow(/Refusing to start.*crm_pipeline/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_pipeline'] }),
    ).not.toThrow();
  });

  it('ships crm_search OFF, separate from the other CRM flags, and not production-ready (T-0087)', () => {
    expect(FLAGS.crm_search.defaultValue).toBe(false);
    expect(FLAGS.crm_search.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_search.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_search']).crm_search.defaultVariant).toBe('on');
    // Its own switch: it rides on the records process but turns no other flag on, and none turns it on.
    expect(flagConfiguration(['crm_search']).crm_records.defaultVariant).toBe('off');
    expect(
      flagConfiguration(['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities', 'crm_scripts', 'crm_pipeline'])
        .crm_search.defaultVariant,
    ).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_search'] }),
    ).toThrow(/Refusing to start.*crm_search/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_search'] }),
    ).not.toThrow();
  });

  it('ships crm_import OFF, its own switch, and not production-ready (T-0094)', () => {
    expect(FLAGS.crm_import.defaultValue).toBe(false);
    expect(FLAGS.crm_import.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_import.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_import']).crm_import.defaultVariant).toBe('on');
    expect(flagConfiguration(['crm_records']).crm_import.defaultVariant).toBe('off');
    expect(() => assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_import'] })).toThrow();
  });

  it('ships crm_notifications OFF, its own switch, and not production-ready (T-0100)', () => {
    expect(FLAGS.crm_notifications.defaultValue).toBe(false);
    expect(FLAGS.crm_notifications.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_notifications.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_notifications']).crm_notifications.defaultVariant).toBe('on');
    expect(flagConfiguration(['crm_import']).crm_notifications.defaultVariant).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_notifications'] }),
    ).toThrow();
  });

  it('ships crm_duplicates OFF, its own switch, and not production-ready (T-0097)', () => {
    expect(FLAGS.crm_duplicates.defaultValue).toBe(false);
    expect(FLAGS.crm_duplicates.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_duplicates.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_duplicates']).crm_duplicates.defaultVariant).toBe('on');
    expect(flagConfiguration(['crm_records', 'crm_import']).crm_duplicates.defaultVariant).toBe('off');
    expect(() => assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_duplicates'] })).toThrow();
  });

  it('ships crm_custom_fields OFF, its own switch, and not production-ready (T-0090)', () => {
    expect(FLAGS.crm_custom_fields.defaultValue).toBe(false);
    expect(FLAGS.crm_custom_fields.productionReady).toBe(false);
    expect(flagConfiguration([]).crm_custom_fields.defaultVariant).toBe('off');
    expect(flagConfiguration(['crm_custom_fields']).crm_custom_fields.defaultVariant).toBe('on');
    // It rides on the records process but turns no other flag on, and none turns it on.
    expect(flagConfiguration(['crm_custom_fields']).crm_records.defaultVariant).toBe('off');
    expect(
      flagConfiguration(['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_search']).crm_custom_fields.defaultVariant,
    ).toBe('off');
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: ['crm_custom_fields'] }),
    ).toThrow(/Refusing to start.*crm_custom_fields/);
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: ['crm_records', 'crm_custom_fields'] }),
    ).not.toThrow();
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
