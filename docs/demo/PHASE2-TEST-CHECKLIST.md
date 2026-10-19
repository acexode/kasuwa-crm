# Phase 2: hands-on test checklist

A walk-through for testing Phase 2 by hand in the local demo. It takes about 45 minutes. Start the demo and sign in as
described in [DEMO.md](DEMO.md), sections 3 and 4. Use exactly **http://localhost:3000**.

Sign-in, for every person:
1. Enter the workspace slug.
2. Enter the email.
3. Enter the password `correct-horse-battery-staple`.
4. Enter the code from `node tools/demo-totp.mjs <role>`, run in the repo folder.

| Role | Person | Workspace | Email |
|---|---|---|---|
| `admin` | Musa Bello (tenant admin) | `sahel-bpo` | musa.supervisor@tenant-a.test |
| `agent` | Tunde Adeyemi (Bank X only) | `sahel-bpo` | tunde.agent@tenant-a.test |
| `agent2` | Ngozi Okeke (Telco Y only) | `sahel-bpo` | ngozi.agent@tenant-a.test |
| `unassigned` | Emeka Nwosu (no programme) | `sahel-bpo` | emeka.unassigned@tenant-a.test |
| `tenantb` | Wanjiru Kamau (another company) | `rift-valley-contact` | wanjiru.agent@tenant-b.test |

Tick each box as you go. Whenever something looks wrong, note the screen, the person and what you did.

---

## 1. Sign-in and session (T-0125)

- [ ] Sign in as **admin**. After the code you land in the app, not back on sign-in.
- [ ] Reload the page. You stay signed in.
- [ ] Open a second tab on http://localhost:3000. You are signed in there too.
- [ ] **Sign out** at the top right. You return to sign-in, and the browser's back button does not show data.
- [ ] Narrow the browser to phone width, about 360 px. The header doesn't scroll sideways, and sign-out sits behind the
      account button.
- [ ] A wrong code is refused with a clear message. Several wrong tries are throttled.

## 2. Who sees what (tenancy and programmes)

- [ ] As **agent** (Tunde), Contacts shows only Bank X Collections contacts.
- [ ] As **agent2** (Ngozi), Contacts shows only Telco Y Care contacts, none of Tunde's.
- [ ] As **unassigned** (Emeka), the lists are empty and records open as "not found". There is no error page.
- [ ] As **tenantb** (Wanjiru), only the Kenyan contacts appear, nothing from Sahel BPO.

## 3. Contacts, display names and search (T-0124)

- [ ] As **admin**, Contacts lists names, and a contact record opens with its timeline.
- [ ] Typing a **name** in the Contacts search filters the list.
- [ ] Typing a **phone number or email** in the Contacts or Leads search does not filter. A hint points you to number
      lookup instead, and the number does not appear in the address bar.
- [ ] The Leads list offers sorting by created or updated date, not by name.
- [ ] Ctrl/Cmd+K opens the palette, and number lookup from `/search` finds a contact by phone.

## 4. Duplicates and merge (T-0095, T-0097)

- [ ] As **admin**, open **Contacts → Duplicates** (`/contacts/duplicates`). Duplicate sets appear for a programme.
- [ ] Pick two contacts in a set and choose **Review**. A side-by-side comparison appears, with the main record
      selectable.
- [ ] Choose a value per field, then **Merge**. A confirm dialog appears first.
- [ ] After merging you see the result, a link to the surviving contact and **Undo**.
- [ ] The merged-away contact is gone from Contacts.
- [ ] **Undo** restores it. Back on Duplicates, the list is fresh.
- [ ] The **Audit log** (admin) shows the merge and the restore.
- [ ] As **agent**, a merge attempt is refused politely.

## 5. Notifications (T-0100, T-0101)

- [ ] As **admin**, the bell appears at the top of the CRM and admin screens.
- [ ] In one browser profile as **admin**, change a contact's or a deal's **owner** to **Tunde**.
- [ ] Sign in as **agent** (Tunde), using another Chrome profile or sign out first. Within about a minute his bell
      shows an unread count.
- [ ] Opening the bell shows "assigned to you" with the record's name. Clicking it opens the record and marks it read.
- [ ] `/notifications` lists them. **Mark all read** clears the count.

## 6. CSV import (T-0094, T-0096)

- [ ] As **admin**, **Contacts → Import** (`/contacts/import`) shows the four-step wizard and the import history.
- [ ] **Known limitation:** uploading a file needs object storage and a bucket setting that is an infrastructure
      follow-up (T-0005). In this demo, expect the upload step to fail. The rest of the wizard can't be tested by
      hand yet.

## 7. Custom fields (T-0088–T-0091)

- [ ] As **admin**, **Admin → Custom fields** (`/admin/custom-fields`). Create a text field on Contact, relabel it,
      then retire it.
- [ ] A contact record shows a custom field's value, and editing it saves.

## 8. Everything else from earlier Phase 2 work

- [ ] **Accounts:** the list, an account record and its contacts.
- [ ] **Leads:** the table, the Kanban board, and converting a lead.
- [ ] **Activities:** my tasks and the calendar.
- [ ] **Pipelines:** the board and dragging a deal between stages. A deal record opens.
- [ ] **Scripts:** the script builder (admin), and an agent running a script against a contact.

---

### Known limitations in this build (not bugs)

- **CSV upload:** needs storage infrastructure (T-0005).
- **Translations:** the seven non-English languages are drafts that a fluent speaker hasn't reviewed.
- **Admin sample panels:** the programme KPI and skill-cover panels show **labelled sample data** (`admin_live_api`).
- **First open of a screen:** with `pnpm demo --no-warm`, it can take 5–10 seconds while the dev server compiles it.

When you're done, send back your notes. Phase 3 doesn't start until you say so.
