import { InMemoryProvider, OpenFeature, type Client } from '@openfeature/server-sdk';
import {
  enabledFeatureFlags,
  flagProcessNodeEnv,
  type FlagProcessNodeEnv,
} from '@kasuwa/config/feature-flags';

/**
 * Feature flags.
 *
 * The convention (founding pack 3.17) is that every user-visible change ships
 * behind a flag, which is what makes trunk-based development safe with thirteen
 * agents merging in parallel. That only works if the wiring exists before the
 * first feature does — otherwise the first person who needs a flag invents
 * their own.
 *
 * `FLAGS` holds only flags a task has asked for, each with the task that owns
 * it. A unit test pins the list, so a flag added without a task has to justify
 * itself in review.
 *
 * Provider choice (D-L11): the in-memory provider now; Unleash or GrowthBook
 * when the first flag needs per-tenant targeting. Swapping providers is what
 * OpenFeature exists for, so this is a cheap decision to defer.
 */

export interface FlagDefinition {
  /** What the flag hides, in one sentence. */
  readonly description: string;
  /** The value when nothing has switched it. */
  readonly defaultValue: boolean;
  /** The task or decision that owns turning it on. */
  readonly owner: string;
  /**
   * Whether `KASUWA_FEATURE_FLAGS_ON` may switch this flag on in a production
   * process. `false` makes the process refuse to boot instead — for a flag
   * whose backing work does not exist yet. Lifting it is a deliberate one-line
   * change, made by whoever ships that work.
   */
  readonly productionReady: boolean;
}

export const FLAGS = {
  /**
   * D-P2: self-serve sign-up is built in MVP and shipped OFF until v1. It gates
   * the ROUTES of `P01/3`, `P01/4` and `P01/5.1` — a screen reachable by typing
   * its path is hidden, not gated. The first-admin onboarding steps
   * (`P01/5.2`–`5.5`, `P01/6`) are deliberately NOT behind it (T-0018).
   */
  self_serve_signup: {
    description: 'Public sign-up, verification and data-region choice (P01/3, P01/4, P01/5.1).',
    defaultValue: false,
    owner: 'T-0016 (endpoint), T-0007 (screens), D-P2',
    // NOT production-ready: the sign-up, verify-otp and resend endpoints are
    // contract-only (x-kasuwa-implemented: false) until T-0016. Turned on in
    // production today, every submission would answer 501. T-0016 flips this.
    productionReady: false,
  },
  /**
   * T-0035: the P02 console's PRESENTATION of the two panels the admin API has
   * not built. With it ON, KPIs (`P02/B2`) and skill cover (`P02/B3`) show
   * labelled sample data from inside apps/web instead of calling their
   * missing endpoints, and the e2e harness drives the console against the
   * real API on the flag-on process.
   *
   * IT IS NOT AN ACCESS CONTROL, AND IT DOES NOT GATE THE ADMIN API.
   * `apps/web/lib/admin-api.ts` calls the same same-origin `/api/v1/admin`
   * paths whether it is on or off, and nothing on the API reads it. Who may
   * read or write admin data is decided by the API's session and the
   * permissions engine (T-0032), never by this flag.
   */
  admin_live_api: {
    description:
      'P02 KPIs and skill cover show labelled sample data in place of their unbuilt endpoints (T-0035). Not an access control.',
    defaultValue: false,
    owner: 'T-0035',
    // Kept NOT production-ready for now (lead, 2026-10-03): sample figures in
    // front of a production supervisor are a product decision, made with the
    // T-0032 authorisation work reviewed end to end, not as a side effect.
    productionReady: false,
  },
  /**
   * T-0042 (D-L60, D-L64): the CRM app shell and the P04 Contacts list at
   * `/contacts`. It gates the ROUTES — `/contacts` and the `/contacts/[id]`
   * scaffolding answer a real 404 while it is off.
   *
   * Like `admin_live_api` it is a presentation switch, not an access control:
   * the list reads `GET /api/v1/contacts`, where the session and
   * `user_programme` decide what a caller reaches whether this is on or off.
   */
  crm_records: {
    description: 'The CRM shell and the P04 Contacts list at /contacts (T-0042).',
    defaultValue: false,
    owner: 'T-0042 (screens), T-0041 (live API), D-L64',
    // NOT production-ready until T-0041 serves q, the filters and
    // withheldFields on the live wire (D-L64). The screen is built against the
    // contract mock until then.
    productionReady: false,
  },
  /**
   * T-0057 (D-L64, D-L84): the P04 Accounts list, with its create and edit
   * sheet, at `/accounts`. It gates the ROUTE: `/accounts` answers a real 404
   * while it is off, whatever `crm_records` says. The CRM shell's nav links
   * `/accounts` only on a process where this is on.
   *
   * A presentation switch, not an access control, like `crm_records`: the
   * screen reads and writes `/api/v1/accounts`, where the session,
   * `user_programme` and `account.write` decide what a caller reaches and may
   * change whether this is on or off. Write controls show to every caller and
   * the API's 403 is the gate (D-L84).
   */
  crm_accounts: {
    description: 'The P04 Accounts list, create and edit at /accounts (T-0057).',
    defaultValue: false,
    owner: 'T-0057 (screen), T-0055 (live API), D-L64, D-L84',
    // NOT production-ready: the screen is proven against the contract mock,
    // and "non-writers see no write controls" waits on a capability read
    // (D-L84, T-0079). Lifting it is a deliberate one-line change.
    productionReady: false,
  },
  /**
   * T-0062 and T-0063 (D-L69, D-L85, D-L98): the P05 records — the contact
   * (the 360° view) at `/contacts/[id]` and the account at `/accounts/[id]`.
   * It gates both ROUTES: with it off each page is a real 404. Each record
   * sits in the CRM shell and also needs its list's flag on (`crm_records`
   * for the contact, `crm_accounts` for the account), or the shell's own link
   * would be a 404 there.
   *
   * A presentation switch, not an access control: the records, their
   * timelines and their writes go to `/api/v1/contacts/…`,
   * `/api/v1/accounts/…` and `/api/v1/activities`, where the session,
   * `user_programme` and the permissions engine decide everything whether
   * this is on or off.
   */
  crm_record_view: {
    description: 'The P05 records: the contact (the 360° view) at /contacts/[id] (T-0062) and the account at /accounts/[id] (T-0063).',
    defaultValue: false,
    owner: 'T-0062 and T-0063 (screens), T-0061 and T-0080 (timeline and activity API), D-L85, D-L98',
    // NOT production-ready: the contact record cannot yet complete a task seen
    // only on its timeline (T-0119), an account's children are not served
    // (T-0118), and write controls show to every caller until a capability
    // read exists (D-L84, T-0079).
    productionReady: false,
  },
  /**
   * T-0058 (D-L64, D-L86): the P04 Leads list and its Kanban by status, with
   * convert, at `/leads`. It gates the ROUTE: `/leads` answers a real 404
   * while it is off, whatever `crm_records` and `crm_accounts` say. The CRM
   * shell's nav links `/leads` only on a process where this is on.
   *
   * A presentation switch, not an access control, like the others: the
   * screen reads `/api/v1/leads` and writes through updateContact and
   * convertContact, where the session, `user_programme`, the D-P14/D-P18
   * rights and field security decide what a caller reaches and may change
   * whether this is on or off. Write controls show to every caller and the
   * API's 403 is the gate (D-L84).
   */
  crm_leads: {
    description: 'The P04 Leads list, Kanban by status and convert at /leads (T-0058).',
    defaultValue: false,
    owner: 'T-0058 (screen), T-0076 (live API), D-L64, D-L86',
    // NOT production-ready: the screen is proven against the contract mock,
    // and hiding convert from callers without contact.write waits on a
    // capability read (D-L84, T-0079). Lifting it is a deliberate one-line change.
    productionReady: false,
  },
  crm_activities: {
    description: 'The P07 activities screen at /activities: my tasks by bucket, the calendar, compose, snooze and reschedule (T-0083).',
    defaultValue: false,
    owner: 'T-0083 (screen), T-0082 (API), D-L105, D-L107',
    // NOT production-ready: the screen is proven against the contract mock,
    // and hiding write controls from callers without activity.write waits on a
    // capability read (D-L84, T-0079). Lifting it is a deliberate one-line change.
    productionReady: false,
  },
  /**
   * T-0115 and T-0116 (D-L88, D-L93, D-L114): the P10 in-call scripts in
   * manual mode — the builder at `/scripts` and `/scripts/[scriptId]`, the
   * agent's run at `/script-runs/[runId]`, and the "Start script" control on
   * the contact record. It gates the three ROUTES (a real 404 while it is off)
   * and the start control, which the record's server page reads and passes
   * down as a boolean.
   *
   * A presentation switch, not an access control: authoring needs
   * `script.write` and a run needs `script.run`, decided by the scripting API
   * from the session and `user_programme` whether this is on or off.
   */
  crm_scripts: {
    description: 'The P10 in-call scripts in manual mode: the builder at /scripts (T-0115) and the agent run at /script-runs/[runId], started from the contact record (T-0116).',
    defaultValue: false,
    owner: 'T-0115 and T-0116 (screens), T-0113 and T-0114 (API), D-L88, D-L114',
    // NOT production-ready: the builder's "real 404 for a non-writer" and its
    // nav entry wait for a capability read (T-0079, D-L84), and the run screen
    // is proven against the contract mock only. Lifting it is a one-line change.
    productionReady: false,
  },
  /**
   * T-0109 (D-L88, D-L113, D-L115, D-L123, D-L124, D-L127): the P06 pipeline
   * board and list view at `/pipelines` and `/pipelines/[pipelineId]`. It
   * gates both ROUTES (a real 404 while it is off) and the CRM nav's Deals
   * entry (`crmLiveNav()`).
   *
   * A presentation switch, not an access control: the pipelines and deals API
   * scopes every read from the session and `user_programme`, and refuses a
   * move or a create the caller's rights and field security do not allow,
   * whether this is on or off.
   */
  crm_pipeline: {
    description: 'The P06 pipeline board and list view at /pipelines/[pipelineId], with the pipeline index at /pipelines (T-0109).',
    defaultValue: false,
    owner: 'T-0109 (screen), T-0107 and T-0108 (API), D-L88, D-L115',
    // NOT production-ready: the screen is proven against the contract mock,
    // and hiding write controls from callers without deal.write waits on a
    // capability read (D-L84, T-0079). Lifting it is a one-line change.
    productionReady: false,
  },
  /**
   * T-0087 (D-L133, D-L135, ADR-0014): the P27 global search screen at
   * `/search` and the Ctrl/Cmd+K command palette in the CRM shell. It gates
   * the ROUTE (a real 404 while it is off), the shell's header entry and the
   * palette, through `crmLiveNav()`.
   *
   * A presentation switch, not an access control: searchRecords and
   * lookupRecords scope every hit from the session and `user_programme`, and
   * apply field security, whether this is on or off.
   */
  crm_search: {
    description: 'The P27 global search screen at /search and the Ctrl/Cmd+K command palette in the CRM shell (T-0087).',
    defaultValue: false,
    owner: 'T-0087 (screen and palette), T-0085 and T-0086 (API), D-L133, D-L135',
    // NOT production-ready: proven against the contract mock only, and the
    // deal hits link nowhere until the spec is re-pinned after T-0110.
    productionReady: false,
  },
  /**
   * The P18 customisation studio at /admin/custom-fields, and the settings
   * menu's "Fields" entry that links it (T-0090). Gates a ROUTE and a link:
   * it grants nothing, because every custom-field write is decided by the
   * API (`custom_field.write`, the tenant-admin flag) whether this is on or off.
   */
  crm_custom_fields: {
    description: 'The P18 customisation studio for custom fields at /admin/custom-fields, and its settings-menu entry (T-0090).',
    defaultValue: false,
    owner: 'T-0090 (studio), T-0088 and T-0089 (contract and API), ADR-0016, D-L128',
    // NOT production-ready: proven against the contract mock and one live
    // journey, and the capability read (T-0079) that would hide the write
    // controls from non-writers does not exist yet.
    productionReady: false,
  },
  /**
   * T-0094 (D-L146, D-L166): CSV import of contacts. Unlike the presentation
   * switches above, it gates the API itself: with it off, every
   * `/api/v1/imports` route answers the never-existed `404 not_found`, the
   * contacts list's `importId` filter answers an empty page, and the worker
   * consumes none of the three import queues. The screens are T-0096's.
   *
   * It grants nothing: who may import is `contact.import` in the programme,
   * decided by the permissions engine whether this is on or off.
   */
  crm_import: {
    description: 'CSV import of contacts: the /api/v1/imports routes, the importId contacts filter and the worker import queues (T-0094).',
    defaultValue: false,
    owner: 'T-0094 (API and worker), T-0096 (screens), D-L146, D-L166',
    // NOT production-ready: no screen drives it yet (T-0096), and the
    // orphaned-queue sweep and the head-404 reconcile are follow-ups (D-L166).
    productionReady: false,
  },
  /**
   * T-0100 (D-L146, D-L164): the in-app notifications the bell and centre show
   * (P26; T-0101 owns the screens). A PRESENTATION switch, like `crm_search`:
   * it gates the screens, not the API. The producers, the outbox consumer and
   * the four routes run whether or not it is on, deliberately: an event that
   * is appended and never consumed would sit in the queue, and the routes
   * serve only the caller's own rows. It grants nothing.
   */
  crm_notifications: {
    description: 'The P26 notification bell and centre in the CRM shell (T-0101); the notifications API and consumer run regardless (T-0100).',
    defaultValue: false,
    owner: 'T-0101 (screens), T-0100 (API and consumer), T-0099 (contract), D-L87, D-L146, D-L164',
    // NOT production-ready: no screen reads it yet (T-0101), and old
    // notifications are not purged (D-L146's retention is a follow-up).
    productionReady: false,
  },
  /**
   * T-0097 (D-L146, D-L175): the P28 duplicates and merge screen at
   * `/contacts/duplicates`, and the Contacts list's link to it. A PRESENTATION
   * switch, like `crm_custom_fields`: T-0095 serves the five duplicates and
   * merge operations ungated, so this flag hides a screen and grants nothing.
   * Who may merge is `contact.write` in the programme, decided by the API.
   */
  crm_duplicates: {
    description: 'The P28 duplicates and merge screen at /contacts/duplicates and its link on the Contacts list (T-0097).',
    defaultValue: false,
    owner: 'T-0097 (screen), T-0095 (API), D-L146, D-L175',
    // NOT production-ready: proven against the contract mock only; the live
    // journey against T-0095's real API follows once the screen merges.
    productionReady: false,
  },
  /**
   * T-0130 (D-L193, D-L194): the CRM rail and phone bottom-bar entries for
   * modules that are not built yet. Each is drawn as the design draws it, in
   * its disabled state (a non-link announced "Not available yet"), only where
   * its flag is on; off, the entry is not drawn. Each flag is the module's own,
   * so the entry comes alive with the module. Presentation only: grants nothing.
   */
  crm_inbox: {
    description: 'The Inbox entry in the CRM rail and bottom bar, a disabled placeholder until the P08 inbox is built (T-0130, D-L194).',
    defaultValue: false,
    owner: 'T-0130 (shell placeholder), the P08 inbox when it is built',
    productionReady: false,
  },
  crm_tickets: {
    description: 'The Tickets entry in the CRM rail, a disabled placeholder until tickets are built (T-0130, D-L194).',
    defaultValue: false,
    owner: 'T-0130 (shell placeholder), the tickets module when it is built',
    productionReady: false,
  },
  crm_calls: {
    description: 'The Calls entry in the CRM rail, a disabled placeholder until the P09 voice screens are built (T-0130, D-L194).',
    defaultValue: false,
    owner: 'T-0130 (shell placeholder), the P09 voice screens when they are built',
    productionReady: false,
  },
  crm_reports: {
    description: 'The Reports entry in the CRM rail, a disabled placeholder until reports are built (T-0130, D-L194).',
    defaultValue: false,
    owner: 'T-0130 (shell placeholder), the reports module when it is built',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the P06 "Show US$" switch. No FX module serves a rate,
   * so the switch is drawn in the design's disabled state and no US$ figure
   * is ever drawn. It comes alive with the FX module.
   */
  fx_display: {
    description: 'The disabled Show US$ switch on the P06 board header until an FX rate is served (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135: the P06 board's summary line (open pipeline, weighted, won in the
   * window, open deals). Every figure is the board read's own per-currency
   * totals and exact counts (D-P19), added per currency and never converted.
   * Off by default because R4 kept the board to per-column figures; the lead
   * asked for the line in the D-L193 pass.
   */
  pipeline_summary: {
    description: 'The P06 board summary line built from the served column totals and counts (T-0135).',
    defaultValue: false,
    owner: 'T-0135',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the P06 first-pipeline template picker. No operation
   * creates a pipeline yet, so "Create pipeline" is drawn disabled.
   */
  pipeline_templates: {
    description: 'The P06 first-pipeline template picker, with Create disabled until a pipeline can be created (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the last-WhatsApp-contact chip on P06 cards and the
   * list's WhatsApp column. No deal read carries it, so every cell is the
   * design's empty dash.
   */
  whatsapp_recency: {
    description: 'The last WhatsApp contact on P06 cards and list rows, an empty dash until the inbox serves it (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the deal detail's Products card (line items, VAT 7.5%
   * and totals), in its empty state: no product or price-book module exists.
   */
  deal_products: {
    description: 'The P06 deal detail Products and VAT card, empty until products exist (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the deal detail's AI Deal risk card, in its empty
   * state: no scoring exists.
   */
  deal_risk: {
    description: 'The P06 deal detail Deal risk card, empty until scoring exists (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the deal detail's Contact roles and Competitors cards.
   * Contact roles shows the served primary contact; roles, engagement and
   * competitors have no backend and show the design's empty state.
   */
  deal_relationships: {
    description: 'The P06 deal detail Contact roles and Competitors cards (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0135 (D-L194): the deal detail's Quotes and Approval history cards, in
   * their empty states: no quote or approval module exists.
   */
  deal_quotes: {
    description: 'The P06 deal detail Quotes and Approval history cards, empty until those modules exist (T-0135, D-L194).',
    defaultValue: false,
    owner: 'T-0135 (placeholder)',
    productionReady: false,
  },
  /**
   * D-L194, T-0131: the P01/6 "Take a 2-minute tour" button. There is no tour
   * yet, so with the flag on the button is drawn in the design's place in its
   * disabled state, never as a link to nothing. Presentation only.
   */
  product_tour: {
    description: 'The P01/6 product-tour button, drawn disabled until a tour exists (D-L194).',
    defaultValue: false,
    owner: 'T-0131 (placeholder), D-L194',
    // NOT production-ready: there is no tour behind the button.
    productionReady: false,
  },
  /**
   * T-0133 (D-L194, D-L195): the P04 lists' Map segment, drawn DISABLED in the
   * view switcher with the design's tooltip. The Map view itself answers 501
   * (D-L69, T-0039); the flag shows where it will be, and grants nothing.
   */
  map_view: {
    description: 'The disabled Map segment in the P04 list view switchers (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder), D-L69',
    productionReady: false,
  },
  /**
   * T-0133 (D-L194, D-L195): the P04 lists' selection column and bulk action
   * bar. No bulk endpoint exists, so every bar action is drawn disabled; on
   * Accounts no action is allowed (T-0057), so only the column is drawn.
   */
  bulk_actions: {
    description: 'Row selection and the bulk action bar on the P04 lists, actions disabled until built (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder), T-0057, T-0058',
    productionReady: false,
  },
  /**
   * T-0133 (D-L194): the P04 saved-views menu. Saved views have no backend:
   * the menu offers the one built-in view and a disabled "Save current
   * filters as a view".
   */
  saved_views: {
    description: 'The saved-views menu on the P04 lists, with only the built-in view (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0133 (D-L194): the P04 "Last activity" column. No list read carries a
   * last activity, so every cell is the design's empty dash.
   */
  last_activity: {
    description: 'The Last activity column on the P04 lists, empty until a list read serves it (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0133 (D-L194, ADR-0003): the phone cards' swipe actions, Call, WhatsApp
   * and SMS. Telephony and the inbox are not wired, so they are drawn disabled.
   */
  quick_actions: {
    description: 'Call, WhatsApp and SMS swipe actions on the P04 phone cards, disabled until wired (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder), ADR-0003',
    productionReady: false,
  },
  /**
   * T-0133 (D-L194): the P04 filter chips the design draws for filters no list
   * read declares (Preferred language, Consent status, and State/LGA, Source
   * or DND where a list cannot filter on them), drawn disabled.
   */
  more_filters: {
    description: 'Disabled P04 filter chips for filters the list reads do not declare yet (T-0133, D-L194).',
    defaultValue: false,
    owner: 'T-0133 (placeholder)',
   * D-L194, T-0137: the P26 notification types that have no producer yet
   * (mentions, approvals, SLA warnings, campaigns, payments, e-invoices,
   * security). With the flag on, the centre's filter rail and the bell's chips
   * draw them where the design does, disabled; off, they are not drawn. Each
   * comes alive with the module that produces it. Presentation only.
   */
  notification_types: {
    description: 'The P26 filter entries for notification types no module produces yet, drawn disabled (T-0137, D-L194).',
    defaultValue: false,
    owner: 'T-0137 (placeholder), each producing module when it is built',
    productionReady: false,
  },
  /**
   * D-L194, T-0137: P26 D/D1, notification preferences at
   * `/settings/notifications`, and the Preferences button, the bell's gear and
   * B2's "Set preferences" that lead to it. There is no preferences API, so
   * the screen is drawn in its disabled state and saves nothing. Off, the
   * route is a 404 and nothing links to it.
   */
  notification_preferences: {
    description: 'P26 notification preferences at /settings/notifications and the links to it, drawn disabled until a preferences API exists (T-0137, D-L194).',
    defaultValue: false,
    owner: 'T-0137 (placeholder), the notification-preferences API when it is built',
    productionReady: false,
  },
  /**
   * D-L194, T-0137: P26 C, the toast stack for notifications that arrive while
   * a page is open. Nothing pushes a notification to the browser yet (the
   * list is never read on a timer, T-0101 I5), so the stack is mounted and
   * stays empty, the design's own empty state.
   */
  notification_toasts: {
    description: 'The P26 notification toast stack, mounted empty until notifications are pushed to the browser (T-0137, D-L194).',
    defaultValue: false,
    owner: 'T-0137 (placeholder), the realtime push when it is built',
    productionReady: false,
  },
  /**
   * D-L194, T-0137: P26 A2, the critical security banner under the top bar
   * and the pinned critical row. No module raises a security alert yet, so the
   * banner is mounted and draws nothing until one does.
   */
  security_alerts: {
    description: 'The P26 critical security banner, mounted empty until sign-in alerts are raised (T-0137, D-L194).',
    defaultValue: false,
    owner: 'T-0137 (placeholder), the sign-in alerting module when it is built',
    productionReady: false,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export function isFlagName(name: string): name is FlagName {
  return Object.prototype.hasOwnProperty.call(FLAGS, name);
}

interface InMemoryFlag {
  readonly variants: { readonly on: boolean; readonly off: boolean };
  readonly defaultVariant: 'on' | 'off';
  readonly disabled: boolean;
}

/**
 * The in-memory provider's configuration: every declared flag at its default,
 * except the ones named in `enabled`.
 *
 * An unknown name THROWS. A typo in a deployment variable must stop the boot —
 * the alternative is a flag that someone believes is on and is not.
 */
export function flagConfiguration(enabled: readonly string[]): Record<FlagName, InMemoryFlag> {
  const unknown = enabled.filter((name) => !isFlagName(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown feature flag(s) in KASUWA_FEATURE_FLAGS_ON: ${unknown.join(', ')}`);
  }
  const on = new Set(enabled);
  const entries = (Object.keys(FLAGS) as FlagName[]).map((name): [FlagName, InMemoryFlag] => [
    name,
    {
      variants: { on: true, off: false },
      defaultVariant: on.has(name) || FLAGS[name].defaultValue ? 'on' : 'off',
      disabled: false,
    },
  ]);
  return Object.fromEntries(entries) as Record<FlagName, InMemoryFlag>;
}

/**
 * Fail-closed guard: a production process may not switch on a flag whose
 * backing work is not production-ready.
 *
 * Shaped like `assertAuthModeIsSafe` in `@kasuwa/config`: same failure, same
 * reason. Without it, one deployment variable would put self-serve sign-up in
 * front of the public before T-0016's endpoints exist.
 */
export function assertFlagsAreProductionSafe(env: {
  readonly nodeEnv: FlagProcessNodeEnv;
  readonly enabled: readonly string[];
}): void {
  if (env.nodeEnv !== 'production') {
    return;
  }
  const blocked = env.enabled.filter((name) => isFlagName(name) && !FLAGS[name].productionReady);
  if (blocked.length > 0) {
    throw new Error(
      `Refusing to start: KASUWA_FEATURE_FLAGS_ON switches on ${blocked.join(', ')} with ` +
        'NODE_ENV=production, and the registry marks it not production-ready. Its backing ' +
        'work does not exist yet (see FLAGS in @kasuwa/feature-flags for the owner).',
    );
  }
}

const EVALUATION_CONTEXT_KEYS = ['tenantId', 'programmeId', 'userId'] as const;

/**
 * The attributes every flag evaluation must carry. Targeting rules will be
 * written against these, and a rule that cannot see `tenantId` is a rule that
 * rolls out to everyone at once.
 */
export interface KasuwaEvaluationContext {
  tenantId: string;
  programmeId?: string;
  userId?: string;
}

let initialised = false;

/**
 * Registers the provider once per process. The flags switched on come from the
 * process environment through `@kasuwa/config` — never from a request.
 */
export async function initialiseFeatureFlags(): Promise<void> {
  if (initialised) {
    return;
  }
  const enabled = enabledFeatureFlags();
  // Unknown names are refused by flagConfiguration; production-readiness here.
  const configuration = flagConfiguration(enabled);
  assertFlagsAreProductionSafe({ nodeEnv: flagProcessNodeEnv(), enabled });
  await OpenFeature.setProviderAndWait(new InMemoryProvider(configuration));
  initialised = true;
}

export function featureFlagClient(): Client {
  return OpenFeature.getClient('kasuwa');
}

export function toEvaluationContext(context: KasuwaEvaluationContext): Record<string, string> {
  const result: Record<string, string> = { targetingKey: context.tenantId };
  for (const key of EVALUATION_CONTEXT_KEYS) {
    const value = context[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
