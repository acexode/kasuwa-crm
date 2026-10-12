# Resume here (2026-10-12 evening, moving to a new machine)

The lead session is moving from the Windows laptop to a MacBook (1 TB disk, 16 GB RAM). A fresh session starts from this
file. Everything is on GitHub; nothing exists only on the old laptop.

## 1. Merged today
- #114 T-0117 (test admin inert)
- #115 T-0081 (activities contract)
- #116 T-0114 (script runs)
- #117 T-0104 (audit events)
- #118 T-0082 (activities API)
- #119 T-0105 (pipeline contract)

Their reports are filed.

## 2. Built, waiting for verification (do these first, one at a time)

| Task | Branch to verify | Next |
|---|---|---|
| T-0084 list indexes | PR #120, `agent3/T-0084-list-indexes` | Reviews passed and fixes are in (D-L116); the builder's runs are green. Targeted verify, then merge. Its migration is 0035. |
| T-0083 activities screen | `lead/T-0083-budget` (the builder's commits, the lead's spec fix and the 236,000 B budget re-pin, D-L118, and the report) | Open the PR from this branch. One combined review (UI only). Verify with `--files tests/acceptance/records-ui/activities-screen.acceptance.test.ts` plus the other records-ui suites (the nav changed). |
| T-0115/T-0116 script screens | `lead/T-0115-T-0116-pins` (the builder's commits, the lead's list-test fix and the budgets 250,000/240,000, D-L119, and the report) | Not yet run: records-ui `contact-record` (it gained "Start script"; re-pin `/contacts/[id]` within 5% of measured, at most 245,000), integration and tenancy. Open the PR, one combined review, verify. |
| T-0106 pipeline tables | `lead/T-0106-fixes` (the builder's commits, two lead suite fixes, D-L119, and the report) | **Never run against Postgres** (Docker hung). Run pipeline-tables and the tenancy folder first; expect builder fixes. Then the migration and security reviews (0036 is a migration, and the R9 creation marker must be confirmed), PR, verify. |

Migration numbers: 0035 is T-0084 and 0036 is T-0106. Merge 0035 first if you can.

## 3. Next tasks (no task file yet unless named)
- **Pipeline chain:** T-0107 board API, T-0108 deals and moves, then T-0109 Kanban, T-0110 deal detail and T-0111 deal
  timeline (D-L88, D-L113, D-L115).
- **Search:** T-0085 contract, T-0086 API, T-0087 palette. They build on T-0084, plus the D-P33 LEAKPROOF step (an ADR).
- **Custom fields:** T-0088–T-0091. An ADR on storage first.
- **Import:** T-0092–T-0096. An ADR on object storage and new dependencies first.
- **Dedupe:** T-0095 and T-0097.
- **Notifications:** T-0098–T-0101. An outbox ADR first (a new `kasuwa_relay` role).
- **Follow-ups:** T-0079 (capability read; it unblocks T-0115's `@p10-builder-access-404` fixme), T-0075, T-0118–T-0122.
- **End of Phase 2:** ONE full `pnpm test:isolation` on main (D-L111), and fix everything it finds.

## 4. Waiting on @acexode
- The `channels/provider` fix: split the eight messaging vendor names in
  `tests/acceptance/platform/scripting-contract.acceptance.test.ts` (about lines 574–598) as `'Twil' + 'io'`, as the
  channels suite itself does. @acexode approved it, but the auto-mode classifier refuses acceptance edits of this kind
  ("Security Test Removal"). Do it with auto mode OFF. Until then, every verification shows that one known failure.

## 5. How the lead works (keep doing it)
- **Verification (D-L111):** each PR gets `tools/lead-verify.sh <worktree> <log> --files <its suites> --tags <its e2e
  tags>`: lint, typecheck, unit, integration, the `tests/acceptance/tenancy` folder, its own suites. The full isolation
  suite runs once at the end of Phase 2.
- **Known noise, judged against main, never blocking:**
  - the adversarial timing check;
  - the auth-crypto hashing timing tests;
  - `auth-availability` (D-L100);
  - `channels/provider`.
- **Reviews (D-L109):**
  - migration, auth or data access: all three reviewers (migration, security, tenancy);
  - UI, contract or docs only: one combined security and tenancy review.
  - Fix findings before merge; record rulings as D-L entries.
- **Host (D-L118):**
  - at most TWO heavy jobs at once (builders, suite writers with containers, a verification);
  - keep 10+ GB of disk free;
  - after an agent finishes, stop its leftover node processes and remove the worktrees of merged work.
- **Acceptance suites:** the lead writes each one first, on a `lead/T-xxxx-acceptance` branch; it must fail on main for
  the real reason (D-L23). Builders never edit tests; a disputed test is a lead edit. Lead edits to tests must be made
  from a `lead/*` worktree, because the protect-paths hook reads the session's current branch.
- **Merge:**
  - `gh pr merge N --squash --match-head-commit <sha>`, plus the `lead-approved` label and a verification comment;
  - rebase first, and push by branch name only after the rebase has finished;
  - resolve `protect-paths.mjs` conflicts by keeping both entries;
  - resolve `team/FEATURES.md` by taking main's and running `node tools/generate-features.mjs`.
- **Bookkeeping** (`team/**`, `docs/adr|prd|design/**`) goes straight to main. After every task-file or DECISIONS edit,
  run `node tools/generate-features.mjs --check` and `pnpm verify:tasks`.
- **New machine setup:**
  - install Docker (OrbStack recommended), with about 8 GB for the Docker VM;
  - `pnpm install`;
  - `npx playwright install chromium`.
  - The rollup WASM pin (D-L20) exists only for Windows Smart App Control; it can be removed once the Mac runs the suite
    (a separate PR).

---
# Lead handoff — finish Phase 2

*Written 2026-10-06 by the outgoing Lead Agent session. `main` is at `b680668`. Read this first, then
`CLAUDE.md`, `team/ROADMAP.md`, `team/STATUS.md` and the open entries in `team/DECISIONS.md`.*
*This replaces the 2026-10-02 handoff, which is still in git history at `3ec49f0`.*

## 1. Where things stand
- **Phase 0 and Phase 1 are complete** and on `main`. That includes the security hardening T-0045 to T-0048 (#84–#87).
- **Phase 2, first slice (Contacts), is 2 of 5 merged.** T-0039 (contract, #76) and T-0040 (fields and accounts, #80) are on `main`.
- **Migrations end at `0023`.** The next free number is `0024`.
- `team/ROADMAP.md` maps every phase and all 32 design prompts.

## 2. Open PRs: both verified, both waiting on lead-only test edits
| PR | Task | Verified | Blocker |
|---|---|---|---|
| #83 `agent3/T-0041-contacts-api` | Contacts API: write, search, filter | Own suite 82/82. Security and tenancy reviews passed; all fixes are in. Unit 879, integration 108 | Two lead suite edits (Â§3). Without them `adversarial` and `observability-pii` go red on `main` |
| #81 `agent11/T-0042-contacts-list` | CRM shell and the Contacts screen behind `crm_records` | 27/28. Browser: `@p04` 23 + 1 fixme, `@p02` 86, `@locale-beta` 7, `@byte-budget` 1, `@harness` 6 | One budget edit (Â§3) |

Rebase each onto `main` before merging. Both were mergeable at the time of writing.

## 3. The lead-only edits (auto mode refuses them, so ask @acexode to switch auto mode OFF)
Edits under `tests/acceptance/**` (and the pinned e2e spec) are refused by the auto-mode classifier even when the user
says yes in chat. Ask @acexode to switch the session to "ask" mode, make the edits so they can approve each one, and then
they switch back. Make them on `lead/*` branches; the protect-paths hook allows `lead/*`.

1. **T-0042 budget.** In `tests/e2e/p04-contacts.spec.ts`, change `CONTACTS_BUDGET_BYTES = 240_000` to `226_000`. The screen
   measured 216,100, and the rule is ≤ 1.05 × measured. The edit goes on the #81 branch (or a lead branch merged into it).
   The suite's sha256 pin ignores this line.
2. **T-0041, `tests/acceptance/tenancy/adversarial.acceptance.test.ts` (around l.268–280).** The FINDING-4 tripwire fails on
   any `INSERT INTO contact`. Replace it with an assertion that `insertContact` binds the id only from `newId()` and that
   `CreateContactBody` has no `id`. The tenancy review confirmed both are true.
3. **T-0041, `tests/acceptance/platform/observability-pii.acceptance.test.ts`.** The probe NIN `00000000001` is a substring
   of tenant A's id (`…-000000000001`). Change the probe to a value that collides with no fixture id.
4. **D-P14** (answered: agents may change `status` and assign `owner` to themselves). In the T-0041 suite, flip the
   "the agent set may not write" test to the narrow rule, then have a builder implement it. Do this after #83 merges.
5. **T-0049 (auth role, D-P16 answered).** Its suite is on `lead/T-0049-acceptance` (206c815). It needs:
   - the `kasuwa_auth` role in `packages/db/sql/bootstrap.sql`. That file is lead-owned; apply the diff yourself on a `lead/*` branch, as was done for T-0045.
   - `tests/acceptance/support/api.ts` changed so `createApi` reads the auth URL;
   - the five suites that call `AppModule.forRoot` directly: audit-coverage, portal-users, auth-availability, auth-retention, exception-log-pii;
   - the `config-schemas` fixtures;
   - `run-e2e.mjs`, `.env.example` and docker-compose.

   After those, assign a builder (Agent 1).
6. **Optional:** the T-0035 wrapper (`p02-live-api.acceptance.test.ts`) spawns `pnpm test:e2e --grep "a|b"` through
   `cmd.exe`, which splits on `|`. Spawn `node run-e2e.mjs` with `shell:false`, one tag per run, as the T-0042 wrapper does.

## 4. Queue after the edits (each suite is already written on `lead/T-00xx-acceptance`)
| Order | Task | Owner | Starts when |
|---|---|---|---|
| 1 | Merge #83, then #81 | lead | Â§3 items 1–3 are done |
| 2 | T-0043 display names (`lead/T-0043-acceptance` 48df859; the owner name is embedded, not a batch lookup) | Agent 3 | #83 merged |
| 3 | D-P14 agent edits | Agent 3 | #83 merged, and Â§3 item 4 done |
| 4 | T-0050 pseudo-locale for dev and test only (`lead/T-0050-acceptance` e05afef) | Agent 11 | #81 merged. Re-check that test 1 fails for the real reason first |
| 5 | T-0049 auth role | Agent 1 + lead | Â§3 item 5 done |

## 5. The rest of Phase 2 (no task files yet; each needs a task, then a suite (D-L23), then a builder)
In this order, with the design prompt in brackets. Only P03 and P04 are exported, so **ask @acexode for P05 first**.
1. Accounts and Leads screens (P04, exported). Accounts already exist in the DB; leads need an M03 model decision.
2. 360Â° record view (P05, design needed).
3. Pipeline Kanban and deal detail (P06, design needed). It needs M04 deals, which are new tables.
4. Custom-field value storage (P18, design needed). This is the T-0002 follow-up and Agent 2's.
5. Home dashboards (P03, exported). Build the agent and SME variants first.
6. CSV import, dedupe and merge (P28, design needed). The rules are in D-P12.
7. Activities, tasks and calendar (P07), and the in-call script screen (P10).
8. Global search and the command palette (P27), and notifications (P26).
9. Search indexes (D-L68), following the D-L65 rules.

## 6. How this team works (keep doing it)
- **One task: a lead-written suite first, and it must fail for the real reason (D-L23).** Then one builder in its own
  worktree, then reviewers, then a merge.
  - The suite writer is Agent 12 (`agent-12-qa`), on branch `lead/T-00xx-acceptance`, under the active name.
  - The builder branches from that lead branch: `agentN/T-00xx-…`.
  - Builders commit locally; **the lead pushes and opens the PR**. The `builder` agent type refuses to push.
  - **Reviewers:** `security-reviewer` for anything touching auth, scope, PII or a new API. `tenancy-reviewer` for queries or
    scope. `migration-reviewer` for every migration.
  - Rebase onto `main`, re-run the key suites yourself, and squash-merge with the `lead-approved` label. @acexode authorised
    the lead to merge.
- **Bookkeeping goes straight to `main`, never in a PR.** That covers `team/**` and `docs/adr|prd|design/**`. Exception:
  `team/FEATURES.md` is generated. Regenerate it with `pnpm -s features` (needs `node_modules`; run it in `.claude/worktrees/lead-devcheck`),
  either in the PR whose contract changed it or straight to `main`.
- **CI minutes are exhausted.** Every merge is verified locally with Docker, which works. Say so in each PR comment.
- **Every builder brief includes these rules:**
  - Take the RAM lock (`mkdir …/scratchpad/node-slot-1|2`; a lock older than 20 min is stale).
  - Never use `--no-verify`, not even for WIP or a throwaway merge. Two agents tried this on 2026-10-04.
  - Use a unique commit-message file name, and conventional lower-case commits.
  - Never edit `tests/acceptance/**` or `team/**`.
  - Never use a worktree path that contains a space: unit tests break. Lead check worktrees go under `.claude/worktrees/`.
- **Never delete a `.claude/worktrees/agent-*` folder while that agent may still be running.** About 30 finished
  worktrees exist now; clean them up only once no agents are running.
- **Known host flakes, not regressions:**
  - The `auth-availability` timing bound fails under load, and on `main` too.
  - The 6 `p02-live-api` wrapper tests fail on Windows (Â§3 item 6). Run the e2e tags directly instead; they pass.
- **Browser tests work locally** through the SWC wasm fallback (D-L62). Run one tag per call.

## 7. Waiting on @acexode
- **The auto-mode-off session** for Â§3.
- **Design exports, P05 first.** P06, P18, P28, P07, P27 and P26 follow (ROADMAP order).
- **Dotgo's answers:** SMS fallback, naira rates, data location and the DPA. These gate the Phase 3 inbox.
- **A cloud provider** (Phase 4), and **Actions minutes or the org move** (CI).
- **Optional review (D-A3):** #69, #64, #62, #83.
