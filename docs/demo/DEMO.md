# Kasuwa: local product demo runbook

Everything built in Phase 2, run locally, with synthetic data. Read it once end to end the night before,
and do the "Morning of the demo" checklist an hour before you present.

---

## 1. Prerequisites

| Need | Check |
|---|---|
| macOS with Docker Desktop **already running** | `docker info` prints a server version |
| Node **20.14 or newer** first on `PATH` (nvm's Node 16 breaks the tooling) | `node -v` |
| pnpm 9 | `pnpm -v` |
| The dialler stack **stopped** (one Docker stack at a time, CLAUDE.md) | `docker ps` shows no `dialler-*` |
| Nothing else on ports 3000, 3001, 3002, 3100, 55432, 56379 | see Troubleshooting |
| Chrome or Safari, at 100% zoom, a 1440 px wide window or larger | |

On this Mac, start every terminal with:

```bash
export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

The machine has 16 GB of RAM. Close the dialler, other worktrees' dev servers and test runs before you start.

## 2. One-time setup

```bash
pnpm install --frozen-lockfile
```

That is all. You do **not** need to edit `.env` for the demo: `pnpm demo` turns the flags on itself. `tools/dev.mjs`
creates `.env` from `.env.example` the first time. If you prefer `pnpm dev` (no demo data, no proxy), put this line
in `.env` **and** export it in your shell (the web process does not read `.env`):

```bash
KASUWA_FEATURE_FLAGS_ON=crm_records,crm_accounts,crm_record_view,crm_leads,crm_activities,crm_scripts,crm_pipeline,crm_search,admin_live_api,crm_custom_fields
```

| Flag | What it shows |
|---|---|
| `crm_records` | The CRM shell and the Contacts list |
| `crm_accounts` | The Accounts list |
| `crm_record_view` | The contact (360°) and account records |
| `crm_leads` | Leads table, Kanban and convert |
| `crm_activities` | My tasks and the calendar |
| `crm_scripts` | The script builder and the agent's script run |
| `crm_pipeline` | Pipeline board and list, deal record |
| `crm_search` | `/search` and the Ctrl/Cmd+K palette |
| `crm_custom_fields` | The customisation studio at `/admin/custom-fields` (T-0090) |
| `admin_live_api` | Two admin panels (programme KPIs, skill cover) show **labelled sample data** |

`pnpm demo` adds `crm_custom_fields` automatically whenever the flag exists in `packages/feature-flags`. A new flag
that merges later: add it to `DEMO_FLAGS` in `tools/demo.mjs`, or set `KASUWA_FEATURE_FLAGS_ON` yourself (it then
replaces the list entirely). `self_serve_signup` stays off: its endpoints answer 501.

## 3. Start and stop

```bash
pnpm demo          # start (about 3 minutes; first ever run longer while Docker pulls postgres and redis)
# Ctrl+C           # stop: apps and containers. The data volume is kept.
pnpm demo:down     # stop from another terminal, or clean up after a crash
```

What `pnpm demo` does, in order (log in `demo/logs/dev.log`):

1. Refuses to start if Docker is down, the dialler is running, or a demo port is taken.
2. Runs `tools/dev.mjs`: Postgres and Redis only (OpenSearch and object storage are not read by anything yet;
   `pnpm demo --full` starts them too), bootstrap, migrate, **the test seed** (which truncates first), then the API,
   web, worker and realtime processes. About 30 seconds.
3. Adds the demo data through the real API (`tools/demo-seed.mjs`). About 5 seconds.
4. Starts the demo front door on **http://localhost:3100** (`tools/demo-proxy.mjs`).
5. Opens every screen once headlessly so `next dev` has compiled them (2 to 3 minutes). `--no-warm` skips it, at the
   price of a 5 to 10 second wait on each screen's first open.

When it prints `ready after ...s`:

| URL | What |
|---|---|
| **http://localhost:3100** | **Use this one.** The app with a session (see below) |
| http://localhost:3100/__demo | The user switcher |
| http://localhost:3000 | The raw web app. Do not demo from here: every CRM screen is empty or "not authenticated" |
| http://localhost:3001/health | The API |

### Why port 3100 and not 3000

The web app signs you in for real (password, then a TOTP code) but **does not yet keep the session token** after
the second factor: there is no session cookie or BFF. So in a plain browser every CRM screen calls the API with no
identity. `tools/demo-proxy.mjs` fills that gap for the demo only: it keeps the token from a real sign-in in an
HttpOnly cookie and sends it as `Authorization: Bearer`, or, for a quick user switch, sends the development stub
identity headers. Neither path grants scope: the API still reads programme membership from the database on every
request. This is a known gap for the lead, not something to mention to the audience.

## 4. Who to sign in as

Credentials are the committed **development** fixtures in `packages/db/src/fixtures.ts` (`SEED_TENANTS` for the
emails, `SEED_PASSWORD`, and `SEED_TOTP_SECRETS`). Never real values; never type them into anything but this local
app. For the second factor run `node tools/demo-totp.mjs <role>`, which prints the current six-digit code.

| Role (switcher name) | Person | Tenant (workspace slug) | Sees |
|---|---|---|---|
| `admin` | Musa Bello, tenant admin and supervisor | Sahel BPO (`sahel-bpo`) | Both programmes: Bank X Collections and Telco Y Care; the admin console |
| `agent` | Tunde Adeyemi, agent | Sahel BPO | Bank X Collections only |
| `agent2` | Ngozi Okeke, agent | Sahel BPO | Telco Y Care only |
| `unassigned` | Emeka Nwosu | Sahel BPO | Nothing at all (in no programme) |
| `tenantb` | Wanjiru Kamau, tenant admin | Rift Valley Contact (`rift-valley-contact`) | Another tenant: Kenyan contacts, nothing of Sahel BPO |

Two ways in:

- **For real** (do this once, at the start): http://localhost:3100, workspace `sahel-bpo`, Musa's email and the
  fixture password, then the code from `node tools/demo-totp.mjs admin`. You land on Contacts.
- **Quick switch** (for every later change of user): http://localhost:3100/__demo, click a role. Keep this open in a
  second tab.

## 5. The demo data

On top of the test seed (12 contacts, 4 accounts, 1 deal, 1 script), `tools/demo-seed.mjs` adds, all synthetic:

- **Sahel BPO / Bank X Collections:** 6 accounts (Oshodi Spare Parts Co, Kano Groundnut Traders, Aba Leatherworks,
  Onitsha Textiles Hub, Lekki Fresh Foods, Ibadan Agro Inputs) with industry, tier, state and LGA; 12 contacts across
  every lead status, sources (WhatsApp, USSD, missed call, referral, walk-in, web form), consent states and tags;
  8 deals in NGN spread over Qualified, Discovery, Proposal, Negotiation, Contract, Won and Lost, moved through the
  real stage gates; 5 dispositions (PTP, PAID, CALLBACK, DISPUTE, NO_ANSWER); a published script, **"Bank X:
  promise-to-pay call"** (greeting, NDPA recording notice, right-party check, promise form in NGN, three endings
  with suggested dispositions).
- **Sahel BPO / Telco Y Care:** 2 accounts, 5 contacts, 2 deals, the same dispositions.
- **Rift Valley Contact:** 3 Kenyan contacts.
- **Activities:** per contact a call, a note and a task (overdue, today or upcoming) or a meeting; per account a
  review meeting this week; per deal a note and a call on the deal timeline. Dates are relative to when you start,
  in WAT.

Phone numbers are padded synthetic `+234 803 123 05xx` / `+254 712 340 5xx`; emails are `@customer.example`.
No BVN, NIN or real person. Re-running the seed adds nothing (`pnpm demo:seed`).

## 6. The demo script (25 to 30 minutes)

Open http://localhost:3100 in one tab and http://localhost:3100/__demo in another.

### 1. Sign in and the shell (2 min) as `admin`, for real

- Show the sign-in: workspace slug, email, password; the language menu on the sign-in screen; then the TOTP step.
- You land on **Contacts**. Point at the shell: nav, Search, the language menu, the low-bandwidth switch.
- *Talking points:* MFA for every user from day one; the "Data stored in: South Africa" badge (in the admin console)
  is the data-residency story for NDPA; multi-tenant, with each BPO client a **programme**.

### 2. Contacts and the 360° view (4 min) as `admin`

- The list: the **"Your programmes"** badge and its sentence; phone numbers in `+234` format; the WhatsApp opt-in
  icon; filters (Status, Source, Owner, DND, WhatsApp opt-in); Columns.
- Open **Babatunde Alabi**: details, owner with "Assign to me", status, and the timeline of calls, notes, tasks and
  the deal note.
- Add a note from the timeline ("Customer confirmed on WhatsApp").
- *Talking points:* WhatsApp and USSD as first-class sources; consent state (NDPA) is a field and its changes are
  audited; DND is a filter because promotional traffic to DND numbers is illegal (NCC).

### 3. Leads, the Kanban and conversion (3 min) as `admin`

- **Leads**: the table, then **Board**: New, Contacted, Qualified, Unqualified. Drag a card from New to Contacted
  (or use its Move button).
- Back to the table, **Convert** on **Hauwa Lawan** (Telco Y Care): "A new account", name it, Convert. The row shows
  "Converted".
- *Talking point:* a lead is a contact at a lead stage, not a copy; converting qualifies it and links an account in
  one transaction, audited.

### 4. Accounts (2 min) as `admin`

- **Accounts** list: industry, tier, state and LGA (Nigerian states and local government areas).
- Open **Lekki Fresh Foods**: details, its contacts, and its timeline including deal activity.

### 5. Activities (2 min) as `agent`

- Switch to `agent` (Tunde). **Activities → My tasks**: Overdue, Today, Upcoming. Snooze one; mark one done.
- **Calendar**: week and month; the account review meetings and branch visits.
- *Talking point:* times are shown in the user's zone (WAT here); BPO rosters span WAT, EAT and SAST.

### 6. Pipeline and deals, with a gated move (4 min) as `admin`

- **Deals** → the first **B2B sales** (Bank X Collections; the second one is Telco Y Care, see Limitations).
- Board: column totals and weighted totals in **NGN**, filters (owner, currency, closing dates, won in), then **List**.
- On **Oshodi Spare Parts: POS terminals and settlement** (Proposal) click **Move stage → Negotiation**: the stage
  "Has requirements". The prompt lists Amount (done), Expected close date (done) and the check "Quote sent to the
  customer"; **Move deal** stays disabled until it is ticked. Tick it, move.
- Open **Kano Groundnut Traders: harvest working capital**: the stage bar with locked (gated) stages, key fields,
  weighted amount, and the deal timeline.
- *Talking points:* money is stored in minor units with its currency, never converted, never a float; stage gates
  enforce the sales process on the server, not just in the browser.

### 7. Search and the palette (2 min) as `admin`

- Press **Cmd+K** (Ctrl+K on Windows), type `Ada`: Adaeze Okafor. Enter opens her.
- **Search** in the header, type `Kano`: the account and two deals, with "See all matching ..." links.
- *Talking point:* search only ever returns what your programmes allow; a phone number or email is looked up in the
  request body, never in a URL (so it never lands in logs).

### 8. Scripts (3 min)

- As `admin`: **/scripts** → **Bank X: promise-to-pay call**. The map of steps; the compliance step (orange); the
  translation chips (Français, Pidgin, Hausa, Yorùbá, Igbo, Kiswahili); Versions.
- Switch to `agent`. Open **Kelechi Obiora** → **Start script** → click **Bank X: promise-to-pay call**. Walk it:
  the greeting with his name and the agent's filled in; the NDPA recording notice must be acknowledged; "Confirmed";
  "Yes, this week"; fill the promise (amount in NGN, date, channel); the end suggests **Promise to pay**.
- *Talking points:* compliance statements cannot be skipped and are timestamped; the disposition is suggested by
  the script; telephony stays with the existing platform (we integrate, we do not replace the dialler).

### 9. Admin console and field security (4 min)

- As `admin`, open http://localhost:3100/admin (there is no link to it from the CRM shell yet). Admin home (setup health, recent admin
  changes); **BPO → Programmes → Bank X Collections**: Overview (the KPI tiles are marked **Sample data**), Agents
  and skills, SLA, Dispositions (the five codes), Scripts, Retention, Portal users. **Roles hierarchy**. **Audit log**
  (every change you just made is there).
- **Users and access → Field-level security** → tab **Contact**: on the **Emails** row, click the **eye** (read) in
  the **Agent** column; both read and edit switch off. **Save changes**.
- Switch to `agent`, open **Contacts**: the Email column shows a lock and **Restricted** on every row.
- Switch back to `admin` and restore it (or restart; a restart resets everything).
- *Talking points:* one matrix per tenant, applied per programme through the permission set a person holds there;
  a hidden field is hidden everywhere: lists, records, search, exports and the API; every cell change is audited.

### 10. BPO isolation (1 min)

- Switch to `agent2` (Ngozi, Telco Y Care only): Contacts and Deals show only Telco Y Care.
- Switch to `unassigned`: "No contacts yet", nothing anywhere.
- Switch to `tenantb`: a different company entirely, Kenyan numbers.
- *Talking point:* the database decides scope on every request (row-level security, forced); the browser never
  says which programmes it may see.

### 11. Languages and RTL (2 min) as `admin`

- Language menu: **Français**, then **Hausa**. Note the Beta badges (unreviewed translations are labelled, never
  half-translated).
- Arabic is not on the menu (no reviewer yet) but previews on any page: add `?locale=ar`, e.g.
  http://localhost:3100/contacts?locale=ar. The whole layout mirrors, the nav moves right, phone numbers stay
  left-to-right.
- Switch back to **English** from the menu before moving on (the choice is kept in a cookie).
- **Low-bandwidth mode**: the switch at the far right of the header.
- *Talking points:* built for 256 kbps with 300 ms latency, first screen under a strict byte budget; fonts carry
  ₦ and ₵; Nigerian Pidgin, Hausa, Yorùbá, Igbo and Kiswahili alongside English and French.

### 12. Custom fields: the customisation studio (3 min) as `admin`

http://localhost:3100/admin/custom-fields (Admin → Customisation → Fields), tab **Contacts and leads**.

1. **New field** → Label `Repayment plan` (the api name `repayment_plan__c` fills itself), Type **Picklist**,
   values `Weekly`, `Monthly`, `Lump sum` (Add a value for each) → Save.
2. **New field** → Label `Outstanding balance`, Type **Currency**, Currency **NGN** → Save. (Save without a currency
   to show the validation.)
3. **Edit** on Repayment plan → change the label to `Agreed repayment plan` → Save ("Changes saved").
4. **Edit** on Outstanding balance → Classification **Sensitive**: the warning appears ("Existing access does not
   change ... review the field-security matrix") → Save. The row shows a **Sensitive** tag.
5. **Retire** on Outstanding balance → the dialog explains it cannot come back and the api name stays taken →
   **Retire field**. Tick **Show retired fields** to show it greyed with a **Retired** tag.

- *Talking points:* type and api name are fixed at creation, picklist values can be added and relabelled but never
  removed (records keep their data); classification only goes up, and access is reviewed in the field-security
  matrix (link at the top).
- **Coming next (T-0091, not merged):** showing and editing these values on the contact, account and deal screens.
  Say so; do not look for the field on a record.
- Rehearsed this already? Restart first (`Ctrl+C`, `pnpm demo`): a retired api name stays taken until the reset.

## 7. Known limitations: avoid in the demo

| Avoid | Why |
|---|---|
| Demoing from http://localhost:3000 | No session in the browser yet; use :3100 |
| **Home, Inbox, Tickets, Reports** in the CRM nav; most admin groups (Channels, Data, Compliance, Automation, Integrations, Billing, Company) | Not built in Phase 2 (placeholders) |
| **Import** and **Connect WhatsApp number** buttons | Disabled: import and capture come later |
| The admin console as an **agent** | Admin reads are open to every tenant user today (writes are gated, the audit log included, T-0032 / D-L48). Show the admin console only as `admin` |
| Opening the script builder as an agent | A real 404 by design (agents run scripts, they do not author them) |
| The pipelines index | Both programmes' pipelines are called "B2B sales" and the list does not say which is which. The first is Bank X Collections |
| Timeline "changed" lines | Field changes say "The value is not shown"; account creation reads as several "changed" lines |
| "Owner: Assigned" and "Account: Linked" on the contacts list | The list shows a state, not the name; open the record for names |
| Arabic from the language menu | Not on the menu (no named reviewer). Use `?locale=ar` |
| Sign-up links / `/sign-up` | Self-serve sign-up is off (endpoints not built) |
| Custom-field values on records | T-0091, coming next |
| Dashboards, notifications, import, dedupe | Later Phase 2 slices |
| The first open of a screen not in the warm-up (e.g. a script run) | `next dev` compiles it: up to 10 s. Rehearse it once after `pnpm demo` |

## 8. Reset to a clean demo state

```bash
# Ctrl+C in the demo terminal (or pnpm demo:down), then:
pnpm demo
```

Every start truncates and re-seeds, then re-adds the demo data with fresh dates. Allow 3 minutes.
To wipe the database volume too (rarely needed): `docker compose down -v` before `pnpm demo`.

## 9. Morning of the demo

1. Close the dialler (`docker ps` shows no `dialler-*`), other dev servers and test runs.
2. `pnpm demo`; wait for `ready`.
3. `pnpm demo:smoke`: walks every screen as `admin`, `agent` and `unassigned` and prints a table (the 404 rows for
   `unassigned`, the agent's script builder, and every record row for `tenantb` are expected). Screenshots go to
   `demo/screenshots/` (git-ignored).
4. Sign in for real once as `admin`, rehearse steps 8 (script run) and 12 (custom fields) once, then **restart**
   (`Ctrl+C`, `pnpm demo`) so the audience sees a clean state.
5. Browser: 100% zoom, one tab on http://localhost:3100, one on http://localhost:3100/__demo. Close the Next.js
   dev badge (the round "N" bottom left) if it distracts.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is not running` | Start Docker Desktop, wait until it says running, retry. Do not restart it mid-demo |
| `The dialler stack is running` | Stop it from its own project (`docker compose down` there) |
| `Port 3000 (web) is already in use` (or 3001, 3002, 3100) | `pnpm demo:down`; if it persists, `lsof -nP -iTCP:3000 -sTCP:LISTEN` and stop that process |
| `kasuwa-postgres` name already in use | Another checkout's stack is up: run `docker compose down` in that checkout |
| `Unsupported engine` warnings, or odd syntax errors | Node is too old: `node -v` must be 20.14+; put `/usr/local/bin` first on `PATH` |
| Screens say "not authenticated" or show nothing | You are on :3000, or the demo cookie expired (12 h): use :3100 and switch user at `/__demo` |
| Sign-in: the code is rejected | The code changes every 30 s; run `node tools/demo-totp.mjs admin` again and type it straight away |
| Sign-in: "account locked" | Too many wrong attempts. Restart (`pnpm demo`) clears the lockout |
| A screen hangs on first open | `next dev` is compiling; wait 10 s. Run the warm-up: `pnpm demo:smoke` |
| `demo-seed: ... answered 4xx` | Read the error code; the stack still works with the plain test seed. Restart to retry |
| Machine slow, fans loud | Stop other stacks and test runs; `pgrep -fl vitest`, `pgrep -fl next-server`, `pgrep -fl "tsx src/main"` |
| After the demo | `Ctrl+C` (or `pnpm demo:down`), then check `docker ps` and `pgrep -fl next-server` are clean |
