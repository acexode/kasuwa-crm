# Kasuwa CRM: Market Research, PRD, Technical Implementation Plan and Claude Design Prompt Pack for an Africa-First, BPO-Grade Multi-Tenant CRM

Build it, but build it as a combined CRM and contact-centre platform. The core should be WhatsApp-native engagement, Naira and local-currency billing, NDPA/GAID compliance and BPO multi-client isolation. No incumbent (Salesforce, Zoho, HubSpot, Dynamics) offers that combination natively, and it is the only defensible wedge against global vendors that bill in dollars at $14–$550 per user per month.

## TL;DR

- **The market gap is real and specific.** Zoho is strong on affordable breadth: Blueprint, Canvas, built-in inventory/invoicing, WhatsApp and a $14–$52 ladder. Salesforce is strong on enterprise depth: Flow, Omni-Channel routing, Experience Cloud portals, CPQ, Territory Management and Agentforce, on a $25–$550 ladder. Neither is built around Africa's operating realities: WhatsApp-first customers, NCC DND rules, FIRS/NRS e-invoicing, Paystack/Flutterwave/MoMo payments, NDPA cross-border rules or BPO multi-client tenancy. Kasuwa should unify the Zoho and Salesforce features your BPO actually uses and add these Africa and BPO layers as first-class modules.
- **Architecture:** a TypeScript modular monolith (NestJS + Next.js), not microservices. It sits on PostgreSQL with row-level security and a Salesforce-style metadata engine for custom objects. Redis/BullMQ, OpenSearch and S3-compatible storage support it. FreeSWITCH/WebRTC handles telephony, the WhatsApp Cloud API handles messaging, and Claude handles AI. The primary region is AWS Cape Town or Azure South Africa, with Lagos edge/local hosting for data-residency-sensitive tenants. This is the fastest path for a Claude Code–driven team and can later split into services along clean module boundaries.
- **Plan:** MVP in about 7 months with a core team of about 12 plus Claude Code. The MVP covers core CRM, unified WhatsApp/SMS/email inbox, softphone and preview/progressive dialer, ticketing, BPO client isolation, Naira billing and NDPA tooling, and your own BPO is tenant #1. v1 follows at about 12 months: predictive dialer, QA, WFM-lite, marketing automation, CPQ/e-invoicing, AI agent assist and marketplace. v2 follows at about 18–24 months: AI agents, low-code app builder, partner portals and expansion to Kenya, Ghana, South Africa and francophone markets. Price in local currency at roughly 40–60% below Zoho-plus-contact-centre stacks, with usage-based messaging and AI credits.

---

# PART 1 — CRM MARKET & FEATURE RESEARCH

## 1.1 Key findings

1. **Price ladders (2026 list, per user/month, annual billing, USD):**
   - **Salesforce Sales Cloud:** Starter $25, Pro $100, Enterprise $175, Unlimited $350 and Agentforce 1 Sales $550, plus a $0 Free Suite capped at 2 users. Prices were checked July 2026.\[1\] They reflect Salesforce's 1 August 2025 increase, which its newsroom described as "an average of 6%" and which applied only to Enterprise and Unlimited editions: Enterprise went from $165 to $175 and Unlimited from $330 to $350, per Redress Compliance. Starter and Pro prices did not change.
   - **Zoho CRM:** Free (3 users), Standard $14, Professional $23, Enterprise $40, Ultimate $52.\[2\]
   - **HubSpot:** Sales Hub Professional about $90–$100/seat and Enterprise $150/seat, plus one-time onboarding of $1,500/$3,500.\[3\]\[4\]
   - **Dynamics 365 Sales:** Professional $65, Enterprise $105, Premium $150.\[5\]
   - **Pipedrive:** $14–$79 annual ($24–$99 monthly).\[6\]
   - **Twenty (open source):** Cloud Pro is $9/user/month.\[7\]
2. **Salesforce's AI is now metered separately.** Agentforce has a $5 user licence (credits bought separately), $125/user add-ons for Sales/Service, $500 per 100,000 Flex Credits, or $2 per conversation for customer-facing agents.\[8\] HubSpot (Credits) and Microsoft (1,000 Copilot Credits per Sales Premium user) are converging on the same hybrid seat-plus-usage model.\[3\]\[9\] **Implication for Kasuwa:** usage-based AI and messaging credits are now an accepted pricing norm, so you can adopt them without market resistance.
3. **Contact-centre platforms add a second expensive seat for BPOs.** Genesys Cloud CX runs from $75 (CX1) to $240 (CX4) per user/month with a $2,000/month minimum.\[10\] NICE CXone Mpower Ultimate is $249/agent/month plus $0.25 per AI session. Five9 starts around $119 and Talkdesk around $85.\[10\]\[11\]\[12\] A BPO paying for Salesforce Service Cloud Enterprise ($175) plus a Genesys CX2 seat ($115) is spending about $290/agent/month before telephony. This is the stack-collapse opportunity.
4. **WhatsApp is the primary channel and its cost model is changing:**
   - Meta moved to per-message pricing on 1 July 2025.\[13\]
   - From 1 October 2026 it starts charging service messages and in-window utility messages, with a free tier of 1,000 service messages per business phone number per month.\[13\]\[14\]
   - Nigeria rates: about $0.062 per marketing message and $0.0101 per chargeable utility message (Techpoint, citing Meta's rate card).\[14\] Older BSP rate cards list $0.0516 marketing and $0.0067 utility, so rates are moving and must be data-driven in the product, not hard-coded.\[15\]
   - WhatsApp business-initiated calling is not available for Nigeria-registered business numbers, which affects voice-over-WhatsApp plans.\[16\]
5. **Compliance is now concrete in Nigeria:**
   - The GAID was issued 20 March 2025 and took effect 19 September 2025. It replaced the NDPR and operationalises the NDPA 2023, including DCPMI registration, annual Compliance Audit Returns, DPIAs and NDPC approval of cross-border transfer instruments.\[17\]\[18\]\[19\]
   - The NRS (formerly FIRS) MBS e-invoicing platform went live 1 August 2025. Enforcement starts with large taxpayers (≥₦5bn turnover), then medium taxpayers (₦1bn–₦5bn) from 1 July 2026, then smaller taxpayers from July 2027.\[20\]
   - The NCC's 2442 DND regime governs promotional messaging and calls.\[21\]
   - Any CRM selling to Nigerian enterprises must support all three natively.
6. **No hyperscaler region exists in Nigeria.** AWS has a Lagos Local Zone, but its nearest full region is Cape Town. Azure's nearest regions are South Africa North/West, and GCP's is Johannesburg.\[22\]\[23\] Local providers (Rack Centre, MainOne/Equinix, Galaxy Backbone, and new entrants such as AFRICLOUD's Lagos region) fill the gap.\[24\] The National Digital Economy and E-Governance Bill has been reported as aiming to mandate localisation of sensitive data. It was introduced in July 2024, sponsored by Hon. Adedeji Olajide, and had a joint National Assembly public hearing in November 2025. Separately, a Kasi Cloud press release (GlobeNewswire, 19 May 2026) says the already-issued National Cloud Policy 2025 "mandates in-country hosting for sensitive government and financial data". Design for "region-pluggable" tenancy from day one.
7. **Local CRM competitors are SME-focused and thin.** CRM Africa, Revwit (marketed as "Africa's first B2B Sales CRM"), Mahala CRM (marketed as "Africa's first 100% free CRM") and messaging-led players such as Arkesel compete mostly on price and WhatsApp/mobile-money fit.\[25\]\[26\]\[27\] None is positioned as an enterprise, multi-tenant, BPO-grade platform. The enterprise and BPO segment is open.

## 1.2 Vendor landscape

| Category | Vendors | Relevance to Kasuwa |
|---|---|---|
| Enterprise suites | Salesforce (Sales/Service/Marketing Cloud, Agentforce, Data Cloud), Microsoft Dynamics 365, Oracle CX (Sales/Service/Eloqua), SAP Sales & Service Cloud, SugarCRM, Creatio | Benchmark for depth: metadata platform, security, territory, CPQ, portals, AI agents |
| Mid-market all-in-one | Zoho CRM / CRM Plus / Zoho One (Desk, SalesIQ, Campaigns, Bigin, Analytics, Books), HubSpot (Sales/Service/Marketing/Content/Data/Commerce Hubs), Freshworks (Freshsales, Freshdesk, Freshcaller), Bitrix24, Odoo CRM | Benchmark for breadth-per-dollar and ease of setup: your users' daily expectations |
| Sales-first / modern | Pipedrive, Close, Copper, Insightly, Monday CRM, Attio | Benchmark for UX speed, pipeline ergonomics, built-in calling/sequences (Close), flexible data model (Attio) |
| Open source | Twenty (AGPL-3.0, NestJS/React/Postgres, metadata-driven),\[28\]\[29\] EspoCRM, SuiteCRM, Vtiger | Architecture references; Twenty is the closest modern reference for a metadata engine |
| CCaaS / CX (BPO) | Genesys Cloud CX, NICE CXone, Five9, Talkdesk, Zendesk, Freshdesk/Freshcaller, Amazon Connect | Benchmark for dialer, routing, WFM, QA, wallboards and compliance |
| African CRM / engagement | CRM Africa, Revwit, Mahala CRM, Arkesel, Engage Messaging; WhatsApp BSPs; CPaaS: Africa's Talking, Termii, Infobip, Twilio | Local price anchors and integration partners (SMS/USSD/voice/WhatsApp) |
| African payments / KYC | Paystack, Flutterwave, Interswitch, Remita, Monnify, Squad;\[30\] M-Pesa, MTN MoMo; Smile ID, Youverify, Dojah, VerifyMe | Native integrations (billing and in-CRM payment links, identity checks) |

## 1.3 Pricing reference (2026 list, USD per user/month unless stated)

| Vendor | Entry | Mid | Top | Notes |
|---|---|---|---|---|
| Salesforce Sales/Service Cloud | Free Suite (2 users); Starter $25 | Pro $100; Enterprise $175 | Unlimited $350; Agentforce 1 $550 | Enterprise+ annual only. Web Services API is a $25/user add-on on Pro and below. Premier Support is 30% of net licence fees\[1\] |
| Salesforce Agentforce | $5 user licence + Flex Credits | $125/user add-on (Sales/Service) | Included in Agentforce 1 | $500 per 100k Flex Credits, or $2 per conversation\[8\] |
| Salesforce Marketing | Marketing Cloud Growth from $1,500/org/month | Account Engagement from $1,250/org/month\[31\] | — | Org-priced, not per seat |
| Zoho CRM | Free (3 users); Standard $14 | Professional $23; Enterprise $40 | Ultimate $52; CRM Plus $57 | Bigin from $7. Team User add-on $9. Monthly billing is 25–52% higher\[32\] |
| HubSpot | Free; Starter ~$15–$20/seat | Sales/Service Pro ~$90–$100/seat | Sales/Service Enterprise $150/seat | Onboarding $1,500 (Pro)/$3,500 (Ent). Marketing Hub Pro ~$800–$890/month incl. 3 seats; Enterprise $3,600/month\[33\]\[34\] |
| Dynamics 365 Sales | Team Member $8 | Professional $65; Enterprise $105 | Premium $150 | Premium includes 1,000 Copilot Credits per user\[9\] |
| Pipedrive | Lite $14 | Growth $39; Premium $49 | Ultimate $79 | Monthly: $24/$49/$79/$99.\[35\] Campaigns, LeadBooster etc. are add-ons\[36\] |
| Twenty | Self-host free (AGPL) | Cloud Pro $9 | — | Native MCP server\[7\] |
| Genesys Cloud CX | CX1 $75 | CX2 $115 | CX4 $240 | $2,000/month minimum |
| NICE CXone | Core ~$110 | — | Mpower Ultimate $249 + $0.25/AI session | Strong WFM/QA |
| Five9 / Talkdesk | Five9 from ~$119; Talkdesk from ~$85 | — | — | Quote-based at scale |

Pricing caveat: Pipedrive plan names and prices vary across 2026 sources. Some list Essential/Advanced/Professional/Power/Enterprise at $14–$99,\[37\] while others list the current Lite/Growth/Premium/Ultimate.\[6\] Treat the official pricing page as authoritative at purchase time. Prices for Freshworks, Monday, Sugar, Oracle, SAP, Odoo, Bitrix24, Creatio, Insightly, Copper, Close, Attio and Vtiger were not verified for this report and are excluded from the table.

## 1.4 Consolidated feature inventory (by domain)

This is the union of capabilities across the vendors above, which Kasuwa's module list is built from.

1. **Contacts, accounts, leads:** leads, contacts, accounts/companies, households/B2C persons, account hierarchies, relationship maps, lead capture (web forms, WhatsApp click-to-chat, missed calls, USSD, imports), lead assignment rules (round-robin, territory, skill), lead conversion, duplicate rules and merge, enrichment, tags, segments, list views, Kanban/table/map views, 360° timeline, consent/communication preferences.
2. **Pipeline & opportunities:** multiple pipelines, stages with probabilities, stage-gating (Zoho Blueprint / Salesforce Path + validation), deal rotting, products on deals, competitors, contact roles, splits, sales teams, win/loss reasons, deal rooms, guided selling.
3. **Quotes, CPQ, products, price books, invoicing:** product catalogue, variants, price books by currency/segment, discount schedules, approval-gated discounts, bundles, quote templates/PDF, e-signature, sales orders, purchase orders, invoices, payment links, subscriptions/recurring billing, tax rules, e-invoicing clearance.
4. **Activities:** tasks, calls, meetings, events, reminders, cadences, calendar sync (Google/Microsoft), meeting scheduler/booking pages, notes, check-ins (field sales, geolocation).
5. **Email & sequences:** two-way email sync, shared inboxes, templates with merge fields, tracking (opens/clicks), sequences/cadences with multichannel steps, send-time optimisation, bounce/unsubscribe handling, deliverability (DKIM/SPF/DMARC).
6. **Telephony:** CTI connectors, built-in softphone (WebRTC), click-to-call, inbound routing, IVR, queues, ACD, call recording, voicemail drop, local presence numbers, power/preview/progressive/predictive dialers, call dispositions, whisper/barge/monitor, transcription and call analytics.
7. **Omnichannel inbox:** WhatsApp Business Platform, SMS, USSD, email, web chat, in-app chat, Facebook Messenger, Instagram DM, X, TikTok, Telegram, Apple/Google business messaging, unified conversation threading, routing, SLAs, canned responses, templates, chatbots.
8. **Marketing automation:** segments/lists, email campaigns, SMS/WhatsApp broadcasts, journeys/nurture flows, lead scoring, landing pages, forms, UTM/attribution, A/B testing, event management, social publishing, web visitor tracking, consent management.
9. **Customer service:** cases/tickets, queues, assignment and omni-channel routing, SLAs/entitlements and milestones, escalation, macros, knowledge base with versioning, customer self-service portal, community forums, CSAT/NPS surveys, bots, field service.
10. **Workflow automation:** record-triggered/scheduled/event-triggered flows, blueprints/state machines, approval processes (multi-step, parallel), assignment rules, escalation rules, webhooks, custom functions (Deluge/Apex equivalents), orchestration across departments (Zoho CommandCenter / Salesforce Flow Orchestration).
11. **AI:** predictive lead and deal scoring, forecasting, anomaly detection, conversation intelligence, summarisation (calls, emails, records), generative email/replies, next-best-action, agent assist (real-time suggestions, knowledge surfacing), autonomous AI agents (SDR, service), natural-language reporting, data enrichment, MCP/agent connectivity.
12. **Reporting & analytics:** standard/custom reports, joined reports, dashboards, scheduled delivery, forecasting (quota, category, rollups), cohort/funnel analysis, embedded BI, data export/warehouse sync.
13. **Customisation:** custom objects/modules, custom fields (incl. formula, rollup, lookup, multi-select), page layouts, record types, validation rules, Lightning/Canvas-style page builders, low-code app builders, custom buttons, scripting, sandboxes, change management/deployments.
14. **Territory management:** territory models and hierarchies, rules-based account assignment, territory forecasts, multiple models.
15. **Documents & e-signature:** document generation, attachments, file libraries, e-sign (Zoho Sign, Salesforce/DocuSign), proposal tracking.
16. **Mobile:** native iOS/Android, offline access, card scanning, geolocation check-in, push notifications, mobile dialer.
17. **Integrations:** marketplace (AppExchange 7,000+ listings versus Zoho Marketplace ~1,000), REST/GraphQL/bulk APIs, webhooks, streaming/CDC events, iPaaS connectors, SDKs, MCP servers.
18. **Data management:** import wizards with mapping, dedup rules, mass update/transfer, backups/export, recycle bin, data enrichment, data quality scores.
19. **Security & compliance:** roles and hierarchy, profiles/permission sets, sharing rules, field-level security, record-level access, audit logs/field history, event monitoring, SSO (SAML/OIDC), MFA, IP restrictions, encryption at rest/BYOK, data residency, retention policies, DSAR tooling.
20. **Global:** multi-currency with dated exchange rates, multi-language UI, multi-timezone, multi-company/business units, fiscal calendars.
21. **Collaboration:** feeds, @mentions, record chat, Slack/Teams integration, shared views.
22. **Gamification:** leaderboards, contests, badges, targets (Zoho Motivator, Freshsales, Bitrix24).
23. **Partner/channel portals:** partner deal registration, lead distribution, MDF, partner and customer communities (Salesforce Experience Cloud, Zoho portals).
24. **BPO/CCaaS-specific (from Genesys/NICE/Five9/Talkdesk):** multi-tenant client programmes, campaigns, dialer pacing, scripting, dispositions, QA scorecards and calibration, WFM forecasting/scheduling/adherence, real-time wallboards, speech analytics, PCI-safe payment capture, recording retention policies.

## 1.5 Feature comparison matrix

Legend: ● native/strong · ◐ partial, higher tier or basic · ○ add-on/separate product · ✗ not offered or requires third party. This matrix synthesises vendor documentation and third-party reviews as understood at time of writing. Verify individual cells before external publication.

**Table A — Enterprise and mid-market suites**

| Capability | Salesforce | Zoho CRM (+Zoho One) | HubSpot | Dynamics 365 | Freshworks | Oracle CX | SAP Sales/Service Cloud | SugarCRM | Creatio |
|---|---|---|---|---|---|---|---|---|---|
| Leads/contacts/accounts | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Multiple pipelines & stage gating | ● (Path, validation) | ● (Blueprint) | ● | ● (BPF) | ● | ● | ● | ● | ● |
| CPQ / quotes | ○ (Revenue Cloud) | ◐ (quotes built in) | ◐ (Commerce Hub) | ◐ | ◐ | ● | ● | ◐ | ◐ |
| Invoicing / orders | ○ | ● (inventory: SO/PO/invoices) | ◐ (payments) | ◐ | ◐ | ◐ | ● | ◐ | ◐ |
| Built-in telephony / dialer | ○ (Service Cloud Voice) | ◐ (Zoho Voice, PhoneBridge) | ◐ (calling) | ○ (Teams/Contact Center) | ● (Freshcaller) | ○ | ○ | ○ | ◐ |
| Predictive dialer | ✗/○ | ✗ | ✗ | ○ | ◐ | ✗ | ✗ | ✗ | ✗ |
| WhatsApp native | ○ (messaging add-on) | ● | ● | ○ | ● | ○ | ○ | ○ | ◐ |
| USSD | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Marketing automation | ○ (Marketing Cloud) | ○ (Campaigns/Marketing Plus) | ● (Marketing Hub) | ○ (Customer Insights) | ◐ | ○ (Eloqua) | ○ (Emarsys) | ○ (Sugar Market) | ● |
| Ticketing / SLAs / KB | ● (Service Cloud) | ○ (Zoho Desk) | ● (Service Hub) | ● (Customer Service) | ● (Freshdesk) | ● | ● | ● (Sugar Serve) | ● |
| Self-service / partner portals | ● (Experience Cloud) | ◐ (portals) | ◐ | ● (Power Pages) | ◐ | ◐ | ◐ | ◐ | ◐ |
| Visual workflow / approvals | ● (Flow) | ● (Workflow, Blueprint, CommandCenter) | ● | ● (Power Automate) | ◐ | ● | ● | ● (SugarBPM) | ● (BPM) |
| Custom objects & low-code | ● | ● (Enterprise+) | ◐ (Enterprise) | ● (Power Apps) | ◐ | ● | ◐ | ● | ● |
| Page/layout builder | ● (Lightning App Builder) | ● (Canvas) | ◐ | ● | ◐ | ◐ | ◐ | ◐ | ● |
| Territory management | ● | ● (Enterprise+) | ◐ | ● | ◐ | ● | ● | ◐ | ◐ |
| AI scoring/forecasting | ● (Einstein) | ● (Zia) | ● (Breeze) | ● (Copilot) | ● (Freddy) | ● | ● (Joule) | ◐ | ● |
| Autonomous AI agents | ● (Agentforce, metered) | ◐ (Zia agents) | ● (Breeze agents, credits) | ● (Copilot agents) | ◐ | ◐ | ◐ | ◐ | ◐ |
| QA scorecards / WFM | ○ | ✗ | ✗ | ○ | ◐ | ✗ | ✗ | ✗ | ✗ |
| BPO multi-client isolation | ◐ (via sharing/orgs) | ✗ | ✗ | ◐ (business units) | ✗ | ◐ | ◐ | ◐ | ◐ |
| Field-level security & audit | ● (Shield for advanced) | ● | ◐ | ● | ◐ | ● | ● | ● | ● |
| African data region | ✗ | ✗ | ✗ | ◐ (Azure SA) | ✗ | ◐ (Johannesburg) | ✗ | ✗ | ✗ |
| NGN/local-currency billing | ✗ | ◐ | ✗ | ◐ (partners) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Nigerian e-invoicing (MBS) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Local payments (Paystack/Flutterwave) | ✗ (AppExchange) | ● (integrations) | ◐ (marketplace) | ✗ | ◐ | ✗ | ✗ | ✗ | ✗ |

**Table B — Sales-first, modern and open-source CRMs**

| Capability | Pipedrive | Monday CRM | Odoo CRM | Bitrix24 | Insightly | Copper | Close | Attio | Twenty | EspoCRM | SuiteCRM | Vtiger |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Pipeline UX | ● | ● | ● | ● | ● | ● | ● | ● | ● | ◐ | ◐ | ● |
| Quotes/invoicing | ○ (Smart Docs) | ◐ | ● (ERP) | ● | ◐ | ✗ | ✗ | ✗ | ✗ | ◐ | ● | ● |
| Built-in calling | ◐ | ✗ | ◐ (VoIP) | ● | ✗ | ✗ | ● (power/predictive) | ✗ | ✗ | ◐ | ◐ | ◐ |
| Sequences | ● | ◐ | ◐ | ◐ | ◐ | ◐ | ● | ● | ◐ | ✗ | ✗ | ◐ |
| WhatsApp | ○ | ○ | ◐ | ● | ✗ | ✗ | ○ | ○ | ✗ | ○ | ○ | ● |
| Helpdesk | ✗ | ◐ (monday service) | ● | ● | ○ | ✗ | ✗ | ✗ | ✗ | ● | ● | ● |
| Custom objects | ◐ | ● | ● | ◐ | ● | ◐ | ◐ | ● | ● (runtime) | ● | ● | ● |
| Workflow automation | ● | ● | ● | ● | ● | ◐ | ◐ | ● | ● | ● | ● | ● |
| AI assistant | ● | ● | ◐ | ● | ◐ | ◐ | ● | ● | ● (MCP) | ✗ | ✗ | ◐ |
| Self-host / source | ✗ | ✗ | ● (community) | ◐ (on-prem) | ✗ | ✗ | ✗ | ✗ | ● (AGPL) | ● | ● | ● |

**Takeaway:** no product scores "●" on the combination of WhatsApp-native + dialer/QA/WFM + BPO multi-client isolation + African data residency + NGN billing + MBS e-invoicing. That combination is Kasuwa's positioning.

## 1.6 Zoho vs Salesforce: the gap behind your dual licensing

| Zoho has / does better (Salesforce lacks, charges extra, or is heavier) | Salesforce has / does better (Zoho lacks or is shallower) |
|---|---|
| **Blueprint** (from Professional): visual state-machine process enforcement with mandatory fields and approvals, with no admin coding required\[38\]\[39\] | **Flow + Flow Orchestration + Apex**: cross-object, multi-step, programmatic automation at enterprise scale |
| **Canvas**: drag-and-drop, no-code redesign of record pages per role/region\[40\] | **Lightning App Builder + Experience Cloud**: full custom apps and customer/partner communities |
| **CommandCenter** (Enterprise): customer-journey orchestration across departments\[39\] | **Omni-Channel routing + Service Cloud Voice**: skills/capacity-based routing across voice and digital |
| **Built-in inventory** (quotes, sales orders, purchase orders, invoices) from Professional | **CPQ/Revenue Cloud**: complex pricing, bundles, approvals and subscriptions (separately licensed) |
| **Native WhatsApp and social tab**; SalesIQ live chat; Zoho Voice/PhoneBridge | **Territory Management** with deep hierarchies (sources cite 10+ layers) and territory forecasting\[41\] |
| **Zia anomaly detection** with little configuration\[41\] | **Einstein/Agentforce**: predictive + generative + autonomous agents (metered), Data Cloud |
| **Price**: Enterprise $40 vs Salesforce Enterprise $175. Aaxonix's 2026 mid-market analysis puts the 3-year TCO difference at $600k–$900k per 100 users in Zoho's favour, based on the older $165 Salesforce Enterprise price | **Ecosystem**: AppExchange 7,000+ listings vs Zoho's ~1,000; larger talent pool\[41\] |
| **Suite economics**: CRM Plus $57 bundles marketing, service, analytics; Zoho One per-employee | **Security depth**: Shield (event monitoring, field audit trail, platform encryption), sandboxes, DevOps Center |
| **Fast setup** (days, not the 8–16 weeks typical for Salesforce with consultants)\[38\] | **Advanced forecasting** and customisable KPI tracking; joined reports; CRM Analytics\[42\] |
| Month-to-month billing, no minimum seats\[39\] | Enterprise governance: multiple sandboxes, change sets, release management |

**Kasuwa must ship on day one:** Blueprint-style stage enforcement, Canvas-style layout builder, built-in quotes/orders/invoices, native WhatsApp and SMS, and cheap seats. From Salesforce, it must add routing-grade omnichannel, a Flow-class automation engine, portals, territory management, field-level security and audit, and credible AI agents. These are the features your BPO is currently paying two vendors for.

## 1.7 Africa-specific requirements (research summary)

### Messaging and channels
- **WhatsApp Business Platform (Cloud API):**
  - Per-message template pricing since 1 July 2025.
  - Non-template messages are free since 1 November 2024.
  - From 1 October 2026: service messages are charged at utility/authentication rates, with 1,000 free service messages per number per month, and utility replies inside the 24-hour window become chargeable.
  - Nigeria is one of nine markets with a higher "authentication-international" rate.
  - Meta introduced local-currency billing for eligible businesses on 1 January 2026.
  - Business-initiated WhatsApp calling is unavailable for Nigeria-registered numbers.
  - **Product implications:** a template library with category management, a cost estimator, per-tenant rate cards, and pass-through billing with margin.
- **SMS:**
  - Nigerian routes split into promotional ("Generic") and transactional ("DND") routes.\[43\]
  - Termii documents that Generic-route messages "will not deliver to numbers on Do-Not-Disturb" and that MTN blocks promotional delivery between 8PM and 8AM WAT.\[43\]
  - Sender IDs must be registered (Africa's Talking raises Nigerian sender IDs free).\[44\]
  - Public per-SMS rates from aggregators cluster around ₦6–₦6.50 excluding VAT (bulksmsnigeria.com "from ₦6.49"; esmsafrica.io "from NGN 6.1").\[45\]\[46\] Official Africa's Talking/Termii NGN SMS rates were not published in a retrievable form.
- **USSD (Africa's Talking, Nigeria):**
  - Shared code: free set-up plus NGN 53,750/month maintenance. The postpaid deposit is NGN 100,000. MTN sessions cost NGN 6.50–7.50 per 20 seconds, and Glo NGN 10.90–12.00 per 120 seconds.\[47\]
  - Dedicated code: NGN 70,000/month + 7.5% VAT maintenance, an NCC application fee of NGN 11,500, and NGN 500,000 + VAT for MTN connection.\[47\]
  - USSD is essential for feature-phone customers: surveys, lead capture, balance/status lookups.
- **NCC DND:**
  - Subscribers text "STOP" to 2442 for full DND. The NCC set an 8am–8pm window for operator-generated SMS and fined non-compliant MNOs ₦5 million plus ₦500,000 per day.\[48\]\[49\]\[50\]
  - The NCC has warned it will arrest and prosecute telemarketers who harvest subscriber numbers without consent.\[51\]\[52\]\[53\]
  - **Product implications:** consent capture, DND-aware routing, quiet-hours enforcement and suppression lists.

### Data protection and residency
- **Nigeria (NDPA 2023 + GAID 2025):**
  - The GAID was issued 20 March 2025, effective 19 September 2025, and supersedes the NDPR 2019.\[19\]\[54\]
  - Data Controllers/Processors of Major Importance (DCPMI) include entities processing data of over 200 individuals in six months, tiered Ultra-High/Extra-High/Ordinary-High. They must register, file annual Compliance Audit Returns, run DPIAs signed by a certified DPO, and meet cross-border rules.\[17\]\[55\]
  - Cross-border transfers need an adequacy decision or an NDPC-approved instrument (BCRs/SCCs require Commission approval). Consent-type bases are valid only when tied to jural or fiduciary obligations.\[18\]
  - Penalties reach ₦10 million or 2% of annual gross revenue.\[56\]
  - Kasuwa is a processor for customer tenants and a controller for its own data, so it needs DPA templates, DPIA support, sub-processor lists, residency choices and DSAR tooling.
- **Kenya (DPA 2019):**
  - Registration is mandatory (from July 2022) unless turnover is below KES 5 million **and** the business has fewer than 10 employees. The exemption does not apply to listed sectors including financial services, telecoms, direct marketing and health. Registration is valid 24 months, with fees from KES 4,000 to 40,000.\[57\]\[58\]
  - Section 48 requires proof of safeguards for transfers.\[59\]
  - General Regulations 2021, reg 26, requires processing in Kenya, or at least one serving copy stored in Kenya, for "strategic interest of the state" data (civil registration, elections, public finance, protected systems, education and health).\[60\]\[61\]
  - Maximum penalty is KES 5 million or 1% of prior-year turnover, **whichever is lower**.\[62\]
- **South Africa (POPIA):**
  - Section 72 restricts transfers to countries without adequate protection.\[63\]
  - Section 69 prohibits electronic direct marketing (including SMS, email and automatic calling) without consent unless the person is an existing customer. Non-customers may be approached once for consent.\[64\]\[65\]
  - Administrative fines may not exceed R10 million. The Information Regulator issued its first direct-marketing enforcement notice in February 2024.\[66\]\[67\]
- **Ghana (Act 843, 2012):** section 27(1) requires data controllers to register with the Data Protection Commission. A revised draft law went to consultation in October 2025.\[68\]\[69\]
- **Cloud options:**
  - AWS: Cape Town region (3 AZs) plus a Lagos Local Zone.\[22\]\[23\]
  - Azure: South Africa North/West, with Azure Stack via Liquid C2 in Nigeria/Kenya.\[70\]
  - GCP: Johannesburg.\[23\]
  - Nigerian colocation: Rack Centre, MainOne/Equinix, Galaxy Backbone and others.
  - The Guardian (Nigeria) reports that Nigeria spends an estimated $850 million (about ₦1.18 trillion) a year on offshore data hosting and cloud services. Lynda Saint-Nwafor, MTN Nigeria's Chief Enterprise Business Officer, confirmed the figure.

### Payments, tax, identity, FX
- **Payments:**
  - Paystack: local cards 1.5% + ₦100 (₦100 waived under ₦2,500), capped at ₦2,000; international 3.9% + ₦100.\[71\]\[72\]\[73\]
  - Flutterwave: around 1.4% local. Sources conflict on whether a ₦2,000 cap applies.\[74\]\[75\]\[76\]
  - Also support Monnify virtual accounts (bank transfer), Interswitch, Remita (government/B2G), M-Pesa and MTN MoMo.
- **E-invoicing (Nigeria):**
  - NRS MBS went live 1 August 2025, with the large-taxpayer deadline extended to 1 November 2025. Medium taxpayers go live from 1 July 2026, and emerging/small from 1 July 2027. Timelines are NRS guidelines and may shift,\[20\] and sources differ on enforcement dates.
  - B2B invoices are cleared in real time. B2C invoices are reported within 24 hours. The exchange uses structured XML/JSON over REST with a digital certificate.\[77\] VAT is 7.5%.
  - Non-compliance penalty under NTAA 2025 s.104: ₦200,000 plus 100% of tax due plus interest. Buyers lose input-VAT recovery on uncleared invoices.\[20\]
- **Identity:** NIN/BVN verification via Smile ID, Youverify, Dojah and VerifyMe, needed for financial-services clients and BPO collections/onboarding campaigns.
- **FX:** multi-currency with dated rates and rate-lock on quotes, because NGN volatility makes quote validity and USD-indexed contracts common. Techpoint's September 2026 conversions imply roughly ₦1,350–₦1,400 per US$.\[14\]

### Language, connectivity, pricing tolerance
- **Languages:** English, Nigerian Pidgin, Hausa, Yoruba, Igbo, French (UEMOA/francophone West Africa), Swahili, Arabic (North Africa), Portuguese (Angola/Mozambique), isiZulu/Afrikaans (South Africa). Right-to-left support is needed for Arabic.
- **Connectivity:** intermittent mobile data, expensive bandwidth and power outages call for a low-bandwidth mode, aggressive caching, an offline-first mobile app, compressed payloads and SMS/USSD fallbacks.
- **Pricing tolerance:** local reviewers flag that $39+/user/month is a "budget killer" for Nigerian SMEs.\[25\] Free tiers (Zoho, HubSpot, Mahala) anchor expectations, so local-currency billing, monthly terms and Paystack card/bank-transfer billing are critical.\[78\]

## 1.8 BPO-specific requirements (research summary)

- **Market context:** Knowledge Executive's 2021 Africa GBS Benchmarking and Market Report, via The Guardian Nigeria, valued Nigeria's BPO/CX sector at an estimated $286.8 million, employing 16,540 workers. GBS World, citing the Genesys Contact Centre Blended AI Survey (2020), says most firms employ 51 to 100 call/contact centre agents. Statista projects US$1.23bn by 2029.\[79\] These figures are dated or projected. Your company, as one of the largest operators, likely sits well above the typical firm size, which makes it an ideal design partner and tenant #1.
- **Required capabilities:**
  - Hierarchical tenancy (BPO tenant → client programmes → campaigns/queues) with strict data isolation.
  - Dialer modes: preview, progressive, predictive; abandon-rate controls.
  - Agent scripting with branching.
  - Disposition codes per client.
  - QA scorecards, calibration and coaching.
  - WFM basics: forecasting, shifts, adherence, breaks/aux codes.
  - Real-time wallboards.
  - Per-client SLA reporting and client-facing portals.
  - Recording retention per client contract.
  - PCI DSS v4.0.1 compliance, mandatory since 31 March 2025. Pause-and-resume recording is now considered inadequate where card digits are spoken, so implement DTMF masking/secure payment capture that keeps PAN off the agent leg and out of recordings.\[80\]\[81\]\[82\]

---

# PART 2 — PRODUCT REQUIREMENTS DOCUMENT (PRD)

## 2.1 Document control
- **Product:** Kasuwa (working name; Hausa for "marketplace"), an Africa-first CRM and customer-engagement cloud
- **Owner:** Chief Product Officer · **Status:** v1.0 founding draft · **Date:** September 2026
- **Design partner / tenant #1:** the sponsoring BPO (internal migration off Zoho + Salesforce)

## 2.2 Vision and positioning
**Vision:** every African business, from a Kano distributor to a 3,000-seat Lagos contact centre, runs customer relationships on one platform that speaks its channels, currencies, languages and laws.

**Positioning statement:** For African enterprises, BPOs and growth SMEs frustrated by paying dollar prices for Western CRMs that ignore WhatsApp, USSD, DND, Naira invoicing and local data law, Kasuwa is the CRM and contact-centre cloud built in Africa. It unifies sales, service, marketing and BPO operations with native WhatsApp, telephony, local payments and compliance, at local-currency prices. Unlike Salesforce (deep but expensive and add-on heavy) or Zoho (broad but not contact-centre-grade or BPO-aware), Kasuwa ships the African operating model out of the box.

## 2.3 Problem statement
1. **Feature fragmentation:** the sponsor pays for Zoho CRM and Salesforce because Blueprint/Canvas/inventory/WhatsApp live in one and routing/portals/Flow/territory/AI in the other. This means double licences, double integration and split data.
2. **Western-market assumptions:** incumbents assume email-first B2B, card payments, stable connectivity, US/EU data regions and no telecom DND regime. None supports USSD, NRS MBS e-invoicing, Paystack/MoMo-native billing, or Nigerian identity checks natively.
3. **Cost:** a BPO agent seat across Salesforce Service Cloud Enterprise and a CCaaS seat costs about $290/month in USD at list, before telephony and AI metering. SMEs balk at $39+/user.
4. **BPO blind spot:** mainstream CRMs do not model "one agent, many client programmes, strict isolation, per-client SLAs, client portals."

## 2.4 Goals and non-goals
**Goals (24 months):**
- G1: Retire the sponsor's Zoho and Salesforce licences within 12 months of MVP.
- G2: Reach 150 paying tenants and 10,000 paid seats across ≥3 countries by month 24.
- G3: Achieve cost per BPO agent seat (CRM + contact centre) ≥40% below the incumbent stack.
- G4: Be demonstrably NDPA/GAID, POPIA and Kenya DPA compliant and PCI DSS v4.0.1-aligned for voice payments.

**Non-goals (first 24 months):** building a full ERP or accounting suite (integrate Zoho Books, Sage, QuickBooks, Odoo instead); building a consumer messaging app; becoming a licensed telecoms carrier (partner with licensed SIP/CPaaS providers); on-premise installs for SMEs (offer only dedicated-cloud or "sovereign cell" for enterprise/government); matching Salesforce's full Industry Clouds.

## 2.5 Target customers and personas

| Segment | Profile | Primary modules |
|---|---|---|
| BPOs / contact centres | 50–5,000 agents, multi-client | Contact centre, dialer, QA, WFM, client portal, ticketing |
| Financial services & fintech | Banks, MFBs, lenders, insurers | KYC, collections campaigns, service, compliance, audit |
| Telecoms, utilities, logistics | High-volume B2C service | Omnichannel inbox, ticketing, USSD, self-service |
| B2B mid-market | Distributors, FMCG, real estate, education | Sales pipeline, CPQ, field sales mobile, e-invoicing |
| SMEs | 1–50 staff, WhatsApp-run | Starter CRM, WhatsApp inbox, payment links, mobile |

| Persona | Needs | Key success signal |
|---|---|---|
| BPO agent (Chidinma, 24, Lagos) | One screen for calls, WhatsApp, script, disposition; works on shaky bandwidth | Handles more contacts per hour with fewer clicks |
| Supervisor (Musa) | Live wallboard, barge/whisper, adherence, queue alerts | SLA met per client, fewer escalations |
| QA analyst (Ngozi) | Random/targeted sampling, scorecards, calibration, coaching | Evaluations per day, calibration variance |
| Sales rep (Tunde) | Pipeline, WhatsApp follow-ups, quotes in NGN, mobile offline | Time-to-quote, win rate |
| Sales manager (Aisha) | Forecast, coaching, territory, approvals | Forecast accuracy |
| Marketer (Kwame, Accra) | Segments, WhatsApp/SMS/email journeys, consent | Cost per lead, opt-in compliance |
| Support agent (Wanjiru, Nairobi) | Tickets, SLAs, KB, AI suggestions | First contact resolution |
| Admin (Emeka) | No-code config, permissions, audit, integrations | Time to deploy change |
| C-level (CEO/CFO) | Revenue, cost-to-serve, client profitability | Dashboard adoption |
| BPO client stakeholder (bank CX head) | Real-time SLA, recordings, QA results for their programme only | Portal logins, report downloads |
| SME owner (Mama Ada, Onitsha) | Simple WhatsApp CRM, payment links, cheap | Weekly active use, paid conversion |

## 2.6 Competitive positioning
- **Versus Salesforce:** comparable core platform concepts (metadata objects, flows, FLS, portals) at roughly a quarter of the price. Omnichannel and telephony are included, not add-ons. AI is metered transparently in local currency, and African residency is available.
- **Versus Zoho:** contact-centre-grade voice/dialer/QA/WFM, BPO tenancy, stronger enterprise security, Nigerian compliance (MBS, DND, NDPA), and local support/implementation.
- **Versus HubSpot:** cheaper seats and no onboarding fees; built for voice and WhatsApp-heavy service, not inbound-marketing-first.
- **Versus CCaaS (Genesys/NICE/Five9/Talkdesk):** CRM data model included, lower minimums (Genesys's $2,000/month minimum excludes smaller BPOs), and African carrier integrations.
- **Versus local CRMs:** enterprise-grade security, multi-tenancy, contact centre, marketplace and AI.

## 2.7 Module list and prioritised requirements

Priority: **P0** = MVP (must), **P1** = v1 (should), **P2** = v2 (could).

### M1. Platform & tenancy
- P0: Multi-tenant org model. Org contains Business Units, which contain Client Programmes (BPO) and Teams. Programme-level data partitioning is enforced at the database (RLS) and API layers.
- P0: Tenant provisioning, custom subdomain, region selection (ZA primary, NG local cell), trial and plan limits.
- P0: White-label: logo, colours, custom domain, email sender domain, portal branding.
- P1: Sandboxes (config copy, masked data), config deployment between environments.
- P2: Reseller/partner tenancy (partners manage sub-tenants and billing).

### M2. Security & identity
- P0: Email/password with MFA (TOTP, SMS OTP fallback, WebAuthn), SSO via SAML 2.0 and OIDC (Google, Microsoft Entra), session policies, IP allowlists.
- P0: RBAC: roles and hierarchy, profiles, permission sets, object CRUD, field-level security, record sharing rules, programme scoping.
- P0: Immutable audit log (logins, config changes, record views of sensitive fields, exports, recording playback).
- P1: SCIM provisioning, delegated admin, data masking for non-production, BYOK encryption for enterprise.
- P2: Event monitoring/UEBA-style anomaly alerts (mass export, off-hours access).

### M3. Core CRM records
- P0: Leads, contacts, accounts, deals, products, activities, notes, attachments. Account hierarchies. 360° timeline (calls, WhatsApp, SMS, email, tickets, payments).
- P0: Lead capture: web forms, WhatsApp click-to-chat, missed-call capture, CSV import, API.
- P0: Assignment rules (round-robin, load-balanced, territory, language skill), dedup rules and merge.
- P0: Nigerian/African fields: phone normalisation (E.164, network detection MTN/Airtel/Glo/9mobile/T2), state/LGA address model, NIN/BVN (tokenised), preferred channel and language.
- P1: Enrichment (company registry/CAC lookups where available), relationship maps, households.
- P2: Map views, route planning for field sales.

### M4. Sales pipeline, forecasting, territories
- P0: Multiple pipelines, Kanban, stage probabilities, **stage gating (Blueprint-equivalent)** with required fields, checklists and approvals per transition, deal rotting alerts.
- P1: Forecasting (categories, quotas, rollups by hierarchy/territory, AI forecast), territory models with rules.
- P2: Revenue splits, guided selling playbooks, deal rooms.

### M5. Products, quotes, CPQ, invoicing & payments
- P0: Product catalogue, price books per currency, quotes with PDF templates, discount approvals, payment links (Paystack, Flutterwave) with webhook reconciliation.
- P1: Sales orders, invoices, VAT 7.5% and multi-tax rules, **NRS MBS e-invoicing clearance** (B2B real-time, B2C 24-hour reporting) via accredited provider or direct API, QR code on invoice, FX rate-lock on quotes, recurring billing (Paystack subscriptions), M-Pesa/MTN MoMo collection.
- P2: Full CPQ (bundles, configuration rules), Remita for B2G, e-signature native.

### M6. Activities, calendar, tasks
- P0: Tasks, calls, meetings, reminders, Google/Microsoft calendar sync, booking pages with WhatsApp confirmation.
- P1: Field check-in with geolocation and offline capture; cadences.

### M7. Email & sequences
- P0: Gmail/Microsoft 365 two-way sync, templates, tracking, shared inboxes.
- P1: Multichannel sequences (email → WhatsApp template → call task → SMS), throttling, reply detection, quiet hours.

### M8. Omnichannel inbox
- P0: WhatsApp Cloud API (multi-number, template management and category tracking, media, interactive buttons/lists, 24-hour window indicator, cost estimator). SMS two-way (Africa's Talking, Termii, Infobip, Twilio) with sender IDs, DND/transactional route selection. Email. Web chat widget. Unified threading on contact.
- P0: Routing: queues, skills (language, product, client programme), capacity, SLAs, canned responses, internal notes, transfer.
- P1: Facebook Messenger, Instagram DM, Telegram, TikTok (where APIs permit), USSD session builder (menus → CRM actions), chatbot builder (no-code + Claude-powered).
- P2: X/Twitter DMs, Google Business Messages successors, RCS.

### M9. Telephony & contact centre
- P0: WebRTC softphone in browser. Inbound IVR builder (visual), queues, ACD, click-to-call, call recording (dual-channel), voicemail, transfers/conference, dispositions, wrap-up timers.
- P0: Dialer: preview and progressive modes, DND/consent suppression, calling-hours enforcement per country, retry rules, local caller ID.
- P0: PCI: DTMF masking/secure pay IVR via integration; automatic recording suppression during payment capture.
- P1: Predictive dialer with abandon-rate cap, AMD (answering machine detection), callback scheduling, whisper/barge/monitor, live transcription.
- P2: Speech analytics, voice bots, WhatsApp calling where permitted.

### M10. Agent scripting & disposition
- P0: Visual script builder with branching, variables, embedded forms that write to CRM fields, per-programme disposition trees, mandatory compliance statements.
- P1: Script A/B versions, AI-suggested next line.

### M11. Supervisor, QA & WFM
- P0: Real-time wallboard (per programme: calls waiting, ASA, AHT, SLA %, abandon %, agents by state).
- P1: QA scorecards (weighted sections, auto-fail items), random/targeted sampling, calibration sessions, coaching tasks, agent disputes. AI auto-scoring of 100% of interactions.
- P1: WFM-lite: shift schedules, aux/break codes, adherence, intraday alerts, Erlang C staffing calculator.
- P2: Forecasting from history, schedule optimisation, shift bidding, integration to payroll/HR.

### M12. Ticketing, knowledge base & self-service
- P0: Tickets with status, priority, SLA policies (business hours with Nigerian public holidays), escalations, macros, CSAT via WhatsApp/SMS.
- P1: Knowledge base (multilingual, versioned, approval), customer portal, community Q&A, AI answer bot with RAG.
- P2: Field service (work orders, technicians).

### M13. Marketing
- P1: Segments (rule builder), WhatsApp/SMS/email campaigns, journeys, forms, landing pages, UTM attribution, consent and preference centre, lead scoring rules.
- P2: A/B tests, events, social publishing, web tracking.

### M14. Workflow & automation
- P0: Record-triggered and scheduled workflows (conditions → actions: update, create, notify, send WhatsApp/SMS/email, webhook, assign), approval processes (multi-step).
- P1: Visual flow builder with branches, loops, waits and sub-flows; custom code actions (sandboxed TypeScript); cross-module orchestration (CommandCenter-equivalent).
- P2: Process mining and flow analytics.

### M15. Customisation & app builder
- P0: Custom fields (text, number, currency, date, picklist, multi-select, lookup, formula, rollup, phone, NIN), custom objects, page layout builder (Canvas-equivalent), validation rules, record types.
- P1: Low-code app builder (custom tabs, list/record page components), custom buttons, related lists, per-role layouts.
- P2: Extension SDK (TypeScript apps in UI and server, like Twenty's apps framework), marketplace publishing.

### M16. Reporting, dashboards & analytics
- P0: Report builder (tabular, summary, matrix), dashboards, scheduled email/WhatsApp PDF delivery, per-programme SLA reports.
- P1: Joined reports, custom metrics, cohort/funnel analysis, data export to warehouse (BigQuery/Snowflake/Postgres), natural-language queries (Claude).
- P2: Embedded analytics for client portals, predictive dashboards.

### M17. AI layer ("Kasuwa Intelligence")
- P0: Conversation and call summaries, WhatsApp/email reply drafting (tone, language incl. Pidgin), record summaries.
- P1: Lead/deal scoring, next-best-action, real-time agent assist (knowledge surfacing, compliance prompts), auto-QA, natural-language report builder.
- P2: Autonomous AI agents (service resolution on WhatsApp, SDR follow-ups, collections reminders) with human-in-the-loop policies and per-resolution pricing.

### M18. Client portal (BPO)
- P0: Client stakeholder login scoped to their programme(s): live SLA dashboard, reports, ticket view.
- P1: Recording playback (permissioned, watermarked, audit-logged), QA results, invoice/usage statements, approvals of scripts.

### M19. Mobile
- P0: PWA with offline read of recent records and queued writes; low-bandwidth mode.
- P1: React Native (Expo) apps: offline sync, mobile dialer/softphone, WhatsApp inbox, check-in, card scan, push.

### M20. Integrations & marketplace
- P0: Public REST API, webhooks, API keys/OAuth apps, Zoho and Salesforce importers (objects, fields, records, attachments), Google/Microsoft, Paystack/Flutterwave.
- P1: GraphQL API, Zapier/Make connectors, Smile ID/Youverify/Dojah/VerifyMe, Slack/Teams, Zoho Books/QuickBooks/Sage, M-Pesa/MTN MoMo, MCP server for AI assistants.
- P2: Public marketplace with revenue share, partner certification.

### M21. Data management
- P0: Import wizard with mapping templates and dedupe, export (subject to permission and audit), mass update, recycle bin (30 days).
- P1: Data quality scores, scheduled backups export, DSAR (access/erase) workflows.

### M22. Collaboration & gamification
- P1: Record feed, @mentions, team chat on records, Slack/Teams notifications.
- P2: Leaderboards, targets, badges, contests (important for BPO floors and field sales).

### M23. Billing & subscription (Kasuwa's own)
- P0: Plans, seats, usage meters (WhatsApp, SMS, minutes, AI credits, storage), NGN/GHS/KES/ZAR/USD billing, Paystack/Flutterwave card and bank transfer, VAT invoices through MBS for Nigerian customers, dunning.

## 2.8 Key user stories and acceptance criteria

**US-1 BPO agent handles an inbound call for a specific client programme**
*As an agent assigned to Programme A (Bank X), I want the call screen to show the caller's record, the programme script and dispositions so I can resolve the call without switching tools.*
- AC1: On ring, the softphone shows a screen-pop within ≤1.5s (p95) with matched contact (by E.164), last 5 interactions, open tickets, and the Programme A script.
- AC2: The agent cannot search, view or open records from Programme B, even via global search or URL manipulation (verified by automated isolation tests).
- AC3: Call ends → wrap-up timer starts (configurable) → disposition is mandatory → record updated → wrap-up logged in adherence.
- AC4: If the customer initiates card payment, the agent triggers secure capture; the recording shows a redacted segment; PAN never appears in audio, transcript or logs.

**US-2 Supervisor monitors SLA per client**
- AC1: Wallboard refreshes ≤3s latency; shows SLA % (e.g., 80/20), ASA, AHT, abandon % per programme; thresholds turn amber/red.
- AC2: Supervisor can listen, whisper or barge on any active call in their programmes; every action is audit-logged.

**US-3 Sales rep sends a quote in Naira and collects payment**
- AC1: Quote uses NGN price book; FX-indexed items show locked rate and expiry date.
- AC2: Discounts above threshold route to manager approval (WhatsApp and in-app notification).
- AC3: Quote PDF and a Paystack payment link are sent on WhatsApp via approved utility template; payment webhook marks invoice paid and moves the deal to "Won – Paid".
- AC4: For MBS-scoped tenants, the invoice is cleared with NRS before issue; the IRN/QR is printed; failures queue with retry and alert.

**US-4 Marketer runs a compliant WhatsApp + SMS campaign**
- AC1: Segment builder excludes contacts without marketing consent and (for SMS promotional route) DND-registered numbers.
- AC2: Cost estimate shows per-message Meta rate by recipient country and total in tenant currency before send.
- AC3: Sends outside 8am–8pm recipient local time are blocked for promotional content (configurable per country).
- AC4: Opt-out keywords (STOP, "Comot", localised equivalents) update consent within 60s.

**US-5 Admin replicates a Zoho Blueprint process**
- AC1: Admin builds stages and transitions visually; each transition can require fields, attachments, checklist items, approvals and time limits.
- AC2: Users only see valid next transitions; API enforces the same rules.
- AC3: Zoho importer maps Blueprint states to Kasuwa stages with a diff report.

**US-6 QA analyst evaluates interactions**
- AC1: Sampling rules select N% of calls/chats per agent per week, stratified by disposition.
- AC2: Scorecard supports weighted sections, auto-fail, comments at timestamp; agent can acknowledge or dispute within 72h.
- AC3: AI pre-scores; analyst accepts/overrides; variance tracked for calibration.

**US-7 Client stakeholder views their programme**
- AC1: Portal login via SSO or MFA; sees only assigned programme data.
- AC2: Recording playback is permission-gated, watermarked with viewer identity, and audit-logged; downloads disabled by default.

**US-8 SME owner on poor connectivity**
- AC1: In low-bandwidth mode, the home screen loads <150KB after first visit; images deferred; lists paginate at 25.
- AC2: Offline edits queue and sync with conflict resolution (field-level last-writer-wins, with a conflict prompt for key fields).

## 2.9 Africa-first requirements (cross-cutting)
- Channels: WhatsApp-first composer everywhere a message can be sent; SMS fallback; USSD for feature phones; missed-call ("flash") lead capture.
- Compliance: NDPA/GAID consent records with lawful basis; DPIA templates; DCPMI registration helper for tenants; DND and quiet hours; POPIA s.69 consent mode for South Africa; Kenya localisation option.
- Money: NGN/GHS/KES/ZAR/XOF/XAF/EGP/USD; dated FX rates; rate-lock on quotes; kobo-precision integer money; Paystack/Flutterwave/Monnify/MoMo/M-Pesa.
- Tax: VAT 7.5% (Nigeria) and country tax profiles; MBS e-invoicing; WHT fields on invoices.
- Language: UI in English, French, Pidgin, Hausa, Yoruba, Igbo, Swahili, Portuguese, Arabic (RTL). AI drafting in these languages with human review. Name handling (multiple given names, no forced "last name").
- Calendars: public holiday calendars per country (including movable Islamic holidays), business hours per programme.
- Connectivity: low-bandwidth mode, offline mobile, resumable uploads, image compression, SMS-based OTP fallback.

## 2.10 BPO requirements (cross-cutting)
- Hierarchy: BPO tenant → Client → Programme → Campaign/Queue → Team → Agent; agents can be multi-skilled across programmes but see only the active programme's data per interaction.
- Per-programme configuration: scripts, dispositions, SLAs, business hours, retention periods, recording rules, QA forms, branding for client portal, billing rates (per seat, per minute, per contact, per outcome).
- Client billing: usage statements per programme (talk minutes, contacts handled, WhatsApp messages), exportable to the BPO's invoicing.
- Retention: recordings/transcripts per programme policy (e.g., 90 days–7 years), legal hold, automatic purge with certificate.
- PCI: secure payment capture, no PAN in recordings, transcripts, screens or logs; segmented CDE handled by certified partner.

## 2.11 Multi-tenancy and white-label requirements
- Tiered isolation: **Pooled** (shared DB, RLS) for SME/mid-market; **Bridge** (dedicated schema or database within a shared cluster) for regulated tenants; **Silo** (dedicated cell: DB, workers, storage, optionally in Nigeria) for banks/government/large BPOs.
- Noisy-neighbour controls: per-tenant rate limits, queue quotas, query timeouts.
- White-label: full theming, custom domain with automatic TLS, custom email/SMS sender, hide Kasuwa branding (Enterprise), branded mobile app build (P2).

## 2.12 Security & compliance requirements
- Encryption: TLS 1.2+ in transit; AES-256 at rest; field-level encryption for NIN/BVN/sensitive fields with per-tenant keys (KMS); BYOK for Silo.
- Certifications roadmap: ISO/IEC 27001 (by month 18), SOC 2 Type II (month 24), PCI DSS scope minimised via certified payment partner; NDPC registration as DCPMI; annual CAR filing.
- Privacy tooling: consent ledger, purpose tags, retention policies, DSAR workflow, sub-processor register, DPA templates, cross-border transfer register (country, mechanism, NDPC approval reference).
- Secure SDLC: SAST/DAST, dependency scanning, secrets scanning, pen test before GA and annually, bug bounty (P2).

## 2.13 Non-functional requirements

| Area | Requirement |
|---|---|
| Availability | 99.9% monthly (Pooled), 99.95% (Silo); telephony media path 99.95% |
| Performance | p95 API <300ms for record reads; list views <800ms at 1M records/tenant; screen-pop ≤1.5s; wallboard ≤3s |
| Scalability | 50,000 concurrent users; 5,000 concurrent calls per region; 20M messages/day; tenants to 50M records |
| RPO/RTO | RPO ≤5 min (PITR), RTO ≤1h (Pooled), ≤4h full region failover |
| Low bandwidth | Core agent workspace usable at 256 kbps with 300ms latency; initial JS <300KB gzipped for critical path; Opus codec for WebRTC with FEC |
| Offline | Mobile: last 30 days of assigned records offline; queued writes; conflict resolution |
| Localisation | All strings externalised (ICU); locale-aware number/currency/date; RTL support |
| Accessibility | WCAG 2.2 AA |
| Data residency | Region per tenant (ZA default; NG cell; KE option); backups remain in-region |
| Observability | Tenant-tagged traces/metrics/logs; per-tenant health dashboards |

## 2.14 Pricing & packaging strategy
Principles: price in local currency; monthly and annual; per-seat for humans, usage for messages/minutes/AI; no onboarding fees for self-serve; pass-through channel costs with transparent margin.

| Plan | Target | Indicative price (NGN/user/month, annual) | Includes |
|---|---|---|---|
| Free | Micro-SMEs | ₦0 (up to 3 users) | Contacts, 1 pipeline, WhatsApp inbox (1 number), mobile |
| Starter | SMEs | ₦7,500–₦10,000 | Multiple pipelines, quotes, payment links, basic workflows, 2 WhatsApp numbers |
| Growth | Mid-market | ₦20,000–₦25,000 | Stage gating, custom objects, sequences, ticketing, reports, API |
| Business | Larger teams | ₦40,000–₦45,000 | Territories, approvals, forecasting, SSO, sandboxes, AI assist, e-invoicing |
| Enterprise | Regulated/large | Custom (from ~₦65,000) | Silo/NG residency, BYOK, advanced audit, SLA 99.95%, dedicated CSM |
| Contact Centre add-on | BPOs/support | ₦30,000–₦55,000 per agent | Softphone, dialer (predictive at higher tier), wallboards, QA, WFM-lite, client portal |

- Usage: WhatsApp at Meta rate + 10–15% margin; SMS/minutes at carrier cost + margin; AI credits (e.g., ₦5,000 per 1,000 credits), with fair-use included per plan.
- FX note: at the roughly ₦1,370/US$ implied by September 2026 conversions, Growth at ₦22,000 ≈ $16. That is below Zoho Professional's monthly price and a small fraction of Salesforce Enterprise's $175. Review prices quarterly against FX and CPI, and index Enterprise contracts with caps.
- Regional price lists in GHS, KES, ZAR, XOF (not simple conversion; purchasing-power adjusted).
- Launch offers: "Switch from Zoho/Salesforce" migration credits; BPO pilot pricing per programme.

## 2.15 Go-to-market notes
- **Phase A (months 0–9):** the sponsor BPO as tenant #1, then its client base: banks, telcos and fintechs whose programmes it runs can be offered the client portal and then full CRM.
- **Phase B:** Nigerian mid-market via implementation partners (Zoho/Salesforce consultancies), with a Zoho/Salesforce migration toolkit as the wedge. Also the fintech and lending ecosystem (collections + KYC).
- **Phase C:** Ghana, Kenya and South Africa via local partners, with francophone West Africa (Côte d'Ivoire, Senegal) after French localisation and XOF billing.
- **Channels:** direct enterprise sales, partner programme (20–30% margin), self-serve PLG for SMEs with WhatsApp-based onboarding, and CPaaS partner co-selling (Africa's Talking, Termii, Infobip).
- **Proof points:** published NDPA compliance pack, PCI-aligned voice payments, and a case study of the sponsor's licence savings.

## 2.16 Success metrics / KPIs
- Business: ARR, paid seats, net revenue retention (target ≥110%), gross margin (≥70% blended after channel pass-through), CAC payback (<15 months).
- Adoption: WAU/MAU ≥60%; % of agent interactions in Kasuwa (target 100% for tenant #1 by month 12).
- Operational (BPO): AHT change, SLA attainment, QA coverage (from sample to 100% AI-scored), agent occupancy.
- Product quality: p95 latency, uptime, sev-1 incidents/quarter, isolation test pass rate (100%).
- Compliance: DSARs closed within statutory time, zero reportable breaches, audit findings closed.

## 2.17 Risks and assumptions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope explosion (building "Salesforce + Genesys") | High | High | Strict P0 list; integrate (not build) ERP, e-sign, CPaaS; tenant #1 drives priorities |
| Meta pricing/policy changes (e.g., Oct 2026 service charges) | High | Medium | Data-driven rate cards; multi-BSP abstraction; pass-through billing |
| Telecom licensing for voice | Medium | High | Use licensed SIP/CPaaS partners; legal review of NCC licensing needs before launch |
| Data localisation law tightening | Medium | High | Region-pluggable cells incl. Lagos colocation |
| PCI scope creep | Medium | High | Certified DTMF-masking partner; keep PAN out of Kasuwa entirely |
| FX volatility erodes USD-cost margins (cloud, AI) | High | Medium | Price reviews; cost-aware AI routing; local hosting for heavy workloads |
| AI quality in Yoruba/Hausa/Igbo/Pidgin | Medium | Medium | Human-in-the-loop; language-specific eval sets; opt-in per tenant |
| Claude Code-generated code quality/security | Medium | High | TDD, mandatory review, SAST, architecture decision records, strong CLAUDE.md |
| Incumbent response (discounts, Zoho local push) | Medium | Medium | Differentiate on BPO/contact centre + compliance, not price alone |

Assumptions: the sponsor provides domain SMEs, a pilot floor of 100–300 agents, and access to current Zoho/Salesforce configs; CPaaS and BSP partners provide Nigerian numbers and routes; budget supports ~12–18 FTE for 18 months.

## 2.18 Phased release roadmap

| Release | Timing | Scope |
|---|---|---|
| **MVP (internal GA)** | Month 7 | M1–M3, M4 (pipelines + gating), M5 (quotes + payment links), M6, M7 (sync), M8 (WhatsApp/SMS/email/web chat), M9 (softphone, IVR, preview/progressive), M10, M11 (wallboard), M12 (tickets + SLA), M14 (workflows + approvals), M15 (fields/objects/layouts), M16 (reports), M17 (summaries/drafts), M18 (portal basics), M19 (PWA), M20 (API, importers), M21, M23 |
| **v1 (commercial GA)** | Month 12 | Predictive dialer, QA, WFM-lite, KB + portal, marketing, visual flow builder, forecasting/territories, MBS e-invoicing, GraphQL, React Native apps, AI assist/scoring/auto-QA, Kenya/Ghana localisation |
| **v2** | Months 18–24 | AI agents, low-code app builder + SDK, marketplace, partner portals, speech analytics, WFM forecasting, gamification, francophone launch, Silo cells in Nigeria/Kenya, SOC 2 |

---

# PART 3 — TECHNICAL IMPLEMENTATION PLAN

## 3.1 Architecture decision: modular monolith first

**Decision:** a TypeScript **modular monolith** with a small number of separately deployed runtime processes (API, workers, realtime gateway, media/telephony, AI gateway). Microservices are not used initially.

**Rationale:**
1. A team of about 12 with Claude Code moves fastest in one repo, one language and one deployable, and Claude Code performs best when it can see types end-to-end.
2. CRM domains are highly relational (records, permissions, workflows touch everything). Premature service boundaries create distributed transactions and permission-check duplication.
3. Boundaries are enforced in code (Nx module boundaries, lint rules, no cross-module DB access), so modules can later be extracted.
4. Telephony media and real-time messaging are genuinely different workloads and **are** separate from day one.

**Reference:** Twenty (open-source CRM) uses NestJS + PostgreSQL + Redis/BullMQ in an Nx monorepo with a metadata-driven, runtime-generated API. This validates the stack. Kasuwa diverges on tenancy (pooled RLS instead of schema-per-workspace) to scale to thousands of SME tenants.

## 3.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language for Claude Code, shared types |
| Web front-end | Next.js (App Router) + React, TanStack Query, Tailwind + Radix/shadcn-based design system | SSR for portals, fast SPA workspace, Claude Design output maps cleanly to React/Tailwind |
| API | NestJS (modular), REST (OpenAPI) + GraphQL (P1), tRPC internal optional | Structure, DI, guards for RBAC |
| ORM / DB access | Drizzle or Kysely (SQL-first) + raw SQL for metadata engine | Predictable SQL, RLS-friendly |
| Primary DB | PostgreSQL 16 (Amazon RDS/Aurora or Azure Flexible Server), RLS, JSONB, partitioning | Relational core + flexible custom fields |
| Cache / queues | Redis (ElastiCache) + BullMQ; later Kafka/Redpanda for event streaming | Jobs, rate limits, pub/sub |
| Event bus | Transactional outbox → Redis Streams (MVP) → Kafka (v1+) | Reliable workflow triggers, webhooks, analytics |
| Search | OpenSearch (per-tenant index aliases, filtered by programme) | Global search, dedup candidate matching |
| Object storage | S3 (Cape Town) / MinIO in local cells | Attachments, recordings (SSE-KMS) |
| Realtime | WebSocket gateway (NestJS + Socket.IO or uWebSockets) with Redis adapter | Inbox, wallboards, presence |
| Telephony | FreeSWITCH cluster (media, IVR, recording, dialer), Kamailio SIP proxy, rtpengine; SIP trunks from licensed Nigerian/Kenyan carriers; Twilio/Africa's Talking voice as alternates; WebRTC via SIP.js | Control of dialer logic, cost, local interconnect |
| Messaging | WhatsApp Cloud API (direct Meta or BSP), SMS/USSD via Africa's Talking, Termii, Infobip, Twilio behind a provider abstraction | Redundancy, least-cost routing |
| Analytics | ClickHouse (events, interactions, call metrics) + materialised Postgres views for operational reports | Fast wallboards and SLA aggregates |
| AI | Claude API (Anthropic) through an internal AI gateway; pgvector (MVP) → OpenSearch k-NN for RAG | Summaries, drafting, agent assist, agents |
| Auth | Own auth service in the monolith (argon2id, WebAuthn, TOTP) + SAML/OIDC (e.g., BoxyHQ/Ory Polis-style SAML bridge) | Enterprise SSO |
| Mobile | Expo (React Native) + WatermelonDB/SQLite for offline; PWA first | Code sharing, offline sync |
| Infra | Kubernetes (EKS/AKS) with Helm/Argo CD; Terraform | Portable across AWS/Azure/local cells |
| Observability | OpenTelemetry → Grafana (Tempo/Loki/Mimir) or Datadog; Sentry | Tenant-tagged tracing |

## 3.3 Tenancy and isolation model

- **Hierarchy:** `tenant` → `business_unit` → `programme` (BPO client programme; for non-BPO tenants a default programme) → `team` → `user`.
- **Every row** carries `tenant_id` and (for programme-scoped objects) `programme_id`.
- **Postgres RLS:** each request opens a transaction and sets `SET LOCAL app.tenant_id`, `app.programme_ids`, `app.user_id`. Policies enforce `tenant_id = current_setting('app.tenant_id')::uuid AND (programme_id IS NULL OR programme_id = ANY(current_setting('app.programme_ids')::uuid[]))`. The application DB role has no BYPASSRLS; migrations use a separate role.
- **Defence in depth:** NestJS guards check object/field permissions. The repository layer injects tenant filters. OpenSearch queries always include tenant/programme filters via a mandatory query wrapper. S3 keys are prefixed `tenant/{id}/programme/{id}/` with IAM conditions for Silo tenants.
- **Isolation tests:** a dedicated CI suite creates two tenants and two programmes and attempts cross-access through every API route (auto-generated from OpenAPI), search, exports, webhooks and file URLs. Build fails on any leak.
- **Cells:** a "cell" is a full deployment (API, workers, DB, Redis, search, storage). Pooled tenants live in cell `za-1`. Silo tenants get their own cell, which can be in a Lagos data centre (Rack Centre/MainOne) or the AWS Lagos Local Zone for latency-sensitive compute. A global control plane (tenant directory, billing, auth routing) maps tenants to cells.

## 3.4 Data model

### Core entities (simplified)
```
tenant(id, name, region_cell, plan, currency_default, locale_default, status)
business_unit(id, tenant_id, name)
programme(id, tenant_id, bu_id, client_name, sla_policy_id, retention_policy_id, branding_json)
user(id, tenant_id, email, phone_e164, locale, status, mfa_json)
role(id, tenant_id, name, parent_role_id)       -- hierarchy
permission_set(id, tenant_id, name, object_perms_json, field_perms_json, system_perms_json)
user_programme(user_id, programme_id, skills[])  -- BPO assignment
account(id, tenant_id, programme_id, name, parent_account_id, industry, custom jsonb, owner_id)
contact(id, tenant_id, programme_id, account_id, given_names, family_name, display_name, phones jsonb, emails jsonb, preferred_channel, preferred_language, consent_state jsonb, nin_token, bvn_token, custom jsonb)
lead(id, ..., source, status, score, custom jsonb)
deal(id, ..., pipeline_id, stage_id, amount_minor bigint, currency, fx_rate_locked numeric, close_date, custom jsonb)
pipeline(id, tenant_id, object, name) / stage(id, pipeline_id, name, probability, order)
stage_transition(id, pipeline_id, from_stage, to_stage, requirements jsonb, approval_process_id)
product / price_book / price_book_entry(currency, unit_price_minor)
quote / quote_line / invoice / invoice_line / payment(provider, provider_ref, status)
einvoice_submission(invoice_id, irn, qr_payload, status, provider_response jsonb)
activity(id, type[task|call|meeting|note], related_type, related_id, due_at, ...)
conversation(id, tenant_id, programme_id, contact_id, channel, channel_account_id, status, queue_id, assignee_id, window_expires_at)
message(id, conversation_id, direction, type, body, template_id, provider_msg_id, cost_minor, currency, status)
call(id, tenant_id, programme_id, contact_id, direction, campaign_id, queue_id, agent_id, started_at, answered_at, ended_at, disposition_id, recording_id, pci_redacted bool)
recording(id, storage_key, duration, channels, retention_until, legal_hold)
campaign(id, programme_id, type[dialer|whatsapp|sms|email], mode[preview|progressive|predictive], pacing jsonb, calling_windows jsonb)
script / script_version(graph jsonb) / disposition(id, programme_id, code, category)
qa_form / qa_evaluation(score, sections jsonb, auto_fail, ai_score, status)
shift / schedule_assignment / agent_state_event(state, reason_code, at)
ticket(id, ..., sla_policy_id, first_response_due, resolution_due, status, priority)
kb_article(id, locale, version, status, body, embedding_ref)
consent_record(contact_id, purpose, channel, lawful_basis, source, captured_at, evidence jsonb)
audit_event(id, tenant_id, actor_id, action, object, record_id, field, before, after, ip, at) -- append-only, partitioned monthly
```

Money is stored as `amount_minor bigint` + ISO currency. FX rates are held in `fx_rate(date, base, quote, rate, source)`.

### Metadata layer (custom objects/fields, Salesforce-style)
```
object_def(id, tenant_id, api_name, label, plural_label, is_custom, programme_scoped, storage_mode[standard|generic], features jsonb)
field_def(id, tenant_id, object_id, api_name, label, type, required, unique, default, picklist_values jsonb, lookup_object_id, formula_expr, rollup_spec jsonb, indexed bool, encrypted bool, fls jsonb)
layout_def(id, tenant_id, object_id, record_type_id, role_ids[], definition jsonb)  -- Canvas-equivalent
validation_rule(id, object_id, expression, error_message, active)
record_type(id, object_id, name, picklist_overrides jsonb)
custom_record(id, tenant_id, programme_id, object_id, name, data jsonb, owner_id, created_at, updated_at)  -- partitioned by hash(tenant_id)
```

- **Storage strategy:**
  - Custom fields on standard objects live in the `custom jsonb` column.
  - Custom objects live in `custom_record` (generic table, `data jsonb`).
  - When admins mark a field "indexed/filterable", the metadata service creates a partial expression index `ON custom_record ((data->>'field_x')) WHERE tenant_id = ... AND object_id = ...` (bounded by plan limits) and mirrors the field to OpenSearch.
  - Silo tenants may opt into **materialised columns** (DDL per tenant) for heavy objects.
- **Formula engine:** a safe expression language (parsed to AST; functions like IF, CASE, TEXT, DATEDIFF, CURRENCYCONVERT). It is evaluated in TypeScript for validation and UI, and compiled to SQL for reports where possible.
- **Runtime API generation:** the metadata cache (Redis, versioned per tenant) drives dynamic OpenAPI/GraphQL schemas per tenant (as Twenty does), plus Zod validators for writes.

## 3.5 API design
- **REST (P0):** `/api/v1/objects/{apiName}` CRUD, `/query` (filter DSL), `/bulk` (async jobs, CSV/JSONL), `/composite` (multi-op transaction). Also `/metadata/*`, `/conversations`, `/calls`, `/campaigns`, `/webhooks`.
  - Cursor pagination and ETags/If-Match for optimistic concurrency.
  - Idempotency-Key header on POSTs.
  - Rate limits per tenant/app.
- **GraphQL (P1):** per-tenant schema generated from metadata, persisted queries for mobile (low bandwidth), and subscriptions for inbox/wallboard.
- **Webhooks:** outbox-driven, HMAC-signed, retries with exponential backoff, dead-letter queue, replay UI. Events are `record.created|updated|deleted`, `conversation.*`, `call.*`, `payment.*`, `einvoice.*`.
- **Auth for apps:** OAuth 2.1 (authorization code + PKCE), scoped tokens, per-app installation per tenant; API keys for server-to-server.
- **MCP server (P1):** expose permission-respecting tools (search records, create task, draft reply) so customers' AI assistants can act on Kasuwa data, a feature Twenty already ships.
- **Versioning:** URL major version; additive changes only; deprecation headers with a 12-month policy.

## 3.6 Workflow and automation engine
- **Triggers:** record events (from the outbox), schedules (cron per tenant timezone), inbound messages/calls, webhooks, manual/button, approval outcomes.
- **Definition:** JSON graph (nodes: condition, action, wait/delay, wait-for-event, branch, loop, sub-flow, approval, code step), versioned. Editing creates a new version, and in-flight runs continue on their version.
- **Execution:** a durable execution engine. For MVP, use BullMQ with a persisted `flow_run`/`flow_step` state machine. At v1, evaluate Temporal (self-hosted) for long waits, retries and human-in-the-loop steps. Idempotent actions with step-level retries; per-tenant concurrency limits; loop/recursion guards (max depth, max executions per record per hour).
- **Blueprint-equivalent:** stage transitions are a special flow type that is enforced synchronously in the write path (API rejects invalid transitions) and exposes "available transitions" to the UI.
- **Approvals:** multi-step, parallel/serial, delegate, escalate on timeout, approve via WhatsApp interactive buttons (signed, expiring tokens) or in-app.
- **Code steps (P1):** sandboxed TypeScript in isolated V8 isolates (e.g., isolated-vm) with CPU/memory/time limits and an allowlisted SDK.

## 3.7 Omnichannel messaging architecture
```
Inbound: Meta webhook / CPaaS webhook → Ingress (signature verify, dedupe by provider_msg_id)
       → normalise to Message envelope → resolve tenant by channel_account → contact match (E.164)
       → conversation upsert (window_expires_at) → routing engine (queue, skills, capacity)
       → realtime push to agent → outbox events (workflows, analytics)
Outbound: Composer → policy checks (consent, DND, quiet hours, 24h window/template requirement, cost)
        → provider adapter (WhatsApp Cloud API / Africa's Talking / Termii / Infobip / Twilio / SMTP)
        → status callbacks (sent/delivered/read/failed) → cost ledger (usage billing)
```
- **Provider abstraction:** a `ChannelProvider` interface (`send`, `parseWebhook`, `templates`, `capabilities`). Least-cost and failover routing for SMS by network (MTN/Airtel/Glo/T2) and route type (transactional vs promotional).
- **WhatsApp specifics:**
  - Embedded signup for tenants to connect their WABA.
  - Template sync and category tracking.
  - Per-country rate cards loaded from config (updated when Meta publishes changes such as the 1 October 2026 service-message pricing).
  - 24-hour window timers, and quality-rating/messaging-limit monitoring.
- **USSD:** a session state machine (Redis, TTL aligned to operator session timeout) plus a menu builder; menu nodes map to CRM actions (create lead, check ticket status).
- **Routing engine:** queue selection by programme and skills; push- or pull-based assignment; capacity units per channel (e.g., 1 call or 4 chats); SLA timers with escalation events.

## 3.8 Telephony architecture
- **Components:**
  - Kamailio (SIP edge, registrar, load balancing) and rtpengine (media relay, SRTP↔RTP, recording forking).
  - FreeSWITCH cluster (IVR, queues/ACD via `mod_callcenter` or custom, conferencing, recording, dialer execution).
  - A Dialer Service (TypeScript) that decides pacing and instructs FreeSWITCH via ESL.
  - WebRTC agents via SIP.js over WSS, with the Opus codec for low bandwidth.
- **Carriers:** SIP trunks from licensed Nigerian operators/aggregators and Kenyan/Ghanaian/South African carriers; Twilio/Africa's Talking voice as fallback. Obtain legal advice on NCC licensing and interconnect requirements for call-centre/telemarketing traffic before production.
- **Dialer:**
  - Preview (agent reviews, then dials).
  - Progressive (auto-dial on agent availability, 1:1).
  - Predictive (pacing ratio from Erlang-based model with live ASR (answer-seizure ratio), AHT and abandon-rate cap).
  - AMD, retries, time-zone and calling-window enforcement, DND/consent suppression checks at dial time.
- **Recording:** dual-channel, encrypted (per-tenant KMS key), stored in-region, retention per programme, legal hold, playback via short-lived signed URLs with watermark/audit.
- **PCI:** integrate a PCI DSS Level 1 DTMF-masking provider (SIP-in-the-middle or API-driven). Payment capture signals auto-pause recording and mark `pci_redacted`, and Kasuwa never receives PAN, only a token and last-four.
- **Quality:** MOS/jitter/packet-loss telemetry per call; agent network test on login; auto-suggest "audio-only low-bandwidth mode".

## 3.9 AI layer (Kasuwa Intelligence on Claude)
- **AI Gateway module:**
  - Central service for all LLM calls, with tenant-level enablement, data-processing region notes, PII redaction (NIN/BVN/PAN patterns), prompt templates (versioned) and model routing.
  - Use a smaller, faster Claude model for classification/summaries at scale and a larger model (e.g., the Opus tier) for complex drafting, agent reasoning and auto-QA rationale.
  - Also handles caching, token metering to AI credits, safety filters and full audit of prompts/outputs (retained per policy).
- **Features:**
  - Summaries: post-call (from transcript), conversation, record ("what's happened on this account").
  - Generative replies: WhatsApp/email drafts in the selected language and tone, grounded on record data and KB. The agent always approves in MVP.
  - Agent assist: streaming transcript (ASR partner) → intent detection → KB retrieval → suggested answer and compliance checklist in the side panel.
  - Scoring: start with rules + gradient-boosted models on tenant data (lead/deal outcomes); Claude provides explanations ("why this score").
  - Auto-QA: the LLM evaluates transcripts against a QA form (rubric in prompt, structured JSON output), with human calibration sampling.
  - AI agents (v2): tool-using agents with a restricted toolset (lookup order, create ticket, send payment link, schedule callback), per-tenant policies, confidence thresholds, handoff to human, and per-resolution metering.
- **RAG:** chunk KB articles, macros and approved documents. Embed and store per tenant (pgvector with RLS; later OpenSearch k-NN). Retrieval is filtered by tenant/programme/locale, and citations are shown to agents.
- **Evaluation:** golden datasets per feature and language (including Pidgin, Hausa, Yoruba, Igbo, Swahili, French), regression-tested in CI on prompt changes.
- **Compliance:** DPA with Anthropic, cross-border transfer assessment under NDPA/GAID (prompts may leave Africa), tenant opt-out, and no training on customer data.

## 3.10 Reporting & analytics architecture
- **Operational reports:** run against Postgres read replicas with the permission-aware query builder (the same RLS). Heavy aggregates are handled by materialised views refreshed incrementally.
- **Interaction analytics:** CDC (Debezium or outbox) → ClickHouse (calls, agent states, messages, SLA events). Wallboards are served from ClickHouse plus Redis live counters, and tenant/programme columns are enforced in every query via a query service.
- **Report builder:** metadata-aware semantic layer (objects, fields, relationships) → SQL generation with FLS applied (restricted fields removed).
- **Exports:** permission-checked, audit-logged, watermarked, optional approval for large exports.
- **Warehouse sync (P1):** per-tenant exports to customer-owned destinations.

## 3.11 Security architecture
- **AuthN:** argon2id passwords, WebAuthn/passkeys, TOTP, SMS OTP fallback (rate-limited), device/session management, SAML/OIDC SSO, SCIM (P1).
- **AuthZ:** a policy engine evaluates (subject roles/permission sets) × (object/field permissions) × (record access: owner, role hierarchy, sharing rules, programme membership, territory). The result is cached per user and invalidated on metadata change. Enforcement happens at the API (guards), the query builder (FLS column stripping) and the database (RLS for tenant/programme).
- **Audit:** append-only `audit_event` (partitioned, hash-chained for tamper evidence), exported to WORM storage for enterprise.
- **Encryption:** KMS envelope encryption; field-level encryption for NIN/BVN/sensitive custom fields with blind indexes for equality search; per-tenant keys for Silo; TLS everywhere, including internal mTLS in the cluster (service mesh optional).
- **Secrets:** cloud secrets manager plus External Secrets Operator; no secrets in repo (enforced by scanners).
- **Compliance tooling:** consent ledger, retention jobs, DSAR workflows, transfer register, DPIA records, breach-response runbook (NDPA requires notifying the NDPC within 72 hours). Verify current GAID timelines with counsel.
- **AppSec:** SAST (Semgrep), dependency (Renovate + OSV), container scanning (Trivy), DAST (ZAP) in staging, annual pen tests, threat models for each module.

## 3.12 Infrastructure & deployment
- **Regions:**
  - Primary pooled cell in **AWS af-south-1 (Cape Town)**, 3 AZs. Alternative: Azure South Africa North.
  - Edge: CloudFront with Lagos PoPs; AWS Lagos Local Zone for WebRTC media relays/TURN to cut West African latency.
  - Local cells: Lagos colocation (Rack Centre / MainOne-Equinix) on Kubernetes (k3s/RKE2 or OpenShift) for residency-sensitive tenants, and Nairobi when Kenyan demand or localisation requires it.
  - Telephony media servers near carriers (Lagos) to minimise latency and international transit.
- **Kubernetes:** EKS with Karpenter; Argo CD GitOps; Helm charts per component; HPA/KEDA autoscaling on queue depth.
- **Managed data:** RDS/Aurora PostgreSQL Multi-AZ with PITR; ElastiCache; OpenSearch Service; S3 with versioning and object lock for recordings under legal hold.
- **CI/CD:** GitHub Actions. Pipeline: lint → typecheck → unit → integration (Testcontainers) → isolation suite → e2e (Playwright) → build images → sign (cosign) → deploy to staging → smoke → progressive rollout (Argo Rollouts canary) → prod. Feature flags (OpenFeature/Unleash) per tenant.
- **Observability:** OpenTelemetry traces/metrics/logs with `tenant_id`, `programme_id`, `cell` attributes; SLO dashboards; PagerDuty/Opsgenie on-call; synthetic checks from Lagos, Nairobi, Accra, Johannesburg.
- **Backups/DR:** continuous PITR (RPO ≤5 min); daily snapshots copied to a second region (e.g., eu-west or an Azure SA region, subject to transfer rules; in-country for local cells); quarterly restore drills; runbooks for region failover (RTO ≤4h).
- **Cost controls:** per-tenant cost attribution; Graviton instances; storage lifecycle (recordings to infrequent-access/Glacier after 30–90 days per policy).

## 3.13 Mobile strategy
- **MVP:** installable PWA (service worker, IndexedDB cache, background sync) for agents/sales on Android, the dominant platform in the market.
- **v1:** Expo React Native app sharing the design tokens and API client.
  - Offline DB (WatermelonDB/SQLite) with a sync protocol: pull changes since cursor, push queued mutations, conflict resolution per field. Sync scope is limited to assigned records and the last 30 days.
  - Push notifications (FCM).
  - Native dialer integration (click-to-call via SIM, logged back as activity) plus VoIP softphone.
  - Camera card scan, geotagged check-ins.
  - Data-saver mode (no images, compressed payloads via persisted GraphQL queries).

## 3.14 Localisation, i18n, multi-currency
- **i18n:** ICU MessageFormat (FormatJS/Lingui); Crowdin (as used by Twenty) or Tolgee for translation workflow; pseudo-localisation in CI; RTL support; locale packs for en-NG, pcm (Pidgin), ha, yo, ig, fr, sw, pt, ar.
- **Formatting:** `Intl` APIs for numbers/dates/currencies (₦1,250,000.00; GH₵; KSh; R; CFA), and configurable first-day-of-week and date format per tenant.
- **Names and addresses:** flexible name model; Nigerian state/LGA reference data; landmark-based address field ("opposite …").
- **Multi-currency:** corporate currency per tenant; record currency; dated FX tables (daily from provider or CBN/central bank sources); conversion in reports at dated or current rate (configurable); rate-lock on quotes; rounding rules per currency (XOF has no minor unit in practice).
- **Holidays/time:** country holiday calendars, programme business hours, IANA timezones (WAT, EAT, SAST, GMT).

## 3.15 Testing strategy
- **Unit:** Vitest/Jest for domain logic (formula engine, permission evaluator, pacing algorithm, FX), ≥80% coverage on core domains.
- **Integration:** Testcontainers (Postgres, Redis, OpenSearch, MinIO), API contract tests from OpenAPI (schemathesis-style fuzzing).
- **Tenant isolation suite:** mandatory and blocking (see 3.3).
- **E2E:** Playwright for top 30 journeys, including low-bandwidth throttled runs (256 kbps profile) and offline scenarios.
- **Telephony:** SIPp load tests (CPS, concurrent calls), WebRTC tests with network emulation, dialer simulation against synthetic answer rates.
- **Performance:** k6 load tests at 2× target; DB query plan checks in CI for metadata queries.
- **Security:** SAST/DAST, authz matrix tests (every role × object × action), pen tests.
- **AI evals:** golden sets per feature/language; LLM-as-judge with human spot checks; regression gates.
- **UAT:** tenant #1 pilot floors with shadow-mode (run Kasuwa alongside Zoho/Salesforce for 4–6 weeks).

## 3.16 Monorepo structure
```
kasuwa/
  apps/
    web/                 # Next.js workspace + admin + portals
    api/                 # NestJS API (modular monolith)
    worker/              # BullMQ workers (workflows, webhooks, imports, AI jobs)
    realtime/            # WebSocket gateway
    dialer/              # Dialer/pacing service (ESL client)
    mobile/              # Expo app (v1)
  packages/
    domain/<module>/     # core, sales, cpq, inbox, telephony, bpo, qa, wfm, tickets, kb, marketing, workflow, metadata, reports, ai, billing, compliance
    db/                  # schema, migrations, RLS policies, seeders
    metadata-engine/     # object/field defs, formula engine, dynamic schema
    permissions/         # policy engine
    channel-providers/   # whatsapp, africastalking, termii, infobip, twilio, smtp
    payments/            # paystack, flutterwave, monnify, mpesa, momo
    einvoice/            # NRS MBS adapter
    ui/                  # design system (tokens, components) — synced with Claude Design
    i18n/                # locale packs
    sdk/                 # public TypeScript SDK
    testing/             # factories, isolation harness, fixtures
  infra/
    terraform/ helm/ argocd/ freeswitch/ kamailio/
  docs/
    adr/ prd/ runbooks/ api/
  CLAUDE.md
  .claude/ (agents/, skills/, commands/, settings.json)
```
Nx (or Turborepo) enforces module boundaries: `domain/*` may depend on `db`, `permissions`, `metadata-engine`, but never on another domain's internals. Cross-domain calls go through published interfaces or events.

## 3.17 Coding conventions
- TypeScript strict; no `any` (lint-enforced); Zod schemas at every boundary; Result types for domain errors.
- Every DB query goes through the tenant-scoped repository; raw SQL requires `// tenancy-reviewed` and a test.
- Money only via `Money` value object (minor units + currency); dates in UTC with explicit timezone conversion.
- All user-facing strings via i18n keys; no hard-coded currency symbols.
- Feature flags for every user-visible change; migrations are backward-compatible (expand → migrate → contract).
- ADRs for significant decisions; OpenAPI annotations mandatory on controllers.
- Conventional commits; PRs ≤400 lines changed where possible; CODEOWNERS per domain.

## 3.18 Claude Code workflow recommendations
**CLAUDE.md (root) should contain:**
1. Product one-paragraph summary and glossary (tenant, programme, disposition, DND, MBS, WABA, 24h window).
2. Architecture rules: modular monolith, module boundaries, "never bypass tenant repository", RLS session variables, outbox for events.
3. Commands: `pnpm nx test <proj>`, `pnpm nx e2e web`, `pnpm db:migrate`, `pnpm test:isolation`, `pnpm lint --fix`.
4. Coding conventions (3.17) and "definition of done": tests written first, isolation suite passes, i18n keys added, OpenAPI updated, ADR if architecture changes, no new dependencies without justification.
5. Security guardrails: never log PII/PAN/NIN/BVN; use `redact()`; secrets via env only.
6. Pointers to `docs/prd/*.md` for the module being worked on and to `packages/ui` for components (never invent new colours or spacing).

**Per-module CLAUDE.md** in `packages/domain/<module>/` with domain rules (e.g., dialer pacing invariants, WhatsApp window rules).

**Task breakdown:** each epic → stories → Claude-sized tasks (≤1 day, one module, clear acceptance tests). Use a task template: context, files likely touched, acceptance criteria, test cases to write first, out-of-scope.

**Test-driven prompting:** "Write failing tests for AC1–AC4 of US-3 in `packages/domain/cpq`; do not implement yet." → review → "Implement until tests pass; do not modify tests." → "Refactor; run isolation suite."

**Subagents (`.claude/agents/`):** `tenancy-reviewer` (reviews diffs for tenant leaks), `security-reviewer`, `i18n-checker`, `migration-reviewer` (expand/contract safety), `api-contract-writer`, `test-writer`, `ui-implementer` (turns Claude Design exports into `packages/ui` components).

**Skills (`.claude/skills/`):** reusable instructions and scripts for "add a standard object", "add a channel provider", "add a workflow action", "add a report type", "create migration with RLS policy", "wire a Claude Design screen".

**Hooks:** pre-commit hooks for lint/typecheck; a post-edit hook that runs the affected tests; block edits to `db/migrations` without the migration-reviewer.

**Design hand-off:** keep the Kasuwa design system in `packages/ui` as the single source of truth, and have Claude Design import it. Anthropic's 2026 update added design-system imports and code round-trips (including a `/design-sync` flow between Claude Design and Claude Code),\[83\]\[84\] so screens generated in Claude Design stay on-brand and move into code without re-drawing.

**Parallelism:** use git worktrees and multiple Claude Code sessions per module, with humans owning integration and review. Keep the main branch always deployable.

## 3.19 Phased build plan (epics and sprints; 2-week sprints)

| Sprint | Epics / outcomes |
|---|---|
| S0 (wk 1–2) | Repo, CI/CD, IaC for dev/staging, design system foundations from Claude Design, CLAUDE.md, ADRs 1–10 |
| S1–S2 | Auth (password, MFA, SSO OIDC), tenancy/programme model, RLS, permissions engine v1, audit log, isolation test harness |
| S3–S4 | Metadata engine (objects, fields, layouts, validation), core records (lead/contact/account/deal), list/record UI, import wizard + Zoho/Salesforce importers v1 |
| S5–S6 | Pipelines + stage gating, activities/calendar sync, email sync, global search, reports v1 |
| S7–S8 | Omnichannel inbox: WhatsApp Cloud API, SMS providers, email, web chat; routing/queues; consent/DND engine |
| S9–S10 | Telephony: Kamailio/FreeSWITCH, WebRTC softphone, IVR builder, recording, preview/progressive dialer, scripts, dispositions |
| S11–S12 | Tickets + SLAs, workflows + approvals, wallboard v1, client portal v1, quotes + Paystack/Flutterwave links |
| S13–S14 | AI gateway: summaries, reply drafts; billing/subscriptions; PWA offline; hardening, pen test, performance; **MVP internal GA (month 7)**; pilot 100–300 agents |
| S15–S20 | Predictive dialer, QA + auto-QA, WFM-lite, KB + portal + RAG bot, visual flow builder, forecasting/territories, MBS e-invoicing, GraphQL, marketing v1 |
| S21–S24 | React Native app, agent assist, lead/deal scoring, Kenya/Ghana localisation, MoMo/M-Pesa, marketplace beta; **v1 commercial GA (month 12)** |
| S25–S40 | v2: AI agents, app builder + SDK, speech analytics, partner portals, gamification, local cells, SOC 2/ISO 27001, francophone launch |

## 3.20 Team composition and timeline

| Role | MVP (months 0–7) | v1 (8–12) | Notes |
|---|---|---|---|
| Head of Engineering / Architect | 1 | 1 | Owns ADRs, tenancy, reviews |
| Senior full-stack (TS) | 4 | 6 | Each drives 1–2 modules with Claude Code |
| Telephony/VoIP engineer | 1 | 2 | FreeSWITCH/Kamailio/WebRTC |
| Platform/DevOps/SRE | 1 | 2 | K8s, IaC, observability, cells |
| QA/automation engineer | 1 | 2 | Isolation, e2e, load |
| Product manager | 1 | 2 | One for CRM, one for contact centre |
| Product designer (Claude Design) | 1 | 1 | Owns design system and prompts |
| Security/compliance lead (part-time → full) | 0.5 | 1 | NDPA, PCI partner, ISO 27001 |
| BPO domain SMEs (from sponsor) | 2 (part-time) | 2 | Supervisors/QA leads |
| **Total** | **~12–13 FTE** | **~18–19 FTE** | |

Timeline: MVP internal GA about month 7; commercial v1 about month 12; v2 months 18–24. Claude Code is assumed to lift throughput meaningfully on CRUD, tests and integrations. Telephony, tenancy and security still require senior human ownership, so budget a 20–30% contingency.

---

# PART 4 — CLAUDE DESIGN PROMPTS

**How to use:**
- Run Prompt 0 first and save the result as the Kasuwa design system in Claude Design (or import `packages/ui` once it exists).
- Start every later prompt in the same project so the system is applied.
- Each prompt is self-contained and can be pasted as-is.
- Ask for light and dark variants and a 360px mobile variant where relevant.

### Prompt 0 — Design system & foundations
```
Create the "Kasuwa" design system for an enterprise, Africa-first CRM and contact-centre SaaS used by BPO agents, sales teams, support teams and SME owners across Nigeria, Ghana, Kenya, South Africa and francophone West Africa.

Brand: confident, warm, modern, trustworthy — not safari clichés. Primary colour deep indigo (#2B2A8C range) with a warm accent (saffron/amber #F2A900 range) and a success green inspired by the Nigerian flag (#0B8A4B range). Neutrals: warm greys. Define full tonal scales (50–950) for primary, accent, success, warning, danger, info, neutral, plus semantic tokens (surface, surface-raised, border, text-primary/secondary/muted, focus-ring).

Typography: a highly legible humanist sans (e.g., Inter or similar) with full Latin Extended support for Yoruba/Igbo/Hausa diacritics (ẹ, ọ, ṣ, ɓ, ɗ, ƙ) and French; show a type scale (display, h1–h6, body-lg/md/sm, caption, mono for IDs and phone numbers). Include an Arabic-script fallback and demonstrate RTL mirroring.

Components (show all states: default, hover, focus-visible, active, disabled, loading, error): buttons (primary, secondary, ghost, danger, icon), inputs, phone input with country flag and network badge (MTN/Airtel/Glo/T2 as neutral chips), currency input with symbol and locale formatting (₦1,250,000.00, GH₵, KSh, R, CFA), date/time pickers with WAT/EAT/SAST timezone labels, selects, multiselect chips, toggles, checkboxes, radio, tabs, breadcrumbs, side navigation (collapsible), top bar with global search, command palette, tables (dense and comfortable, sticky header, column resize, row selection, inline edit), Kanban cards, record header, timeline items per channel (WhatsApp green bubble, SMS, email, call, note), badges/status pills, SLA countdown chip, avatars with presence (available, on call, wrap-up, break, offline), toasts, modals, drawers, empty states, skeleton loaders, pagination, charts palette (colour-blind safe), file upload with progress and resume.

Include: a "Low-bandwidth mode" indicator and toggle pattern; an offline banner with queued-changes count; a data-saver image placeholder; consent/DND badges; a PCI "secure payment in progress" banner.

Accessibility: WCAG 2.2 AA contrast, 44px touch targets, visible focus, reduced-motion variants. Provide light and dark themes side by side. Mobile-first: show key components at 360px width. Output a single design-system board with tokens, components and usage notes.
```

### Prompt 1 — Authentication & onboarding
```
Using the Kasuwa design system, design the authentication and onboarding flow (web desktop 1440px and mobile 360px, light and dark).

Screens: 1) Sign in: email + password, "Sign in with Google/Microsoft", "Sign in with SSO" (enter work domain), passkey button, language switcher (English, Français, Pidgin, Hausa, Yorùbá, Igbo, Kiswahili), low-bandwidth toggle. 2) MFA challenge: authenticator code, SMS OTP fallback with resend timer and "code sent to +234 803 *** 4567", passkey option. 3) Sign up: name, work email, phone (country picker defaulting to Nigeria +234), company name, country, number of employees, "Are you a BPO/contact centre?" toggle. 4) Email/phone verification. 5) Onboarding wizard (5 steps with progress): choose region for data storage (South Africa – default, Nigeria – Enterprise, Kenya) with plain-language NDPA note; choose currency and language; connect WhatsApp Business (Meta embedded signup button with explainer of 24-hour window and message costs); import data (from Zoho CRM, Salesforce, HubSpot, CSV/Excel); invite team (bulk emails or WhatsApp invite link). 6) Success screen with checklist.

States: wrong password, locked account, expired OTP, SSO domain not found, slow network (skeleton + "Still connecting… switch to low-bandwidth mode"). Empty states and helper text in simple English. Show Paystack-style trust cues without logos. Keep the page weight light (no hero images on mobile).
```

### Prompt 2 — Tenant/workspace setup & admin console
```
Using the Kasuwa design system, design the Admin Console for a tenant administrator (desktop-first, responsive to tablet).

Layout: left settings navigation grouped as Company (profile, business units, fiscal year, currencies & FX rates, holidays & business hours per country), Users & Access (users, roles hierarchy tree, permission sets, field-level security matrix, sharing rules, SSO/SAML, MFA policy, IP allowlist, sessions), BPO (clients, programmes, programme settings: SLA policy, retention, dispositions, scripts, QA forms, client portal branding), Channels (WhatsApp numbers, SMS sender IDs, USSD codes, email domains, phone numbers/trunks), Data (import/export, dedup rules, recycle bin, retention), Compliance (consent settings, DND & quiet hours, DPIA records, data-subject requests, cross-border transfer register, audit log), Customisation (objects, fields, layouts, validation rules, record types), Automation, Integrations, Billing.

Design these screens in detail: (a) Admin home with setup health score, alerts (e.g., "WhatsApp template rejected", "2 users without MFA"), usage meters (seats, WhatsApp messages this month vs estimate in ₦, storage, AI credits); (b) Programmes list and Programme detail (BPO) with tabs: Overview, Agents & skills, SLA, Dispositions, Scripts, Retention, Portal users; (c) Roles hierarchy tree with drag-to-reparent; (d) Field-level security matrix (objects × fields × permission sets, read/edit toggles, search and bulk actions); (e) Audit log with filters (actor, action, object, date, IP) and export.

Include empty states, confirmation modals for destructive actions, and an "Unsaved changes" bar. Show a data-residency badge ("Data stored in: South Africa (af-south-1)") in the header.
```

### Prompt 3 — Home dashboard (role-aware)
```
Using the Kasuwa design system, design role-aware Home dashboards (desktop 1440px, mobile 360px, light/dark).

Variants: 1) Sales rep: today's agenda (meetings, calls, tasks), "Deals needing attention" (rotting, missing next step), quota attainment ring in ₦, WhatsApp conversations awaiting reply with 24-hour window countdown, AI "Next best actions" card (3 items with reason and one-click action). 2) Sales manager: pipeline by stage, forecast vs quota (commit/best case), team leaderboard, approvals queue. 3) Support agent: my open tickets by SLA risk, queue sizes, CSAT trend. 4) BPO agent: current programme selector, personal stats (AHT, contacts handled, QA score), schedule for today with breaks, announcements from supervisor. 5) Executive: revenue, cost-to-serve per channel, client/programme profitability, SLA attainment across programmes, AI usage.

Components: customisable widget grid (drag, resize, add widget drawer), date range selector, currency toggle (NGN/USD), "Low-bandwidth mode" rendering where charts become compact numbers. Empty states for new tenants with setup prompts. Loading skeletons. Show example Nigerian names and ₦ values.
```

### Prompt 4 — Contacts/Accounts/Leads list views
```
Using the Kasuwa design system, design list views for Leads, Contacts and Accounts (desktop and mobile).

Desktop: header with object name, view switcher (Table, Kanban, Map, Split view), saved views dropdown, "New" button, import/export menu. Filter bar with chips (Owner, Status, Source incl. WhatsApp/USSD/Missed call/Web form, State/LGA, Preferred language, Consent status, DND). Dense data table with sticky columns: name with avatar, phone (E.164 formatted +234 803 123 4567 with network chip), WhatsApp opted-in icon, email, company, owner, last activity (relative time), lead score bar, tags. Inline edit, bulk selection with actions (assign, add to campaign, update field, merge duplicates, send WhatsApp template), column chooser, pagination with 25/50/100.

Mobile: card list with swipe actions (call, WhatsApp, SMS), sticky search, filter sheet.

States: empty (with "Import from Zoho/Salesforce/CSV" and "Capture leads from WhatsApp" CTAs), no results, loading skeleton, offline (cached list with "Last synced 10:42 WAT"), permission-restricted columns shown as locked. BPO context: programme chip in header ("Programme: Bank X – Collections") and a note that only this programme's records are visible.
```

### Prompt 5 — 360° record view
```
Using the Kasuwa design system, design the 360° Contact record page and Account record page (desktop 3-column, tablet 2-column, mobile stacked tabs).

Header: name, photo/initials, title, account link, owner, key badges (Customer since, VIP, DND, Marketing consent ✓/✗, preferred language "Yorùbá", preferred channel "WhatsApp"), quick actions (Call, WhatsApp, SMS, Email, Log activity, New deal, New ticket, Send payment link), follow button.
Left column: details panel with sections defined by the layout builder (editable inline), identity verification status (NIN verified via partner, masked "NIN ••••••4521"), addresses (State, LGA, landmark).
Centre: unified timeline with filters by channel (calls with recording player and AI summary, WhatsApp threads, SMS, emails, notes, tickets, payments, e-invoices), composer at top that switches channel and shows WhatsApp 24-hour window status and template picker when closed.
Right column: AI summary card ("What's happened", sentiment trend, open risks), next-best-action, related lists (deals, tickets, quotes, invoices with payment status, campaigns), consent history.

States: loading skeleton, sensitive fields hidden by field-level security (show lock icon + "No access"), record in another programme (access denied page), offline edits queued banner. Include an Account variant with hierarchy tree and contacts grid.
```

### Prompt 6 — Pipeline Kanban & opportunity detail
```
Using the Kasuwa design system, design the Deals pipeline Kanban and the Deal detail page.

Kanban: pipeline selector, filters (owner, close date, amount, territory), totals per stage in ₦ with weighted amounts, cards showing deal name, account, amount (₦ with optional USD equivalent), close date, owner avatar, days in stage (rotting colour), next step, WhatsApp last-contact icon. Drag-and-drop between stages; when a stage has entry requirements (Blueprint-style), dropping opens a "Complete to move" modal listing required fields, checklist, attachments and approval request. Show a blocked transition state.
Deal detail: stage path at top with allowed next transitions only, key fields, products/line items table with price book currency, FX rate lock indicator ("Rate locked ₦1,372/$ until 30 Sep"), competitors, contact roles, activity timeline, quotes list, approval history, AI deal-risk card with reasons.

Mobile: stage columns become a horizontally swipeable list with a stage switcher. Empty pipeline state with "Create your first pipeline" template picker (B2B sales, Real estate, Loans, Distribution).
```

### Prompt 7 — Activities, calendar & tasks
```
Using the Kasuwa design system, design Activities: My Tasks list, Calendar (day/week/month), and Activity composer.

Tasks: grouped by Overdue/Today/Upcoming, priority, related record, quick complete, snooze, bulk reassign. Calendar: synced Google/Microsoft events plus CRM meetings, colour by type, Nigerian public holidays shown as all-day banners, timezone label (WAT), drag to reschedule, side panel with meeting prep AI brief. Booking page designer (public page to book a meeting, confirmation via WhatsApp/SMS/email). Field sales check-in on mobile: map pin, photo, notes, works offline with queued sync.

States: calendar not connected, no tasks (celebration empty state), offline, conflict warnings.
```

### Prompt 8 — Omnichannel unified inbox
```
Using the Kasuwa design system, design the Omnichannel Inbox for support/BPO agents and SME owners (desktop 3-pane, mobile 2-level).

Left pane: queues and views (Mine, Unassigned, Team, Programme), channel filters (WhatsApp, SMS, Email, Web chat, Facebook, Instagram, Telegram, USSD sessions), SLA-sorted conversation list with channel icon, contact name, preview, waiting time, SLA chip, language flag, unread badge.
Centre: conversation thread with WhatsApp-style bubbles (media, voice notes with player and transcription, interactive buttons/list messages, delivery/read ticks), system events (assigned, transferred, window expired), internal notes (yellow), composer with channel switcher, canned responses (/ shortcut), AI "Draft reply" with language selector (English, Pidgin, Hausa, Yorùbá, Igbo, Français, Kiswahili) and tone, attachment, payment link insert, emoji. When the WhatsApp 24-hour window is closed: composer locks free text and shows template picker with category (Marketing/Utility/Authentication) and estimated cost in ₦.
Right pane: contact card, open tickets/deals, previous conversations, AI summary, consent status, quick actions (create ticket, create lead, transfer, escalate).

States: new conversation arriving (subtle animation, sound toggle), agent at capacity, disconnected (reconnecting banner), low-bandwidth mode (media not auto-downloaded, tap to load with size shown), empty queue.
```

### Prompt 9 — Softphone & dialer/campaign console (BPO agent)
```
Using the Kasuwa design system, design the Agent Workspace for voice: the embedded WebRTC softphone and the Dialer campaign console.

Softphone (docked panel, collapsible): agent state selector (Available, On call, Wrap-up, Break, Lunch, Training, Offline with reason codes and timer), dial pad with country code, call controls (mute, hold, transfer – blind/warm, conference, record indicator, DTMF keypad, end), call timer, caller ID selector, network quality indicator (MOS bars) and "switch to low-bandwidth audio" tip, incoming call toast with screen-pop preview (name, programme, last interaction, open ticket).
Campaign console: current campaign card (mode Preview/Progressive/Predictive, programme, calling window "08:00–20:00 WAT", remaining records, my contacts/hour), in Preview mode the next record preview with Skip/Call buttons and countdown; in Progressive/Predictive the "Connecting…" state then auto screen-pop. Compliance banners: "Number on DND – skipped", "Outside calling hours for recipient", "Consent: marketing ✗".
Secure payment: button "Take secure payment" launching a PCI mode banner ("Customer entering card details on keypad – recording paused, digits masked") with progress and result (token + last four only).

States: no campaign assigned, campaign paused by supervisor, wrap-up timer countdown, call failed/busy/no answer with auto-disposition suggestion, WebRTC permission not granted, offline.
```

### Prompt 10 — Agent scripting & disposition screen
```
Using the Kasuwa design system, design the in-call Script & Disposition experience and the Script Builder.

In-call: centre panel shows the programme script as step cards with branching choices (e.g., "Customer confirms identity? Yes/No"), dynamic variables filled from CRM ("Good afternoon, Mr Okafor"), embedded form fields that write to the record (promise-to-pay date, amount in ₦, reason), mandatory compliance statements with checkbox acknowledgements, and AI suggestion chip for the next line. On call end: disposition modal with hierarchical codes (Contacted → Promise to Pay / Refused / Call back; Not contacted → No answer / Busy / Wrong number / Switched off), callback scheduler (respecting calling hours), notes with AI summary prefilled, wrap-up timer.
Script Builder (admin): canvas with nodes (Say, Question, Branch, Form, Compliance, End), versioning, preview mode, per-programme assignment, translation tabs (English, Hausa, Yorùbá, Igbo, Pidgin, French).

States: required field missing, disposition not selected (block), script version updated mid-shift (banner).
```

### Prompt 11 — Supervisor real-time wallboard
```
Using the Kasuwa design system, design the Supervisor Real-Time Wallboard (desktop and TV mode 1920×1080, dark theme default).

Top KPI strip per selected programme(s): Calls waiting, Longest wait, Service level (e.g., 80/20) gauge, ASA, AHT, Abandon %, Agents available/on call/wrap-up/break, WhatsApp chats waiting, SLA breaches today. Threshold colours (green/amber/red) and trend sparklines.
Middle: queue table (queue, programme, waiting, SLA %, AHT, agents staffed vs required from Erlang C). Agent grid: tiles with name, state, time in state, current contact channel, adherence indicator; click opens actions (Listen, Whisper, Barge, Force state change, Message agent) – every action shows "Audit-logged".
Right: alerts feed (e.g., "Queue Bank X – Card Services exceeds 60s wait"), intraday forecast vs actual chart.
TV mode: large numerals, auto-rotate programmes, no interactive controls.

States: real-time connection lost (stale-data banner with last update time), no agents logged in, multi-programme selector with client grouping.
```

### Prompt 12 — QA scorecard & calibration
```
Using the Kasuwa design system, design Quality Assurance: Evaluation workspace, Scorecard builder, Calibration session and Agent QA view.

Evaluation workspace: left – interaction list from sampling rules (filters: programme, agent, disposition, AI score range, sentiment); centre – call recording player with waveform, dual-channel speaker lanes, transcript synced with playback, PCI-redacted segment shown as hatched block, timestamped comments; right – scorecard form with weighted sections (Greeting, Verification, Resolution, Compliance, Soft skills), auto-fail items highlighted, AI pre-score with rationale per item and "Accept/Override" controls, total score, coaching note, "Create coaching task".
Scorecard builder: sections, questions (yes/no, scale, N/A), weights, auto-fail flags, versioning per programme.
Calibration: multiple evaluators' scores side by side with variance highlighting.
Agent view (mobile-friendly): my evaluations, scores trend, acknowledge/dispute within 72 hours.

States: no evaluations yet, recording retention expired, permission to play recording denied.
```

### Prompt 13 — Ticketing/helpdesk
```
Using the Kasuwa design system, design the Helpdesk: ticket list, ticket detail, and SLA policy editor.

Ticket list: views (My open, Unassigned, Breaching soon, Programme), columns (ID, subject, contact, channel of origin, priority, status, SLA countdown chip for first response and resolution, assignee, tags), bulk actions, Kanban by status option.
Ticket detail: header with status/priority/assignee, SLA timers, conversation thread merged across channels, internal notes, macros, linked records (order, deal, account), KB suggestions (AI), merge/split ticket, CSAT result. Public holiday awareness: SLA timer paused outside business hours with tooltip ("Paused – Independence Day, 1 Oct").
SLA policy editor: conditions (programme, priority, channel), targets, business hours calendar per country, escalation steps.

States: breached (red), paused, reopened, empty queue, customer replied via WhatsApp after closure (auto-reopen banner).
```

### Prompt 14 — Knowledge base & customer self-service portal
```
Using the Kasuwa design system, design (a) the internal Knowledge Base editor and (b) the customer-facing Self-Service Portal (white-labelled per tenant, mobile-first, very lightweight).

KB editor: article list with status (Draft, In review, Published, Archived), language versions (English, French, Pidgin, Hausa, Yorùbá, Igbo, Kiswahili) with translation status, rich editor, approval workflow, "Used by AI" toggle, article analytics (views, deflections).
Portal: tenant logo/colours, big search box with instant results, categories, article page with "Was this helpful?", AI answer box with citations, submit ticket form, "Chat on WhatsApp" button, track my tickets (login via phone OTP), language switcher. Low-bandwidth: text-first, images lazy-loaded, total page <200KB.

States: no results (suggest WhatsApp/ticket), article outdated banner, portal offline message.
```

### Prompt 15 — Marketing campaigns & segmentation builder
```
Using the Kasuwa design system, design Marketing: Campaigns list, Segment builder, Campaign composer for WhatsApp/SMS/Email, and Campaign report.

Segment builder: visual rule groups (AND/OR) on fields, behaviours (opened, clicked, replied on WhatsApp, paid via Paystack), location (State/LGA, country), language, consent (required by default and cannot be removed for marketing), DND exclusion for promotional SMS; live audience count and estimated reach per channel.
Composer: channel tabs; WhatsApp template selector with preview in phone mockup, variable mapping, category and per-message cost by country, total estimated cost in ₦ and USD; SMS with character/segment counter and route selection (Promotional/Transactional) plus DND warning; Email with drag-and-drop editor. Scheduling with quiet-hours enforcement (08:00–20:00 recipient local time), throttling, A/B test.
Report: delivered/read/replied/clicked/converted, cost, revenue attributed, opt-outs.

States: template pending Meta approval, template rejected with reason, budget cap reached, audience empty.
```

### Prompt 16 — Email/multichannel sequence builder
```
Using the Kasuwa design system, design the Sequence Builder and Sequence performance view.

Builder: vertical step timeline with steps (Email, WhatsApp template, SMS, Call task, LinkedIn task, Wait X days, Branch on reply/open/payment), per-step content editor with AI "Write this step" (language/tone), business-day and holiday-aware delays, sending windows per timezone, exit conditions (replied, meeting booked, deal stage changed, opted out).
Enrolment panel: select contacts/leads, conflicts check (already in sequence, DND, no consent).
Performance: per-step funnel, reply rates by channel, best time heatmap.

States: mailbox not connected, WhatsApp number not connected, sequence paused, step error.
```

### Prompt 17 — Workflow/automation builder (visual)
```
Using the Kasuwa design system, design the visual Workflow Builder and Approval Process designer.

Canvas: trigger node (Record created/updated, Scheduled, Inbound WhatsApp/SMS, Call ended, Payment received, Webhook, Button), then nodes: Condition, Branch, Update record, Create record, Send WhatsApp/SMS/email, Assign/round-robin, Wait (duration/until date/for event), Approval, HTTP request, Code (TypeScript), Sub-flow, AI step (summarise/classify/draft). Left palette, right properties panel with field pickers and formula editor, minimap, zoom, version history, test run with sample record and step-by-step execution log, activate/deactivate.
Blueprint mode (stage transitions): state diagram of stages with transitions; clicking a transition configures required fields, checklist, attachments, approvers, SLA.
Approval designer: steps, approvers (manager, role, specific user, queue), parallel/serial, escalation timeout, approve via WhatsApp toggle.
Run monitor: list of runs with status, errors, retry.

States: validation errors on nodes, infinite-loop warning, draft vs active version.
```

### Prompt 18 — Custom object & layout builder
```
Using the Kasuwa design system, design the Customisation studio: Object Manager, Field editor, Layout (page) builder, and Validation rules.

Object Manager: list of standard and custom objects, create object wizard (label, plural, icon, programme-scoped toggle, features: activities, timeline, approvals), relationships diagram view.
Field editor: types (text, number, currency, date, picklist, multi-select, lookup, formula, rollup, phone, email, NIN/BVN secure, file), properties (required, unique, indexed/filterable with plan-limit meter, encrypted, default, help text), field-level security per permission set, translations of labels.
Layout builder (Canvas-style): drag-and-drop sections, fields, related lists, components (timeline, AI summary, payment status, map), conditional visibility rules, assign layouts per role/record type/programme, preview as user, desktop/mobile toggle.
Validation rules: formula editor with syntax highlighting, test against sample record, error message translations.

States: field limit reached, breaking change warning (field used in workflows/reports), unsaved changes.
```

### Prompt 19 — Reports & dashboard builder
```
Using the Kasuwa design system, design the Report Builder, Report viewer and Dashboard Builder.

Report builder: choose object(s) and relationships, drag fields to columns/groupings, filters, summary formulas, chart type picker, currency conversion option (dated vs current rate), row-level and field-level security note ("You see only data you have access to"), save to folder with sharing.
Viewer: table/summary/matrix toggles, chart, drill-down, export (audit-logged, may require approval), schedule delivery (email or WhatsApp PDF, time with WAT).
Dashboard builder: grid of widgets (KPI, bar, line, funnel, gauge, table, leaderboard), global filters, per-programme dashboards for BPO clients, "Ask in plain language" AI bar that generates a report ("Show calls abandoned by programme this week").

States: no data, query too large (suggest filters), low-bandwidth (render tables without charts).
```

### Prompt 20 — Forecasting
```
Using the Kasuwa design system, design the Sales Forecast module.

Forecast grid: hierarchy (org → region → team → rep) rows, periods (month/quarter) columns, categories (Closed, Commit, Best case, Pipeline), quota and attainment, manager adjustments with notes and audit trail, currency toggle (NGN/USD) and FX note. AI forecast column with confidence band and drivers. Territory view toggle. Drill into deals that make up each cell. Snapshot comparison (this week vs last week) with movement arrows.
Mobile: summary card for managers with top risks.

States: quota not set, forecast locked (submitted), period closed.
```

### Prompt 21 — Quotes, products & invoicing with local payments
```
Using the Kasuwa design system, design Products & Price books, Quote builder, Invoice view, and Payments.

Products: catalogue table, variants, price books per currency (NGN, GHS, KES, ZAR, XOF, USD), tax profiles (VAT 7.5% Nigeria).
Quote builder: line items with search, quantity, discount (approval required above threshold – show pending state), taxes, totals, FX rate lock and validity date, template selector, PDF preview, send via WhatsApp/email with Paystack/Flutterwave payment link, e-signature request.
Invoice: header with invoice number, NRS e-invoice status chip (Draft → Submitted → Cleared with IRN and QR code / Failed with reason and Retry), buyer TIN, VAT breakdown, WHT field, payment status (Unpaid, Part-paid, Paid) with payment methods (card, bank transfer/virtual account, USSD, mobile money M-Pesa/MTN MoMo), reconciliation timeline from webhooks.
Payments list: filters, fees shown (e.g., gateway fee), refunds.

States: e-invoice rejected, payment link expired, partial payment, currency mismatch warning.
```

### Prompt 22 — Settings: roles, permissions, security, billing
```
Using the Kasuwa design system, design Settings screens for Security and Billing.

Security: MFA policy (enforce for roles), passkeys, SSO (SAML metadata upload, OIDC config, test connection, just-in-time provisioning), session timeout, IP allowlist, API keys and OAuth apps, data residency display, encryption keys (BYOK for Enterprise), sensitive-data access log.
Roles & permissions: permission set editor with object CRUD grid, system permissions (export, view recordings, manage campaigns), assignment to users, "compare two permission sets" view.
Billing: current plan, seats used/available, usage meters (WhatsApp messages by category with ₦ cost, SMS, voice minutes, AI credits, storage) with month-to-date and forecast, invoices (with NRS e-invoice status), payment method (Paystack card, bank transfer), change plan with local-currency pricing, spend caps and alerts.

States: payment failed (dunning banner with grace period), seat limit reached, SSO misconfigured.
```

### Prompt 23 — Client portal for BPO clients
```
Using the Kasuwa design system, design the BPO Client Portal (white-labelled with the BPO's brand and the client's name, desktop and mobile).

Home: programme selector (only programmes the client stakeholder is entitled to), real-time SLA tiles (service level, ASA, AHT, abandon %, contacts handled today, CSAT), trend charts, SLA compliance vs contract target, alerts.
Reports: downloadable monthly SLA reports, disposition breakdown, QA results summary (average score, compliance fails), agent headcount vs contracted.
Recordings: search by date/disposition/phone (masked), permission-gated playback with visible watermark ("Viewed by A. Bello, Bank X, 26 Sep 2026 14:02 WAT"), no download by default, request access flow.
Approvals: review and approve new scripts or campaign changes.
Invoices & usage: usage statements per programme (minutes, contacts, WhatsApp messages).

States: no access to recordings, data delayed banner, first login onboarding tour.
```

### Prompt 24 — Mobile app screens
```
Using the Kasuwa design system, design the Kasuwa mobile app (Android-first, 360×800, light/dark, data-saver aware).

Screens: bottom navigation (Home, Inbox, Records, Calls, More); Home with today's tasks and AI next actions; Inbox list and WhatsApp-style thread; Contact record (compact 360° with quick actions call/WhatsApp/SMS/directions); Deal Kanban swipe view; Create lead quick form (with business card scan); Field check-in (map, photo, notes); Call log with click-to-call via SIM or VoIP; Notifications; Offline sync centre (queued changes list, conflicts to resolve, last sync time, "Sync on Wi-Fi only" toggle); Settings with Data-saver mode and language.

States: offline mode banner, sync conflict resolution sheet (choose mine/theirs per field), low storage warning, push permission prompt. Use large touch targets and minimal imagery.
```

### Prompt 25 — AI assistant surfaces
```
Using the Kasuwa design system, design Kasuwa Intelligence AI surfaces consistently across the product.

1) Global AI side panel (Cmd/Ctrl+J): chat with context of current record/page, suggested prompts ("Summarise this account", "Draft WhatsApp follow-up in Pidgin", "Which deals are at risk?"), answers with citations to records/KB, action buttons (create task, update field) requiring confirmation.
2) Inline cards: record summary, call summary under recordings, reply drafts in composer with language/tone chips and "Regenerate", next-best-action list with reasons.
3) Real-time agent assist during calls/chats: live transcript, detected intent, suggested answers from KB, compliance checklist ticking off, sentiment meter.
4) AI agent monitor (v2): list of AI-handled WhatsApp conversations, resolution status, handoff reasons, cost per resolution, "Take over" button.
Design patterns for transparency: "AI-generated – review before sending" label, confidence indicators, feedback thumbs, data-use notice, admin toggle state when AI disabled.

States: AI credits exhausted, low-confidence answer, content blocked by policy, AI off for tenant.
```

### Prompt 26 — Notifications
```
Using the Kasuwa design system, design the Notification system: bell dropdown, full notification centre, toasts, and notification preferences.

Types: assignment, @mention, approval request (with inline Approve/Reject), SLA warning, campaign completed, import finished, payment received (₦ amount), e-invoice failed, security alert. Group by day, filters (Unread, Mentions, Approvals), mark all read.
Preferences matrix: event types × channels (in-app, email, push, WhatsApp, SMS) with quiet hours and digest options.
Mobile push notification designs.

States: empty, many unread (99+), critical alert styling.
```

### Prompt 27 — Global search & command palette
```
Using the Kasuwa design system, design Global Search and the Command Palette.

Search: top-bar input (/ shortcut), instant results grouped by object (Contacts, Accounts, Deals, Tickets, Conversations, KB), phone-number-aware search (typing 0803… matches +234803…), recent items, filters by object/owner/date, full results page with facets. Programme scope indicator for BPO users.
Command palette (Cmd/Ctrl+K): actions ("Create lead", "Call last contact", "Switch programme", "Go to wallboard", "Toggle low-bandwidth mode"), navigation, AI ask.

States: no results (suggest creating record), searching skeleton, restricted results hidden with count note.
```

### Prompt 28 — Import/export & data management
```
Using the Kasuwa design system, design Data Management: Import wizard, Migration from Zoho/Salesforce, Duplicate management, Export centre, and Data-subject requests.

Import wizard: upload CSV/Excel (resumable upload with progress for slow connections), object choice, field mapping with auto-match and saved templates, phone normalisation preview (0803… → +234 803…), dedup rules (match on phone/email), validation errors preview, run in background with notification.
Migration: connect Zoho CRM or Salesforce via OAuth, select objects, mapping review including Blueprint → stage-gates and custom fields, dry run report, progress per object, rollback option.
Duplicates: side-by-side merge with field pickers.
Export centre: requests list with approval status and audit note.
DSAR: request intake (access/erasure/correction), identity verification, data package preview, due date countdown.

States: file too large, mapping incomplete, migration partial failure with downloadable error log.
```

### Prompt 29 — Integrations marketplace
```
Using the Kasuwa design system, design the Integrations Marketplace and integration detail pages.

Marketplace: categories (Messaging: WhatsApp, Africa's Talking, Termii, Infobip, Twilio; Payments: Paystack, Flutterwave, Monnify, Interswitch, Remita, M-Pesa, MTN MoMo; Identity/KYC: Smile ID, Youverify, Dojah, VerifyMe; Accounting: Zoho Books, QuickBooks, Sage, Odoo; Productivity: Google Workspace, Microsoft 365, Slack, Teams; Automation: Zapier, Make, Webhooks, MCP), search, filters (Installed, Free, Built by Kasuwa, Partner), cards with logo placeholder, rating, install count.
Detail page: description, permissions requested (scopes), pricing, setup steps, connection status, logs (last sync, errors), disconnect.
Developer section: API keys, OAuth app registration, webhook endpoints with delivery logs and replay.

States: not installed, installing, connected, error (token expired), plan upgrade required.
```

### Prompt 30 — WFM-lite: schedules & adherence
```
Using the Kasuwa design system, design Workforce Management (lite): Schedule planner, Agent schedule view, and Adherence monitor.

Planner: week grid by agent with shifts, breaks, lunches, training; programme colours; drag to create/modify shifts; staffing requirement line from Erlang C calculator (inputs: forecast volume, AHT, service level target) vs scheduled; publish schedule; swap requests approval.
Agent view (mobile): my week, upcoming break, request swap/leave.
Adherence: real-time table of agents (scheduled activity vs actual state, adherence %, out-of-adherence minutes), alerts, daily summary.

States: understaffed interval (red band), unpublished changes, public holiday.
```

### Prompt 31 — USSD & chatbot flow builder
```
Using the Kasuwa design system, design the USSD Menu Builder and the Chatbot Flow Builder.

USSD builder: tree editor of menus (max 182 characters per screen with live counter), options 1–9, input nodes (e.g., enter account number), actions (create lead, check ticket status, request callback), session timeout indicator, feature-phone preview mockup showing *347*123# session, analytics (sessions, drop-off per menu).
Chatbot builder (WhatsApp/web chat): nodes (message, buttons, list, question, condition, AI answer from KB, handoff to agent, collect payment), channel-specific previews (WhatsApp interactive buttons max 3), test console, language variants.

States: text too long for USSD, unreachable node warning, bot paused.
```

---

# Caveats

- **Pricing volatility:** vendor list prices change often. Salesforce raised Enterprise and Unlimited list prices by "an average of 6%" on 1 August 2025, per its newsroom, and HubSpot runs rotating promos. Pipedrive plan names and prices conflict across sources, and prices for several vendors in Table B were not verified. Re-check official pages before using figures in sales material.
- **Matrix cells** reflect synthesis of vendor documentation and third-party reviews, not hands-on testing of every tier. Validate critical cells (e.g., WhatsApp native vs add-on, portal capabilities) before competitive claims.
- **WhatsApp rates** differ between sources ($0.0516 vs about $0.062 for Nigerian marketing messages)\[14\]\[15\] because Meta updates rate cards. The 1 October 2026 service-message changes are imminent as of this writing. Build rate cards as configuration.
- **E-invoicing timelines** for medium and small taxpayers are NRS guidelines, and sources differ on go-live vs enforcement dates. Some secondary sources mention Peppol BIS 3.0 format, which should be confirmed against NRS technical specs.
- **Legal points** need confirmation by Nigerian counsel before launch: NDPA/GAID transfer rules, NCC telemarketing and licensing requirements, DCPMI tier fees, and breach-notification timing. The report flags where sources are secondary.
- **BPO market figures** ($286.8 million and 16,540 workers) come from Knowledge Executive's 2021 benchmarking report and are dated. The Statista 2029 figure is a projection.
- **Local SMS prices** are aggregator-advertised rates. Official Africa's Talking/Termii per-SMS NGN prices were not retrievable.
- **Some sources are low-authority** (vendor blogs, SEO roundups such as claims of a "Gartner Africa CRM Pulse"), and statistics from them were excluded. News of AFRICLOUD's Lagos region comes from smaller outlets and should be verified before relying on it.
- **Claude Design** is a research-preview product. Its features (design-system import, code round-trip) are evolving, so adapt prompts to the current interface.

## Sources

1. [Salesforce Pricing 2026: Plans, Add-Ons & Hidden Costs](https://saascrmreview.com/salesforce-pricing/)
2. [Zoho CRM Pricing (2026) | CodeStringers](https://www.codestringers.com/articles/zoho-crm-pricing)
3. [HubSpot Pricing 2026: Plans, Seats, Contacts & Real Costs](https://saascrmreview.com/hubspot-pricing/)
4. [HubSpot Pricing Explained in 2026: What You Actually Pay at Each Tier » Benjamin Preston](https://benjaminpreston.com/hubspot-pricing-2026/)
5. [Dynamics 365 Sales 2026: Pricing, Features & Alternatives](https://www.cynoteck.com/blog-post/dynamics-365-sales-pricing-features-alternatives)
6. [Pipedrive Pricing 2026: Plans, Add-Ons, and Limits](https://axisconsulting.io/pipedrive-pricing-plans/)
7. [Twenty | #1 Open Source CRM](https://twenty.com/)
8. [Salesforce Agentforce Pricing Breakdown: \$125-\$650 Per User Reality Check](https://www.oliv.ai/blog/salesforce-agentforce-pricing-breakdown)
9. [Sales Pricing | Microsoft Dynamics 365](https://www.microsoft.com/en-us/dynamics-365/products/sales/pricing)
10. [Genesys Pricing: Complete Breakdown & Best Plans for 2026](https://www.alpharun.com/blog/genesys-pricing)
11. [Genesys Cloud Pricing 2026: Full Breakdown | Platform28 Blog](https://www.platform28.com/blog/genesys-cloud-pricing-guide)
12. [14 Five9 Alternatives for Contact Centers in 2026](https://www.bluetweak.com/blog/five9-alternatives)
13. [Pricing on the WhatsApp Business Platform | Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
14. [WhatsApp will charge businesses per message, starting October 1](https://techpoint.africa/insight/techpoint-digest-1414/)
15. [Nigeria WhatsApp API Pricing 2026 — Marketing \$0.0516 - Ominiflow](https://ominiflow.com/whatsapp-api-pricing/nigeria)
16. [WhatsApp Pricing, Billing & Rebilling Guide for HighLevel : HighLevel Support Portal](https://help.gohighlevel.com/support/solutions/articles/155000001428-whatsapp-pricing-billing-and-rebilling-guide)
17. [Nigeria | Jurisdictions | DataGuidance](https://www.dataguidance.com/jurisdictions/nigeria)
18. [Nigeria: NDPC Issues GAID – Key Compliance Insights | Privacy Matters](https://privacymatters.dlapiper.com/2025/06/nigeria-ndpc-issues-gaid-key-compliance-insights/)
19. [General Application and Implementation Directive (GAID) of the Nigeria Data Protection Act - Nigeria | Regulations.AI - The Site on AI Laws and Regulations | Regulations.ai](https://regulations.ai/regulations/RAI-NG-NA-GAIGNXX-2025)
20. [Proven Nigeria E-Invoicing Compliance: Best NRS MBS Guide 2026](https://orchidatax.com/countries-compliance/nigeria-e-invoicing-compliance/)
21. [Do-Not-Disturb (DND) Service in Nigeria - NCC Consumer Portal](https://consumer.ncc.gov.ng/articles/111-do-not-disturb-dnd-service-in-nigeria)
22. [Lagos launches first AWS Local Zone in Africa](https://www.connectingafrica.com/cloud-networking/lagos-launches-first-aws-local-zone-in-africa)
23. [Cloud Regions, Zones & PoPs in Nigeria: AWS, Azure, GCP Explained](https://medium.com/@moore.ugo/cloud-regions-zones-pops-in-nigeria-aws-azure-gcp-explained-7179a6643d54)
24. [AFRICLOUD Opens Lagos Cloud Region as Local-Currency Payments Expand Across Africa](https://www.techcrier.com/2026/09/africloud-opens-lagos-cloud-region-as.html)
25. [Top CRM Software for Nigerian Entrepreneurs: A Definitive Guide](https://crm.africa/top-crm-software-for-nigerian-entrepreneurs/)
26. [Startup Stack - Assessing Top CRM Tools for African Small and Startup Businesses | Business Tech Africa](https://www.businesstechafrica.co.za/technology/2026/06/12/startup-stack-assessing-top-crm-tools-for-african-small-and-startup-businesses/)
27. [Top 5 CRM Tools for Nigerian Startups - Revwit](https://www.revwit.com/top-5-crm-tools-for-nigerian-startups/)
28. [Deploy & Host Twenty CRM | Railway](https://railway.com/deploy/twenty-crm--twenty-crm-railway)
29. [Twenty CRM Review: The Open Source HubSpot Alternative — The Times of Claw](https://www.dench.com/blog/twenty-crm-review)
30. [Best Online Payment Gateways in Nigeria (Fees & Picks)](https://awajis.com/online-payment-gateways-in-nigeria/)
31. [Salesforce Pricing: 2026 Editions, Plans and Costs](https://twelverays.agency/blog/salesforce-pricing)
32. [Zoho CRM Pricing 2026: All Plans, Add-Ons and Real Costs](https://meetergo.com/en/magazine/zoho-crm-pricing)
33. [HubSpot’s Sales Hub pricing guide — essential features for every rep](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)
34. [How Much Does HubSpot Cost? Pricing, Tiers, Discounts](https://www.tropicapp.io/glossary/hubspot-price)
35. [Pipedrive Pricing 2026: Plans from \$14–\$79/user/mo](https://costbench.com/software/crm/pipedrive/)
36. [Pipedrive Pricing 2026: Plans, Add-Ons & True Cost](https://www.linkedin.com/pulse/pipedrive-pricing-2026-true-cost-guide-plans-add-ons-boris-tsibelman-yuf9e)
37. [Pipedrive Pricing 2026: All Plans Explained (Which Is Worth It?) | SmartProcessFlow](https://smartprocessflow.com/pipedrive-pricing)
38. [Zoho CRM vs Salesforce: features, pricing, user reviews, and more](https://monday.com/blog/crm-and-sales/salesforce-vs-zoho-crm/)
39. [Zoho CRM Features: Complete Breakdown \[August 2026\]](https://pipeline.zoominfo.com/sales/zoho-crm-features)
40. [Zoho CRM vs Salesforce: Complete Comparison for Sales Teams (2026)](https://www.sybill.ai/blogs/zoho-crm-vs-salesforce)
41. [Zoho CRM vs Salesforce for Mid-Market Teams (2026) | Aaxonix](https://aaxonix.com/resources/zoho-crm-vs-salesforce-mid-market/)
42. [Zoho vs Salesforce CRM (2026): Pricing, Features & Real Implementation Cost Compared](https://www.codleo.com/blog/zoho-vs-salesforce-crm)
43. [Messaging API · Termii Developers](https://developers.termii.com/messaging-api)
44. [How do I get a Sender Id in Nigeria ? | Africa's Talking Help Center](https://help.africastalking.com/en/articles/2257657-how-do-i-get-a-sender-id-in-nigeria)
45. [BulkSMS Nigeria - #1 Premium Bulk SMS Service | Send SMS to All Networks](https://www.bulksmsnigeria.com/)
46. [Bulk SMS Nigeria - SMS API, OTP & SMPP Gateway | eSMS Africa](https://esmsafrica.io/sms/nigeria)
47. [Africa’s Talking – Pricing](https://africastalking.com/pricing)
48. [Rules on Unsolicited Calls and SMS - NCC Consumer Portal](https://consumer.ncc.gov.ng/articles/33-rules-on-unsolicited-calls-and-sms)
49. [NCC bans unsolicited calls, messages](https://www.thenigerianvoice.com/news/216427/ncc-bans-unsolicited-calls-messages.html)
50. [NCC bans unsolicited calls, messages - TheCitizen - It's all about you](https://thecitizenng.com/ncc-bans-unsolicited-calls-messages/)
51. [Unauthorised Use of Telecom Subscriber's Phone Numbers and Other Personal Information by Telemarketers | NCC](https://www.ncc.gov.ng/media-center/public-notices/unauthorised-use-telecom-subscribers-phone-numbers-and-other-personal)
52. [NCC: We'll arrest, prosecute telemarketers illegally accessing customers' data | TheCable](https://www.thecable.ng/ncc-well-arrest-prosecute-telemarketers-illegally-accessing-customers-data/)
53. ["Text stop to 2442": NCC Bans Loan Apps, Marketers From Illegal Use of Subscribers' Phone Numbers - Legit.ng](https://www.legit.ng/business-economy/technology/1553149-text-stop-2442ncc-bans-loan-apps-telemarketers-illegal-subscribers-phone-numbers/)
54. [Nigeria’s Data Protection Act and GAID Are Operationalizing a Modern Data Privacy Regime - Captain Compliance](https://captaincompliance.com/education/nigerias-data-protection-act-and-gaid-are-operationalizing-a-modern-data-privacy-regime/)
55. [NIGERIA DATA PROTECTION ACT: GENERAL APPLICATION AND IMPLEMENTATION DIRECTIVE (GAID) 2025: What Every Business Needs to Know about Nigeria’s Data Protection Directive. - Manifield Solicitors](https://manifieldsolicitors.com/nigeria-data-protection-act-general-application-and-implementation-directive-gaid-2025-what-every-business-needs-to-know-about-nigerias-data-protection-directive/)
56. [Nigeria’s Cross-Border Data Transfer Regulation | Knowledge Base Articles | Jun 9, 2025 | ITIF](https://itif.org/publications/2025/06/09/nigeria-cross-border-data-transfer-regulation/)
57. [Mandatory Registration of Data Controllers and Processors – MWC Legal](https://mwc.legal/mandatory-registration-of-data-controllers-and-processors/)
58. <https://new.kenyalaw.org/akn/ke/act/ln/2021/265/eng@2022-12-31>
59. [Kenya Data Protection Act No. 24 - ICNL](https://www.icnl.org/resources/library/kenya-data-protection-act-no-24)
60. [Data Privacy Comparative Guide - - Kenya](https://www.mondaq.com/privacy/1190020/data-privacy-comparative-guide)
61. [The Data Protection (General) Regulations, 2021 - Kenya Law](https://new.kenyalaw.org/akn/ke/act/ln/2021/263/eng@2022-01-14)
62. [Data Protection Act - Kenya Law](https://new.kenyalaw.org/akn/ke/act/2019/24/eng@2022-12-31)
63. [Transfers of personal information outside South Africa - Michalsons](https://www.michalsons.com/focus-areas/privacy-and-data-protection/transfers-of-personal-information-outside-south-africa)
64. [Section 69 Direct marketing by means of unsolicited electronic communications - POPIA](https://popia.co.za/section-69-direct-marketing-by-means-of-unsolicited-electronic-communications/)
65. [Direct marketing | Privacy laws - POPI Act Compliance](https://www.popiact-compliance.co.za/popia-information/13-direct-marketing)
66. [Regulator seeks court test to settle whether telemarketing falls under POPIA – Moonstone Information Refinery](https://www.moonstone.co.za/regulator-seeks-court-test-to-settle-whether-telemarketing-falls-under-popia/)
67. [South Africa Protection of Personal Information Act (POPIA)](https://www.entrust.com/legal-compliance/hsm-solutions/emea/complying-south-africas-protection-personal-information-act)
68. [Data Protection FAQs Ghana: Understanding Personal Data - Data Protection Commission](https://dataprotection.org.gh/help-faqs/)
69. [Market Intelligence](https://www.trade.gov/market-intelligence/ghana-information-technologies-data-protection)
70. [Africa Interconnection Report 2025 - Content Hub](https://info.consoleconnect.com/africa-interconnection-report-2025)
71. [Transactions pricing](https://support.paystack.com/en/articles/2130306)
72. [Payment gateways in Nigeria: Paystack vs. Flutterwave vs. Monnifyfor small businesses](https://blog.geeksvillage.com/payment-gateways-in-nigeria-paystack-vs-flutterwave-vs-monnifyfor-small-businesses/)
73. [Paystack vs flutterwave: Paystack vs. Flutterwave: The Ultimate Nigerian Business Payment Gateway Showdown (2026)](https://kudicompass.com/paystack-vs-flutterwave-nigeria-payment-gateway-comparison-2026/)
74. [Paystack Fee Calculator Nigeria 2026 | AfroTools](https://afrotools.com/tools/paystack-calculator/)
75. [Paystack vs Flutterwave: Which is Best for Your Business? - Cordlo](https://cordlo.com/paystack-vs-flutterwave-small-business/)
76. [Paystack vs Flutterwave vs Interswitch: Best Payment Gateway for WordPress in Nigeria - PlanetWeb Solutions](https://planetweb.ng/payment-gateway-for-wordpress-in-nigeria/)
77. [Nigeria e-invoicing under the NRS MBS in 2026: what employers need to know · AnooreHR](https://anoorehr.com/blog/nigeria-e-invoicing-nrs-mbs-2026)
78. [Best CRM for Small Business in Africa: 2026 Buyer's Guide](https://arkesel.com/best-crm-small-business-africa/)
79. [Business Process Outsourcing - Nigeria | Market Forecast](https://www.statista.com/outlook/tmo/it-services/business-process-outsourcing/nigeria)
80. [PCI DSS 4.0.1 for call centres: what you need to do now](https://www.paytia.com/resources/blog/pci-dss-4-0-call-centre-guide)
81. [PCI DSS v4 for US Contact Centers: A Practical Guide](https://www.paytia.com/us/resources/blog/pci-dss-v4-for-us-contact-centers)
82. [PCI Compliant Call Recording: 5 Essential Requirements](https://www.paytia.com/resources/blog/5-essential-tips-for-pci-compliant-phone-payments)
83. [Anthropic ships major Claude Design overhaul with design system imports, code round-trips, and a fix for its token-burning problem | VentureBeat](https://venturebeat.com/technology/anthropic-ships-major-claude-design-overhaul-with-design-system-imports-code-round-trips-and-a-fix-for-its-token-burning-problem)
84. [What Is Claude Design? Anthropic's Tool Explained | AnotherWrapper](https://anotherwrapper.com/blog/what-is-claude-design)
