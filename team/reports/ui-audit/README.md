# UI fidelity audit (D-L193) — gap report and plan

2026-10-20. Every built screen was compared with its Claude Design export, frame by frame.

**How.** Playwright captured every frame of every export at its native size. The exports only draw frames as
they scroll into view, so the script scrolls each one in first. That gave 439 frames across P01–P10, P18 and
P26–P28. It also captured the 30 built routes of `pnpm demo`, signed in as Musa Bello (tenant admin), at 1440,
1024 and 360 in light and dark: 180 shots. Seven read-only reviewers compared the image pairs and the code. The
detailed lists, with design and app values side by side, are in this folder:
[foundations](foundations.md), [p01](p01.md), [p02-p18](p02-p18.md), [p03-p04](p03-p04.md),
[p05-p06](p05-p06.md), [p07-p10](p07-p10.md), [p26-p28](p26-p28.md).

**Headline.** No screen matches. Every built screen has major gaps. The colour tokens and fonts are the one
thing that is right: all 53 semantic colours, light and dark, match v1.1 exactly. Everything built on top of
them drifted:
- **There is no component library.** `packages/ui` holds only tokens, fonts and icons. Each screen hand-rolls
  its controls from copied class strings.
- **The type ramp is incomplete.** The screens mostly use sizes the token ramp doesn't have:
  - text at 13/15/11px;
  - page titles at 28/800;
  - radii of 6/10/14px;
  - controls 36/40px tall.

  Builders rounded every one of these to the nearest token, so every screen came out bigger and looser.
- **The app shell is a different design.** The design has a 72px icon rail; the app has a 224px labelled
  sidebar. The top bar, the phone bar and the admin frame all differ too.
- **The screens are thin versions of the design.** Blocks, columns and states the export shows are missing.

## Gap report, worst first

| # | Screen | Verdict | Worst gaps | Effort |
|---|---|---|---|---|
| 1 | **App shell** (every screen) | Major | Desktop: 224px labelled white sidebar instead of the 72px sunken icon rail (kept at 1024). 64px header with Search/EN/Sign out buttons instead of a 60px header with inline search, Ctrl K and an avatar menu. Phone: the desktop header is kept; the design has a 56px per-screen app bar and a pill bottom nav (Home, Inbox, current object, Deals, More). Admin frame: no tenant switcher or help button; the 288px nav squeezes content at 1024, titles wrap and the audit log scrolls sideways; the 360 header wraps into two rows. | L |
| 2 | **Components** (every screen) | Major | No shared Button, Field, Select, Checkbox, Chip, Pill, Segmented control, Tabs, Table, Avatar, Menu, Dialog, Drawer, Toast, Stepper, Empty state or Kbd. Wrong sizes everywhere (44px controls instead of 36/40/48). Disabled states use opacity instead of the disabled tokens. Native selects and checkboxes are used, and the checkbox is a white box in dark mode. Six overlays wash cream in dark mode (`bg-inverse opacity-60` instead of `bg-scrim`). About 90 icons are missing, there is no filled variant, and icons are sized from the type scale. | L |
| 3 | **P03 Home** | **Not built** | `/` lands on Leads (D-L172: the first live nav entry). No route, widgets, customise mode or role variants. Most widget data comes from modules that are not built yet (tickets, telephony, quota, AI, FX). | XL |
| 4 | **P18 Customisation Studio** | Mostly not built | Only a custom-fields card list exists, inside the admin frame. Not built: object manager, object detail, layout builder, validation rules, relationships, record types. The field editor is an inline form with 6 types; the design has a drawer with 13 types plus Security and Translations tabs. | XL |
| 5 | **P28 Data management** | Major; 3 of 5 sections not built | Migration, Export centre and Data-subject requests are not built. Import and duplicates live under Contacts, not in an admin Data area. The stepper has 4 tiles instead of 5 circles. No object picker, sample-value mapping or Review step. Merge handles 2 records instead of 3. Inactive steps are invisible in dark mode. | XL |
| 6 | **P05 Records** (contact, account) | Major | Two columns instead of three (300 / fluid / 340), with no tablet Insights/Details switch. Missing: the composer with the 24-hour window, AI summary, next best action, related lists, consent history, identity and addresses, account contact tiles and hierarchy. The timeline is mostly field-audit rows. Times show "GMT+1" instead of "WAT". | XL |
| 7 | **P06 Deals** (board, list, detail) | Major | Board: no pipeline menu, summary line, US$ toggle, owner filter, stage %/progress, stale and rotting badges, or collapsed Won column. Columns are 288px instead of 216px. List: 5 columns instead of 9. Detail: columns reversed; no chevron stepper, products/VAT table, risk panel or contact roles. Money shows as "NGN 21,000,000.00" instead of ₦ in mono. | XL |
| 8 | **P01 Auth and onboarding** | Major | The brand panel is missing on 8 states; where it does show it is 1/3 width (design 520px) with a 32px headline (design 44/800). Inputs are 44px instead of 48. Column widths differ. The six code boxes overflow at 360. Phone screens have no compact header or trust footer. Choice chips are rectangles. Lists are stacks of bordered buttons. Onboarding: wrong Back/Skip and stepper. **TOTP bug confirmed** (below). | L |
| 9 | **P26 Notifications** | Major | One 768px column of chips instead of a 240px filter rail with counts, a list card and rich rows (icon tile, object line, Approve/Reject/Reply). The bell opens a bottom sheet instead of a 438px popover. No toasts, security banner or preferences. | L |
| 10 | **P27 Search** | Major | No search field in the top bar, no `/` shortcut, no Commands button. Results have no highlighting, facets, filters or sort. The palette is record search in a dialog, with no commands, Go to, shortcuts, Switch programme or Ask AI. | L |
| 11 | **P07 Activities** | Major | Booking pages and field check-in are not built. Task groups are plain lists, not cards. Rows have labelled buttons instead of a completion circle, avatar and priority pill. Times are US AM/PM. The calendar is day cards instead of a time grid, with no Day view. The log dialog has 2 type chips instead of 5 tabs. The offline banner uses the wrong colours. | L |
| 12 | **P04 Lists** (contacts, leads, accounts) | Major | No count badge, saved views, Kanban/Map/Split switcher, import/export, New lead, checkbox selection, bulk bar or pagination footer. Rows are 60px instead of 52px. Phones are not in mono and have no network/DND badges. Missing columns. Owner shows "Assigned" instead of a name. Contacts clips its Status column at 1440. Phone: boxed cards instead of dense rows; no swipe actions or FAB. | L |
| 13 | **P02 Admin** | Major | Health ring always draws a full circle. Usage meters: 1 of 4. Field security can't tell Read from Edit. Audit log: detail opens inside a narrow cell, every badge is grey, and raw ids show. Roles has no empty state. Programmes: no country, tab counts or Edit. Titles are 32/700 instead of 28/800. | L |
| 14 | **P10 Scripting** | Major | Builder: a padded page with a 384px canvas instead of a full-screen three-column workspace. The palette has no descriptions. Nodes have no type pills, edges no labels, and there is no dot grid. No translation %. A Save button instead of autosave plus a version menu. In-call view: one 768px column instead of two, no collapsed done-steps, no radio grid. | L |
| — | P08 Inbox, P09 Voice | Not built (out of scope) | No built screen to compare. | — |

**Not screenshotted, judged from code:** `/sign-up`, `/sign-up/region` and `/sign-up/verify` return 404
because `self_serve_signup` is off in `pnpm demo`. Error, loading, empty and offline states were judged from
code too. Builders will turn the flag on and shoot every state.

**TOTP bug.** `sign-in-screen.tsx` goes to `/verify?challenge=…` and drops the `methods` list, so the code
screen never learns the SMS delivery hint. As a result "Text a code to" always renders, with an empty number.
The fix: pass the SMS hint through, and render the option only when the challenge offers SMS with a hint.

## Rulings (user, 2026-10-20; recorded as D-L194 to D-L197)

1. **Elements with no backend yet (D-L194).**
   - Build every designed element, so the layout matches the export exactly at every designed width and in
     both themes.
   - Where no backend exists, the element shows the design's own empty or disabled state. It never shows a
     fake number, name or total.
   - Each such element sits behind a per-module feature flag, for example `ai_summary`, `call_bar`, `tickets`,
     `quota`, `fx_display`, `calendar_sync`, `booking_pages`, `field_checkin`, `data_migration`,
     `data_export`, `dsr`. These flags are on in `pnpm demo` and off by default everywhere else.
2. **Earlier cuts stand (D-L195).** Where a cut changes what the screen looks like, the screen uses the
   design's closest visual equivalent: same position, same style. The table below lists every such spot.
3. **P03 Home is built now (D-L196).**
   - Build the Home shell, customise mode and the data-backed widgets (agenda, deals needing attention, recent
     records) for each role layout, at 1440 and 360, light and dark.
   - Widgets with no data source follow ruling 1.
   - After sign-in, the user lands on Home. This supersedes the landing rule of D-L172.
4. **Order (D-L197).** As proposed, with P03 right after P01. Two builders may run at once, but verification
   stays one Docker-backed e2e run at a time on the Mac. The second run goes to the Windows runner.
5. **Kept, styled to the design (lead).** The Workspace field on sign-in, which multi-tenant sign-in needs,
   and the Password field on sign-up.
6. **Not built (lead, CLAUDE.md §6.4).** The design's "You can't open this record" screen names the other
   programme and its owner. An out-of-scope record stays a plain 404, using the design's not-found styling.

### Where an earlier cut changes the screen (closest visual equivalent)

| Screen | Design shows | Cut by | Equivalent to build |
|---|---|---|---|
| P04 lists | Count badge next to the title ("64") | D-P13 | Same badge, with the capped approximate total D-P13 allows ("50+") or no number. Never an exact total. |
| P04 lists | Pagination footer "1–25 of 64 · Page 1 of 3" | D-P13 | Same footer bar, same position: rows-per-page plus prev/next, no "of N" and no page count. |
| P04 lists | Kanban / Map / Split switcher; Map view | D-L69 | Same segmented control. Map segment is shown disabled with the design's tooltip style, behind `map_view`. |
| P04 accounts | Selection checkboxes and bulk bar | T-0057 | Same column and bar. On Accounts, only the actions that are allowed: none today, so the bar is not drawn. |
| P04 leads | Bulk WhatsApp, Merge | T-0058 | Same bar with Assign and Update field (in scope, not yet built); WhatsApp and Merge omitted. |
| P07 activities | Filter chips and bucket counts ("All 10", "High priority 3") | D-P13 | Same chips without counts. |
| P07 activities | Row checkboxes and bulk bar | D-L105 | Not drawn. The row keeps the design's left padding so alignment is unchanged. |
| P07 activities | Queued / Snoozed chips; "View queue (n)" | D-P21 | Same chip styles for the states that exist (Snoozed); no queue count. |
| P07 activities | Calendar sync chips, clash banner, holidays, booking pages | D-P22 | Ruling 1 (`calendar_sync`, `booking_pages` flags; design's not-connected state). |
| P10 run | Call bar, "Writes to record" rail | D-L88, D-P31 | Ruling 1 (`call_bar` flag); "Writes to record" shows the design's empty state. |
| P26 notifications | Counts on the filter rail | D-P13 | Same rail without counts. |
| P26 notifications | One "Assignments" type covering every assignment | T-0099 (one kind per filter) | "Assignments" filters record assignments; a "Tasks" entry right after it filters task assignments. |
| P26 notifications | Tablet "Type [All types ▾]" select | T-0101 I20 (kinds visible as chips at 1024) | The served kinds as pills after a "Type" label, in the select's place. |
| P26 notifications | Row body text and inline actions | D-P29 (no stored text) | Title (the sentence) and object line only; no action on assignment or import rows, as the design draws them. |
| P26 notifications | "13 in the last 90 days", "90 days" in A3 | Not served (D-L146 retention pending) | Subtitle is the bell's capped count; A3 body drops the 90 days. |
| P26 preferences | Personal channel sub-labels, quiet-hour times, chosen digest | No preferences API | Same layout, every control disabled; only the two in-app deliveries that exist are checked. |
| P27 search | Recent searches / recently viewed | D-L133 (R19) | Same panel, showing the design's empty state ("No recent searches"). |
| P27 search | Partial phone-number match strip | D-L133 | Same info strip, showing the existing "type the whole number" guidance in the design's style. |
| P27 search | "3 results hidden…" strip | D-L133 | Not drawn: a hidden-results count is an existence leak. |
| P27 search | Programme scope pill and menu | D-L87 | Ruling 1 (`programme_scope_search` flag). |
| P28 import | Review step stats and error table | D-L128 Q6 | Same step and layout, with the counts the API returns; no invented totals. |
| P03 home | Landing on Home | D-L172 | Superseded by ruling 3. |
| P06 board | "Any amount" and "All territories" filters | R14 (no amount-band or territory filter in the contract) | Same dropdowns, same place: the currency and won-window filters the contract has (T-0135). |
| P06 board | "Won this quarter" and "+7 won earlier this quarter" | D-L88 (won covers `closedSince`, default 90 days) | Same figure and box, labelled "Won since {date}" with the served window; won cards stay listed under the box (T-0135). |
| P06 list | Footer count and totals | R13 (the list holds lost deals the board totals never cover) | Not drawn (T-0135). |
| P06 deal | Commit/Renewal badges, deal number, Forecast category, Territory, Lead source, Type | No such Deal fields | Not drawn; the header carries account and owner, the key fields what the Deal serves (T-0135). |
| P01/1 sign in | Work email straight after the divider | D-L195 | Workspace field kept above it, as a 48px field with its help line. |
| P01/3 sign up | No password; carrier pill ("MTN") in the phone field | D-L195, T-0007b | Password field kept (48px, with help). Joined phone field without the carrier pill. |
| P01/5.1 region | Nigeria "Enterprise", Kenya "Included", both selectable | D-P2, D-P11 | Same cards and tag style; both tagged "Talk to sales" in the Enterprise colours, not selectable, with the sales note. |
| P01/2 two-step | Passkey and backup-code rows always | T-0126, T-0131 | Each row only when the challenge marks the method available. The API has no passkey method, so that row is hidden. |
| P01/6 success | "{Company} is ready", "Go to Inbox", "Take a 2-minute tour", "2 invites sent" | No inbox, tour or invite endpoint | "Your workspace is ready", "Go to Home"; the tour button disabled behind `product_tour`; invites say "on the list", never "sent". |

## Order and tasks

Agent: agent-11-frontend on Opus 5.5, high effort. Usual cycle per task: task file → builder → one combined UI
review → verification → PR → merge. Each PR carries before/after screenshot pairs at every designed width,
light and dark. They are made with `tools/design-parity` and linked from the PR. Byte budgets and the existing
e2e journeys must keep passing. Re-pins follow the existing D-L rules.

**Wave 0. Quick fix (now, alongside Wave 1).**
- T-0126: TOTP — offer "Text a code to …" only when SMS is available and a masked number is on file. S.

**Wave 1. Foundations, in sequence.**
- T-0127: tokens and icons.
  - Add the design's type sizes (11/13/15, title 28/800, display 44/800), radii 6/10/14, control heights
    36/40/48 and icon sizes 15/16/22.
  - Ship the filled icon variant and the ~90 missing icons.
  - Replace `bg-inverse opacity-60` with `bg-scrim`.
- T-0128: component library, part 1 — Button, IconButton, Field, Select, Checkbox, Radio, Switch, Chip,
  Pill, Segmented control, Tabs, Avatar, Kbd. Plus a `/design/components` gallery page.
- T-0129: component library, part 2 — Table, Card, Menu/Popover, Dialog, Drawer, Bottom sheet, Toast,
  Stepper, Empty state, Skeleton, Banner.
- T-0130: app shell.
  - CRM: 72px icon rail; 60px top bar with search pill, Ctrl K and avatar menu; 56px phone app bar and pill
    bottom nav.
  - Admin: tenant switcher, 272px nav, drawer below 1280.

**Wave 2. Screens, two builders at a time.** In order:
1. T-0131 P01 auth and onboarding
2. T-0132 P03 Home (new: route, widget grid, customise mode with a per-user layout table, role layouts,
   landing)
3. T-0133 P04 lists
4. T-0134 P05 records
5. T-0135 P06 deals
6. T-0136 P07 activities
7. T-0137 P26 notifications and bell
8. T-0138 P27 search and palette
9. T-0139 P10 scripting
10. T-0140 P02 admin
11. T-0141 P28 data management (import, duplicates, plus placeholders for migration, export and DSR)
12. T-0142 P18 Customisation Studio (custom fields fully; the other sections as placeholders)

Task files are written one wave ahead, so each one reflects what the previous wave actually shipped.
