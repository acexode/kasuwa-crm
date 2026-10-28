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
   * T-0134 (D-L193, D-L194): the P05 record blocks the design draws whose
   * module does not exist yet. Each is built in the design's own empty or
   * disabled state, never with a fake number, name or total, and each comes
   * alive with its module. On in `pnpm demo`, off by default, so production
   * can hide them. Presentation switches only: none of them reads or grants
   * anything.
   */
  whatsapp_composer: {
    description: 'The P05 record composer (WhatsApp, SMS, Email, Note tabs) with the 24-hour window, and the WhatsApp/SMS/Email actions (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the channels module (send and the window), D-L194',
    productionReady: false,
  },
  ai_summary: {
    description: 'The P05 record AI summary card, in its empty state until the AI module serves summaries (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the AI module, D-L194',
    productionReady: false,
  },
  ai_nba: {
    description: 'The P05 record next-best-action card, and the P03 Home "Next best actions" and "AI usage" widgets, in their empty states until the AI module serves suggestions (T-0134, T-0132).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the AI module, D-L194',
    productionReady: false,
  },
  call_bar: {
    description: 'The Call action on records, disabled until the telephony integration places calls (T-0134); and the P10 run call bar, not connected, with the loan card and "Writes to record" in their empty states (T-0139, D-L88, D-P31).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the voice module (ADR-0003), D-L194',
    productionReady: false,
  },
  record_related: {
    description: 'The P05 record Related lists (deals, tickets, quotes, invoices, campaigns) and their New deal, New ticket and payment-link actions, empty until their modules serve them (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the pipeline, tickets, billing and campaigns modules, D-L194',
    productionReady: false,
  },
  identity_check: {
    description: 'The P05 contact Identity card (NIN and BVN checks), not checked until the identity integration exists (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the identity integration, D-L194',
    productionReady: false,
  },
  record_addresses: {
    description: 'The P05 record Addresses card, showing the State and LGA the record holds until addresses are served (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the addresses contract, D-L194',
    productionReady: false,
  },
  record_follow: {
    description: 'The Follow button on P05 records, disabled until following is served (T-0134).',
    defaultValue: false,
    owner: 'T-0134 (placeholder), the notifications module, D-L194',
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
   * T-0164 (M05 P0): the programme product catalogue API — products, price
   * books and tax profiles. Off by default until P21 screens land (T-0171).
   */
  crm_products: {
    description: 'The programme-scoped product catalogue: products, variants, price books and tax profiles (T-0164).',
    defaultValue: false,
    owner: 'T-0164',
    productionReady: false,
  },
  /**
   * T-0165 (M05 P0): programme quotes API — create/list/get/update and gated
   * status changes. Off by default until P21 screens land (T-0171).
   */
  crm_quotes: {
    description: 'Programme-scoped quotes with line items, discounts, validity and gated status changes (T-0165).',
    defaultValue: false,
    owner: 'T-0165',
    productionReady: false,
  },
  /**
   * T-0166 (M05 P0): in-app discount approvals for quotes above a programme
   * threshold. Off by default until P21 screens land (T-0171).
   */
  quote_approvals: {
    description: 'In-app discount approval requests and decisions for programme quotes (T-0166).',
    defaultValue: false,
    owner: 'T-0166',
    productionReady: false,
  },
  /**
   * T-0167 (M05 P0): quote PDF render and email send through the channel
   * adapter. Off by default until a real email provider exists and P21
   * screens land (T-0171). Send fails closed via NullChannelProvider in
   * production regardless of this flag.
   */
  quote_send: {
    description: 'Quote PDF template and send by email through the email channel kind (T-0167).',
    defaultValue: false,
    owner: 'T-0167',
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
   * T-0136 (D-L194, D-P22): the P07 calendar's external-calendar furniture,
   * drawn in the design's not-connected state: the "Your work calendar isn't
   * connected" banner with its Connect buttons (disabled), the "Kasuwa only"
   * source chip and the attendee panel of the event detail, empty. No
   * calendar is read and nothing is connected. Presentation only.
   */
  calendar_sync: {
    description: 'P07 calendar: the not-connected Google/Microsoft banner, source chip and empty attendee panel (T-0136, D-L194, D-P22).',
    defaultValue: false,
    owner: 'T-0136 (placeholder), the calendar-sync module when it is built (D-P22)',
    productionReady: false,
  },
  /**
   * T-0136 (D-L194, D-P22): the P07 "Booking pages" view, drawn as the
   * design's editor in its empty, disabled state. Nothing is published and
   * nothing is saved. Presentation only.
   */
  booking_pages: {
    description: 'P07 Booking pages view, the design editor in its empty, disabled state (T-0136, D-L194, D-P22).',
    defaultValue: false,
    owner: 'T-0136 (placeholder), the booking-pages module when it is built (D-P22)',
    productionReady: false,
  },
  /**
   * T-0136 (D-L194): the P07 phone "Check-in" view and the composer's Visit
   * type, drawn in their disabled state. No location or photo is read.
   */
  field_checkin: {
    description: 'P07 phone Check-in view and the composer Visit type, disabled (T-0136, D-L194).',
    defaultValue: false,
    owner: 'T-0136 (placeholder), the field check-in module when it is built',
    productionReady: false,
  },
  /**
   * T-0136 (D-L194, D-L105): activity priority. The contract has none, so
   * each task row draws the design's priority pill as "No priority" and the
   * "High priority" and "Deals" filter chips are drawn disabled.
   */
  activity_priority: {
    description: 'P07 task rows: the priority pill placeholder and the High priority and Deals filter chips, disabled (T-0136, D-L194).',
    defaultValue: false,
    owner: 'T-0136 (placeholder), the activity-priority work when it is built (D-L105)',
    productionReady: false,
  },
  /**
   * T-0136 (D-L194, D-P29): the composer's "Remind the customer by" block,
   * drawn with every channel off and disabled. Nothing is ever sent.
   */
  activity_reminders: {
    description: 'P07 composer: the customer-reminder channels, disabled (T-0136, D-L194, D-P29).',
    defaultValue: false,
    owner: 'T-0136 (placeholder), the reminders work when it is built (D-P29)',
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
    productionReady: false,
  },
  /**
   * T-0141 (D-L193, D-L194): P28's admin "Data management" area at
   * `/admin/data/*`: the admin bar with its section title, the 232px sub-nav
   * and the sticky action bar, holding the import wizard (with the design's
   * Review step) and the duplicates screen. With it on, `/contacts/import` and
   * `/contacts/duplicates` redirect into the area; off, they render in the CRM
   * shell as before. Presentation only: grants nothing.
   */
  data_management: {
    description: 'The P28 admin Data management area at /admin/data, with the five-step import wizard and duplicates (T-0141, D-L194).',
    defaultValue: false,
    owner: 'T-0141 (screens), T-0096, T-0097',
    productionReady: false,
  },
  /**
   * T-0141 (D-L194): P28's Migration section (frames B–B5), drawn in the
   * design's own not-connected state: no connector exists, so the connect
   * button is disabled and nothing is read from another CRM.
   */
  data_migration: {
    description: 'The P28 Migration placeholder in Data management, not connected (T-0141, D-L194).',
    defaultValue: false,
    owner: 'T-0141 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0141 (D-L194): P28's Export centre (frames D, D1), drawn empty: there is
   * no export or approval API, so the list is the design's empty state and
   * New export is disabled.
   */
  data_export: {
    description: 'The P28 Export centre placeholder in Data management, empty (T-0141, D-L194).',
    defaultValue: false,
    owner: 'T-0141 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0141 (D-L194): P28's Data-subject requests (frames E–E3), drawn empty:
   * there is no DSR API, so the tiles carry no figure, the table is the
   * design's empty state and Log a request is disabled.
   */
  dsr: {
    description: 'The P28 Data-subject requests placeholder in Data management, empty (T-0141, D-L194).',
    defaultValue: false,
    owner: 'T-0141 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0141 (D-L194, D-L146): the third record slot in the P28 merge compare,
   * drawn disabled. Merges are pairwise (D-L146); the slot shows where a
   * three-way merge would sit and holds no record.
   */
  merge_three_way: {
    description: 'The disabled third record slot in the P28 merge compare; merges stay pairwise (T-0141, D-L146, D-L194).',
    defaultValue: false,
    owner: 'T-0141 (placeholder), D-L146',
    productionReady: false,
  },
  /**
   * T-0140 (D-L194): the P02 console's designed controls whose backend is not
   * built. The usage meters the API does not serve (WhatsApp conversations,
   * storage, AI credits) draw in their empty state, and Alert settings, the
   * programme cards' Edit links and the role panel's View people are drawn
   * disabled. Presentation only; it grants nothing.
   */
  admin_placeholders: {
    description: 'P02 usage meters without data in their empty state, and disabled P02 controls with no backend yet (T-0140, D-L194).',
    defaultValue: false,
    owner: 'T-0140 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0138 (D-L194, D-L195, D-L133 R19): P27's RECENT SEARCHES and RECENTLY
   * VIEWED panel, in the design's empty state. Nothing is stored, on the device
   * or the server, so the panel only ever says that searches will show there.
   */
  recent_searches: {
    description: 'The P27 recent searches and recently viewed panel, empty until a store exists (T-0138, D-L194).',
    defaultValue: false,
    owner: 'T-0138 (placeholder), D-L133',
    productionReady: false,
  },
  /**
   * T-0138 (D-L194, D-L87): the P27 programme scope pill and menu (B, B1), the
   * programme tags on search hits and the palette's Switch programme step
   * (D2). Search already covers every programme the session is assigned to;
   * narrowing it is not served, so the scope reads "All my programmes" and the
   * single programmes are drawn disabled. Grants nothing.
   */
  programme_scope_search: {
    description: 'The P27 programme scope pill, scope menu and Switch programme step, narrowing disabled until served (T-0138, D-L194, D-L87).',
    defaultValue: false,
    owner: 'T-0138 (placeholder), D-L87',
    productionReady: false,
  },
  /**
   * T-0138 (D-L194): the command palette's Ask AI row and "? Ask AI" hint
   * (P27 D, D3), drawn disabled. No assistant exists.
   */
  ai_assistant: {
    description: 'The P27 palette Ask AI row, disabled until an assistant exists (T-0138, D-L194).',
    defaultValue: false,
    owner: 'T-0138 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0138 (D-L194): P27's owner and date filters, and the owner and updated
   * columns on the results page. Search serves neither an owner nor an update
   * time, so only "Any owner" and "Any time" can be chosen and the columns
   * show the design's empty dash.
   */
  search_filters: {
    description: 'The P27 owner and date filters and the owner and updated columns, empty until search serves them (T-0138, D-L194).',
    defaultValue: false,
    owner: 'T-0138 (placeholder)',
    productionReady: false,
  },
  /**
   * T-0132 (D-L196): the P03 Home route at `/home`, the rail and bottom-bar
   * Home entry, and Home as the signed-in landing. Off, `/home` is a real 404
   * and the browser lands on the first live CRM screen as before.
   * Presentation only: every widget reads through the existing scoped APIs.
   */
  crm_home: {
    description: 'The P03 Home screen at /home, its nav entry, and Home as the signed-in landing (T-0132, D-L196).',
    defaultValue: false,
    owner: 'T-0132, D-L196',
    // NOT production-ready: the layout is kept in the browser until the per-user table exists.
    productionReady: false,
  },
  /**
   * T-0159 (D-L196, D-L204): the Home layout is kept per user on the server
   * (`/api/v1/me/home-layout`) instead of in the browser's localStorage. Off,
   * the browser store is used as before. Existing browser layouts are not
   * migrated (decided: not worth it).
   */
  home_layout_server: {
    description: 'The P03 Home layout is stored per user on the server instead of in the browser (T-0159, D-L196).',
    defaultValue: false,
    owner: 'T-0159, D-L196',
    productionReady: false,
  },
  /**
   * D-L194, T-0132: Home widgets whose module is not built. With a flag on,
   * its widgets are offered and drawn in the design's own empty state, never
   * with a number or a name; off, they are neither drawn nor offered. Home's
   * "Next best actions" and "AI usage" share T-0134's `ai_nba`.
   */
  whatsapp_inbox: {
    description: 'The Home "WhatsApp awaiting reply" widget, in its not-connected state until channels exist (T-0132, D-L194).',
    defaultValue: false,
    owner: 'T-0132 (placeholder), the WhatsApp channel when it is built',
    productionReady: false,
  },
  quota: {
    description: 'The Home quota, forecast and leaderboard widgets, in their empty state until quotas exist (T-0132, D-L194).',
    defaultValue: false,
    owner: 'T-0132 (placeholder), the quota model when it is built',
    productionReady: false,
  },
  approvals: {
    description: 'The Home "Approvals" widget, in its caught-up state until approvals exist (T-0132, D-L194).',
    defaultValue: false,
    owner: 'T-0132 (placeholder), approvals when they are built',
    productionReady: false,
  },
  home_kpis: {
    description:
      'The Home KPI widgets with no data source yet (tickets, queues, CSAT, programme stats, schedule, announcements, revenue, cost, profitability, SLA, pipeline by stage), in their empty state (T-0132, D-L194).',
    defaultValue: false,
    owner: 'T-0132 (placeholder), each module when it is built',
    productionReady: false,
  },
  /**
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
   * T-0139 (D-L194): the P10 elements with no backend yet. Each is drawn in
   * the design's own empty or disabled state, never with invented data, and
   * comes alive with the module that owns it. Presentation only: none of them
   * reaches an endpoint, and each grants nothing.
   */
  crm_studio: {
    description: 'The Studio entry in the CRM rail, a disabled placeholder (current on the script screens) until a capability read lets it link to the builder (T-0139, D-L194, R3).',
    defaultValue: false,
    owner: 'T-0139 (shell placeholder), T-0079',
    productionReady: false,
  },
  ai_script_hints: {
    description: 'The P10 run AI next-line suggestion strip, in its empty state with "Use line" disabled, until M17 serves suggestions (T-0139, D-L194).',
    defaultValue: false,
    owner: 'T-0139 (placeholder), M17',
    productionReady: false,
  },
  script_programme_assignment: {
    description: 'The P10 builder "Assigned to" programme chips, disabled: a script belongs to one programme (D-L91) until multi-programme assignment exists (T-0139, D-L194).',
    defaultValue: false,
    owner: 'T-0139 (placeholder), D-L91',
    productionReady: false,
  },
  script_preview: {
    description: 'The P10 builder Preview button, disabled until preview-as-agent with a sample record exists (T-0139, D-L88, D-L194).',
    defaultValue: false,
    owner: 'T-0139 (placeholder)',
    productionReady: false,
  },
  script_version_changes: {
    description: 'The P10 run version banner\'s "What changed" button, disabled until agents can read a newer version\'s change list (T-0139, D-L194).',
    defaultValue: false,
    owner: 'T-0139 (placeholder)',
    productionReady: false,
  },
  /**
   * D-L194, T-0142: the P18 Customisation Studio's sections with no backend yet.
   * Each route (`/admin/studio…`) is a real 404 while its flag is off, and its
   * settings-menu entry stays a non-link. On, the screen is drawn in the
   * design's own empty or disabled state: the four standard objects the
   * contract already names, and never an invented object, rule, layout or
   * number. Presentation only.
   */
  studio_objects: {
    description: 'P18 Object manager at /admin/studio and the object header chips, in their empty state until custom objects exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), custom objects when they are built',
    productionReady: false,
  },
  studio_layouts: {
    description: 'P18 page layouts and the layout builder at /admin/studio/layouts, in their empty state until layouts exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), page layouts when they are built',
    productionReady: false,
  },
  studio_validation: {
    description: 'P18 validation rules at /admin/studio/validation-rules, in their empty state until rules exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), validation rules when they are built',
    productionReady: false,
  },
  studio_relationships: {
    description: 'P18 relationships view at /admin/studio/relationships and its buttons, in their empty state until lookups exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), lookup and master-detail fields when they are built',
    productionReady: false,
  },
  studio_record_types: {
    description: 'P18 record types at /admin/studio/record-types, in their empty state until record types exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), record types when they are built',
    productionReady: false,
  },
  /**
   * D-L194, T-0142: the field editor's designed types the custom-field
   * contract refuses (multi-select, lookup, formula, roll-up, phone, email,
   * NIN/BVN secure, file), drawn as disabled cards in the type picker. Off,
   * the picker offers exactly the contract's six.
   */
  custom_field_types_extended: {
    description: 'P18 field types the contract does not accept yet, drawn disabled in the type picker (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), each field type when the contract accepts it',
    productionReady: false,
  },
  /**
   * D-L194, T-0142: what the field list and editor draw about a field that no
   * read serves yet: the "Used in" column and banner, "Not used anywhere", the
   * Filterable meter and the Required, Unique and Filterable switches, each in
   * its empty or disabled state. Off, none is drawn.
   */
  studio_field_usage: {
    description: 'P18 field usage, the Filterable meter and the field property switches, in their empty or disabled state (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), field usage and properties when they are served',
    productionReady: false,
  },
  /** D-L194, T-0142: the field editor's Translations tab, disabled until field-label translations are stored. */
  studio_field_translations: {
    description: 'P18 field editor Translations tab, drawn disabled until field-label translations exist (T-0142, D-L194).',
    defaultValue: false,
    owner: 'T-0142 (placeholder), field-label translations when they are built',
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
