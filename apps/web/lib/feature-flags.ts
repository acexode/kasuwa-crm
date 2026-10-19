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
 * The CRM shell's nav entries whose ROUTE is on in this process, by nav id.
 * An entry links only to a screen that answers; one whose flag is off is drawn
 * as "not available yet", exactly like an unbuilt one (`components/crm/crm-nav.ts`).
 */
export async function crmLiveNav(): Promise<string[]> {
  const [contacts, accounts, leads, activities, pipeline, search, csvImport, duplicates] = await Promise.all([
    crmRecordsEnabled(),
    crmAccountsEnabled(),
    crmLeadsEnabled(),
    crmActivitiesEnabled(),
    crmPipelineEnabled(),
    crmSearchEnabled(),
    crmImportEnabled(),
    crmDuplicatesEnabled(),
  ]);
  return [
    ...(leads ? ['leads'] : []),
    ...(contacts ? ['contacts'] : []),
    ...(accounts ? ['accounts'] : []),
    ...(activities ? ['activities'] : []),
    ...(pipeline ? ['deals'] : []),
    // Not a nav item: the shell's header entry and the Ctrl/Cmd+K palette (T-0087).
    ...(search ? ['search'] : []),
    // Not a nav item either: the Contacts list's import action links `/contacts/import` only where this is on (T-0096, I1).
    ...(csvImport ? ['import'] : []),
    // Not a nav item either: the Contacts list links `/contacts/duplicates` only where this is on (T-0097, I1).
    ...(duplicates ? ['duplicates'] : []),
  ];
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
