import {
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';

/**
 * Server-side flag reads for `apps/web`. Import this from SERVER components
 * only: the answer is decided by the process, never by anything the browser
 * sends.
 *
 * `self_serve_signup` (D-P2) gates the ROUTES of `P01/3`, `P01/4` and
 * `P01/5.1`. Each of those pages calls `notFound()` when it is off, so typing
 * the path gets a real HTTP 404 — "not found", never "forbidden" (CLAUDE.md
 * 6.4) — and nothing of the screen is shipped. It is deliberately NOT checked
 * by `/onboarding`: the first-admin steps are for every tenant (T-0018).
 */

/**
 * Sign-up happens before there is a tenant, so the evaluation cannot carry a
 * real `tenantId`. A fixed sentinel keeps the context well-formed and makes it
 * explicit that no per-tenant rule can apply here: the switch is global.
 */
const PRE_TENANT = 'pre-tenant:self-serve-sign-up';

export async function selfServeSignupEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'self_serve_signup',
    false,
    toEvaluationContext({ tenantId: PRE_TENANT }),
  );
}

/**
 * `admin_live_api` (T-0035) is per PROCESS too. The admin console has no tenant
 * on the server side — the browser's session decides that, at the API — so the
 * evaluation carries a sentinel that no per-tenant rule can match, exactly
 * like sign-up above. Read by the P02 server pages and passed to the client
 * screens as a boolean; a `'use client'` module never evaluates a flag.
 *
 * It switches presentation only — KPIs and skill cover to labelled sample
 * data. It grants and withholds nothing: the admin API is called the same way
 * either way, and access is the API's permissions engine (T-0032).
 */
const ADMIN_CONSOLE = 'process:admin-console';

export async function adminLiveApiEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'admin_live_api',
    false,
    toEvaluationContext({ tenantId: ADMIN_CONSOLE }),
  );
}

/**
 * `crm_records` (T-0042, D-L64) gates the ROUTES of the CRM shell: `/contacts`
 * and the `/contacts/[id]` scaffolding call `notFound()` while it is off, so
 * typing the path gets a real 404 and nothing of the screen is shipped.
 *
 * Per process, like the two above: the browser's session decides the tenant at
 * the API, so the evaluation carries a sentinel no per-tenant rule can match.
 * It decides nothing about access — the contacts API scopes every row from the
 * session and `user_programme` whether this is on or off.
 */
const CRM_SHELL = 'process:crm-shell';

export async function crmRecordsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_records',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_accounts` (T-0057, D-L84) gates the ROUTE of the P04 Accounts list:
 * `/accounts` calls `notFound()` while it is off, so typing the path gets a
 * real 404 and nothing of the screen ships. Its own flag, not `crm_records`:
 * the two screens are switched on separately.
 *
 * A presentation switch, like the others: the accounts API scopes every row
 * from the session and refuses a write without `account.write` whether this
 * is on or off.
 */
export async function crmAccountsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_accounts',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_record_view` (T-0062, D-L85) gates the ROUTE of the P05 contact record,
 * `/contacts/[id]`: with it off the page calls `notFound()` before any id is
 * read, so typing the path gets a real 404 and nothing of the screen ships.
 * The page also needs `crm_records`, because the record sits in the CRM shell
 * and the shell's Contacts link must resolve wherever the record is served.
 *
 * Per process and decided by nothing the browser sends, like the ones above.
 * It grants nothing: the record's reads and writes are scoped by the session,
 * `user_programme` and the permissions engine at the API, on or off.
 */
export async function crmRecordViewEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_record_view',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_leads` (T-0058, D-L86) gates the ROUTE of the P04 Leads list and its
 * Kanban: `/leads` calls `notFound()` while it is off, so typing the path gets
 * a real 404 and nothing of the screen ships. Its own flag, separate from
 * `crm_records` and `crm_accounts`.
 *
 * A presentation switch, like the others: listLeads scopes every row from the
 * session, and updateContact and convertContact refuse what the caller's
 * rights and field security do not allow, whether this is on or off.
 */
export async function crmLeadsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_leads',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_activities` (T-0083) gates the ROUTE of the P07 activities screen:
 * `/activities` calls `notFound()` while it is off, so typing the path gets a
 * real 404 and nothing of the screen ships. Its own flag, separate from the
 * record screens', though the e2e harness serves it on their process so the
 * screen's contact and account links resolve.
 *
 * A presentation switch, like the others: listMyActivities and listCalendar
 * list the session user's own activities, and updateActivity and
 * createActivity refuse what the caller's rights and field security do not
 * allow, whether this is on or off.
 */
export async function crmActivitiesEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_activities',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * The CRM nav entries for modules that are not built (T-0130, D-L194), each
 * behind its module's own flag. On, the shell draws the entry in its disabled
 * state, as the design draws it; off, the entry is not drawn. `crmLiveNav()`
 * reports each as `placeholder:<id>`. Presentation only: grants nothing.
 */
const UNBUILT_NAV = ['inbox', 'tickets', 'calls', 'reports'] as const;

const PLACEHOLDER_FLAG = {
  inbox: 'crm_inbox',
  tickets: 'crm_tickets',
  calls: 'crm_calls',
  reports: 'crm_reports',
} as const satisfies Record<(typeof UNBUILT_NAV)[number], string>;

async function crmPlaceholderEnabled(id: (typeof UNBUILT_NAV)[number]): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    PLACEHOLDER_FLAG[id],
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * The CRM shell's nav entries whose ROUTE is on in this process, by nav id.
 * An entry links only to a screen that answers; one whose flag is off is drawn
 * as "not available yet", exactly like an unbuilt one (`components/crm/crm-nav.ts`).
 */
export async function crmLiveNav(): Promise<string[]> {
  const [home, contacts, accounts, leads, activities, pipeline, search, csvImport, duplicates, recordView, notifications, notificationExtras, ...placeholders] = await Promise.all([
    crmHomeEnabled(),
    crmRecordsEnabled(),
    crmAccountsEnabled(),
    crmLeadsEnabled(),
    crmActivitiesEnabled(),
    crmPipelineEnabled(),
    crmSearchEnabled(),
    crmImportEnabled(),
    crmDuplicatesEnabled(),
    crmRecordViewEnabled(),
    crmNotificationsEnabled(),
    notificationPlaceholders(),
    ...UNBUILT_NAV.map((id) => crmPlaceholderEnabled(id)),
  ]);
  const listPlaceholders = await listPlaceholderFlags();
  return [
    // The rail's entries for unbuilt modules (T-0130, D-L194): drawn, disabled, only where their flag is on.
    ...UNBUILT_NAV.filter((_, index) => placeholders[index] === true).map((id) => `placeholder:${id}`),
    // P03 Home (T-0132, D-L196): the rail's first entry, and so the landing.
    ...(home ? ['home'] : []),
    ...(leads ? ['leads'] : []),
    ...(contacts ? ['contacts'] : []),
    ...(accounts ? ['accounts'] : []),
    ...(activities ? ['activities'] : []),
    ...(pipeline ? ['deals'] : []),
    // Not a nav item: the shell's header entry and the Ctrl/Cmd+K palette (T-0087).
    ...(search ? ['search'] : []),
    // Not a nav item either: the Contacts list's import action links `/contacts/import` only where this is on (T-0096, I1).
    // The import screen's own links need the Contacts list it lands back on (D-L179 N9): both flags.
    ...(csvImport && contacts ? ['import'] : []),
    // Not a nav item either: the Contacts list links `/contacts/duplicates` only where this is on (T-0097, I1).
    ...(duplicates ? ['duplicates'] : []),
    // Not a nav item either: the shell's bell (T-0101), and the object types a notification may link,
    // because a link is made only to a route that answers (a contact record needs two flags).
    ...(notifications
      ? [
          'notifications',
          ...(contacts && recordView ? ['notifications:contact'] : []),
          ...(accounts && recordView ? ['notifications:account'] : []),
          ...(pipeline ? ['notifications:deal'] : []),
          ...(activities ? ['notifications:activity'] : []),
          ...(csvImport && contacts ? ['notifications:import'] : []),
          // P26's placeholders (T-0137, D-L194): drawn only where their own flag is on too.
          ...notificationExtras,
        ]
      : []),
    // Not nav items: the P04 lists' placeholders (T-0133, D-L194), by flag name.
    ...listPlaceholders,
  ];
}

/** The P04 list placeholder flags (T-0133, D-L194) that are on in this process. */
const LIST_PLACEHOLDER_FLAGS = ['map_view', 'bulk_actions', 'saved_views', 'last_activity', 'quick_actions', 'more_filters'] as const;

/**
 * `map_view`, `bulk_actions`, `saved_views`, `last_activity`,
 * `quick_actions` and `more_filters` (T-0133, D-L194): designed P04 elements with no backend yet,
 * drawn in the design's own empty or disabled state. Presentation only: none
 * of them reaches an endpoint, and each grants nothing.
 */
async function listPlaceholderFlags(): Promise<string[]> {
  await initialiseFeatureFlags();
  const client = featureFlagClient();
  const on = await Promise.all(
    LIST_PLACEHOLDER_FLAGS.map((flag) => client.getBooleanValue(flag, false, toEvaluationContext({ tenantId: CRM_SHELL }))),
  );
  return LIST_PLACEHOLDER_FLAGS.filter((_, index) => on[index] === true);
}

/**
 * `crm_pipeline` (T-0109) gates the P06 ROUTES — `/pipelines` and
 * `/pipelines/[pipelineId]` call `notFound()` while it is off, so typing the
 * path gets a real 404 and nothing of the screen ships — and the CRM nav's
 * Deals entry, which links `/pipelines` only where this is on (`crmLiveNav()`).
 * No client module names it.
 *
 * Per process, like the others. It grants nothing: the pipelines and deals
 * API scopes every read from the session and `user_programme`, and refuses a
 * move or a create the caller's rights and field security do not allow,
 * whether this is on or off.
 */
export async function crmPipelineEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_pipeline',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_scripts` (T-0115, T-0116, D-L114) gates the P10 ROUTES — `/scripts`,
 * `/scripts/[scriptId]` and `/script-runs/[runId]` call `notFound()` while it
 * is off — and the contact record's "Start script" control, which the
 * record's server page reads here and passes down as a boolean. No client
 * module names it.
 *
 * Per process, like the others. It grants nothing: authoring needs
 * `script.write` and a run needs `script.run`, decided by the scripting API
 * from the session and `user_programme` whether this is on or off. It is
 * deliberately NOT in `crmLiveNav()`: the builder has no nav entry for anyone
 * until a capability read exists (R3, T-0079).
 */
export async function crmScriptsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_scripts',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_search` (T-0087, D-L133, D-L135) gates the P27 ROUTE — `/search` calls
 * `notFound()` while it is off, so typing the path gets a real 404 and nothing
 * of the screen ships — and, through `crmLiveNav()`, the CRM shell's header
 * entry and its Ctrl/Cmd+K command palette. No client module names it.
 *
 * Per process, like the others. It grants nothing: searchRecords and
 * lookupRecords scope every hit from the session and `user_programme` and
 * apply field security, whether this is on or off.
 */
export async function crmSearchEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_search',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_custom_fields` (T-0090, D-L128) gates the P18 customisation studio —
 * `/admin/custom-fields` calls `notFound()` while it is off, so typing the path
 * gets a real 404 and nothing of the screen ships — and the settings menu's
 * "Fields" entry, which links the studio only where this is on
 * (`adminLiveNav()`, read by each admin page). No client module names it.
 *
 * It is read by the eight record routes too (T-0091: the contact, lead, account
 * and deal records, their activity forms and the four list filters): with it off
 * those screens are unchanged and ship none of the custom-field code paths' strings.
 *
 * Per process, like the others. It grants nothing: the four custom-field
 * operations are decided by the API from the session, and every write needs
 * `custom_field.write` (the tenant-admin flag), whether this is on or off.
 */
export async function crmCustomFieldsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_custom_fields',
    false,
    toEvaluationContext({ tenantId: ADMIN_CONSOLE }),
  );
}

/**
 * `crm_import` (T-0096, D-L146, D-L168) gates the P28 ROUTE — `/contacts/import`
 * calls `notFound()` while it is off, so typing the path gets a real 404 and
 * nothing of the screen ships — and, through `crmLiveNav()` as `import`, the
 * Contacts list's import action, which links the screen only where this is on,
 * and its `importId` filter. No client module names it.
 *
 * Per process, like the others. It grants nothing: the import operations are
 * decided by the API from the session and `contact.import` in the programme,
 * and the same flag switches the API itself on (T-0094), whether or not this
 * process serves the screen.
 */
export async function crmImportEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_import',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * `crm_notifications` (T-0101, D-L177) gates the P26 ROUTE — `/notifications`
 * calls `notFound()` while it is off, so typing the path gets a real 404 and
 * nothing of the screen ships — and, through `crmLiveNav()` as `notifications`
 * and `adminBellLive()`, the bell in the CRM shell and the admin console. No
 * client module names it.
 *
 * A presentation switch, like `crm_search`: the notifications API and its
 * consumer run whether or not it is on, and serve only the caller's own rows.
 */
export async function crmNotificationsEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_notifications',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * The P26 placeholders (T-0137, D-L194), as `live` entries for the bell and
 * the centre: `notification-types` (the types no module produces yet, drawn
 * disabled), `notification-preferences` (the Preferences button, the bell's
 * gear and `/settings/notifications`). Read only where `crm_notifications`
 * is on; each is presentation only.
 */
export const NOTIFICATION_PLACEHOLDERS = {
  'notification-types': 'notification_types',
  'notification-preferences': 'notification_preferences',
} as const;

export async function notificationPlaceholders(): Promise<string[]> {
  await initialiseFeatureFlags();
  const entries = Object.entries(NOTIFICATION_PLACEHOLDERS);
  const on = await Promise.all(
    entries.map(([, flag]) => featureFlagClient().getBooleanValue(flag, false, toEvaluationContext({ tenantId: CRM_SHELL }))),
  );
  return entries.filter((_, index) => on[index] === true).map(([id]) => id);
}

/** `/settings/notifications` answers only where both the bell and its preferences placeholder are on. */
export async function notificationPreferencesEnabled(): Promise<boolean> {
  if (!(await crmNotificationsEnabled())) return false;
  return (await notificationPlaceholders()).includes('notification-preferences');
}

/**
 * `crm_duplicates` (T-0097, D-L146, D-L175) gates the P28 ROUTE —
 * `/contacts/duplicates` calls `notFound()` while it is off, so typing the path
 * gets a real 404 and nothing of the screen ships — and, through
 * `crmLiveNav()` as `duplicates`, the Contacts list's link to it. No client
 * module names it.
 *
 * Per process, like the others, and presentation only: the five duplicates and
 * merge operations are served by the API whatever this says, and who may merge
 * is `contact.write` in the programme, decided there.
 */
export async function crmDuplicatesEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_duplicates',
    false,
    toEvaluationContext({ tenantId: CRM_SHELL }),
  );
}

/**
 * P07's flagged placeholders (T-0136, D-L194): elements the design draws whose
 * module does not exist yet, each shown in the design's own empty or disabled
 * state while its flag is on, and not drawn at all while it is off. Read on
 * the server and handed to the client screen as booleans. Presentation only:
 * nothing here reads, connects, books or sends anything.
 */
export interface ActivitiesPlaceholders {
  /** The not-connected calendar banner, the source chip and the empty attendee panel (D-P22). */
  readonly calendarSync: boolean;
  /** The Booking pages view, its editor empty and disabled (D-P22). */
  readonly bookingPages: boolean;
  /** The phone Check-in view and the composer's Visit type, disabled. */
  readonly fieldCheckin: boolean;
  /** The priority pill placeholder and the disabled priority and deal filter chips (D-L105). */
  readonly priority: boolean;
  /** The composer's customer-reminder channels, disabled (D-P29). */
  readonly reminders: boolean;
}

const ACTIVITIES_PLACEHOLDER_FLAGS = {
  calendarSync: 'calendar_sync',
  bookingPages: 'booking_pages',
  fieldCheckin: 'field_checkin',
  priority: 'activity_priority',
  reminders: 'activity_reminders',
} as const satisfies Record<keyof ActivitiesPlaceholders, string>;

export async function activitiesPlaceholders(): Promise<ActivitiesPlaceholders> {
  await initialiseFeatureFlags();
  const client = featureFlagClient();
  const context = toEvaluationContext({ tenantId: CRM_SHELL });
  const entries = await Promise.all(
    (Object.entries(ACTIVITIES_PLACEHOLDER_FLAGS) as [keyof ActivitiesPlaceholders, string][]).map(
      async ([key, flag]) => [key, await client.getBooleanValue(flag, false, context)] as const,
    ),
  );
  return Object.fromEntries(entries) as unknown as ActivitiesPlaceholders;
}

/**
 * The P06 modules drawn as D-L194 placeholders (T-0135): each a design element
 * with no backend yet, in the design's own empty or disabled state. Read on
 * the server and passed down as booleans, like every flag here; no client
 * module names a flag.
 */
export interface DealModules {
  /** The disabled "Show US$" switch. */
  readonly fxDisplay: boolean;
  /** The board summary line, from the served totals and counts. */
  readonly summary: boolean;
  /** The first-pipeline template picker. */
  readonly templates: boolean;
  /** The last WhatsApp contact, an empty dash. */
  readonly whatsapp: boolean;
  readonly products: boolean;
  readonly risk: boolean;
  readonly relationships: boolean;
  readonly quotes: boolean;
}

export async function dealModules(): Promise<DealModules> {
  await initialiseFeatureFlags();
  const client = featureFlagClient();
  const context = toEvaluationContext({ tenantId: CRM_SHELL });
  const [fxDisplay, summary, templates, whatsapp, products, risk, relationships, quotes] = await Promise.all([
    client.getBooleanValue('fx_display', false, context),
    client.getBooleanValue('pipeline_summary', false, context),
    client.getBooleanValue('pipeline_templates', false, context),
    client.getBooleanValue('whatsapp_recency', false, context),
    client.getBooleanValue('deal_products', false, context),
    client.getBooleanValue('deal_risk', false, context),
    client.getBooleanValue('deal_relationships', false, context),
    client.getBooleanValue('deal_quotes', false, context),
  ]);
  return { fxDisplay, summary, templates, whatsapp, products, risk, relationships, quotes };
}

/**
 * `product_tour` (D-L194, T-0131): whether P01/6 draws the tour button, in its
 * disabled state until a tour exists. Per process, like sign-up.
 */
export async function productTourShown(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue('product_tour', false, toEvaluationContext({ tenantId: PRE_TENANT }));
}

/**
 * `crm_home` (T-0132, D-L196) gates the P03 ROUTE — `/home` calls `notFound()`
 * while it is off, so typing the path gets a real 404 and nothing of the screen
 * ships — and, through `crmLiveNav()` as `home`, the rail and bottom-bar Home
 * entry and the signed-in landing (`lib/server/landing.ts`). No client module
 * names it.
 *
 * Per process, like the others, and presentation only: every widget reads
 * through the activities and deals APIs, which scope each row from the session
 * and `user_programme` whether this is on or off.
 */
export async function crmHomeEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue('crm_home', false, toEvaluationContext({ tenantId: CRM_SHELL }));
}

/**
 * The P03 widgets with no module behind them (D-L194), and the US$ toggle,
 * each behind its module's own flag. On, the widget is offered and drawn in the
 * design's own empty state (never a number or a name); off, it is neither drawn
 * nor offered in the Add-widget drawer. Read here and passed down as booleans.
 */
export interface HomeWidgetFlags {
  readonly aiNba: boolean;
  readonly whatsapp: boolean;
  readonly quota: boolean;
  readonly approvals: boolean;
  readonly kpis: boolean;
  readonly fx: boolean;
  /** T-0136's `calendar_sync`: the agenda's empty state offers "Connect calendar", disabled (D-P22). */
  readonly calendar: boolean;
}

export async function homeWidgetFlags(): Promise<HomeWidgetFlags> {
  await initialiseFeatureFlags();
  const context = toEvaluationContext({ tenantId: CRM_SHELL });
  const read = (name: 'ai_nba' | 'whatsapp_inbox' | 'quota' | 'approvals' | 'home_kpis' | 'fx_display' | 'calendar_sync') =>
    featureFlagClient().getBooleanValue(name, false, context);
  const [aiNba, whatsapp, quota, approvals, kpis, fx, calendar] = await Promise.all([
    read('ai_nba'),
    read('whatsapp_inbox'),
    read('quota'),
    read('approvals'),
    read('home_kpis'),
    read('fx_display'),
    read('calendar_sync'),
  ]);
  return { aiNba, whatsapp, quota, approvals, kpis, fx, calendar };
}
