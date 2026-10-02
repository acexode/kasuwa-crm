# HANDOFF — the state of P01 and P02, and the six open items

**Written** 2026-10-02, after an audit of `origin/main` at `efc70b1`.
**Read `CLAUDE.md` first.** This file is the delta: what the backlog says that
is not true, and what is actually left.

---

## Read this before you trust `team/tasks/`

The task files are stale in **both** directions. T-0019, T-0020 and T-0021 all
read `status: not-assigned` and all three shipped (#32, #34, #36). T-0007 reads
`not-assigned` and shipped half its scope.

*Corrected 2026-10-02:* T-0004, T-0019, T-0020 and T-0021 now read `done`.
T-0006 and T-0007 carry a `status note` saying what shipped and what did not.
In `DECISIONS.md`, D-P2, D-L18, D-P1 and D-L24 had also been settled without
their status line changing; they now point at the log.

**Do not take a task file's status as evidence.** Check the code.

## What is actually true

**P01 — 8 of 16 screens.** Groups 1 and 2 (sign-in, MFA, SSO) are finished, not
sketched: every manifest state reachable, every failure state has an e2e test,
axe blocks with no exemptions, RTL proven. Groups 3 and 4 (sign-up `P01/3`–`4`,
onboarding `P01/5.1`–`5.5`, `6`) were **never built**, deliberately — they create
a *tenant* and ask for a data region, `signUp`/`verifyOtp`/`resendOtp` are all
`x-kasuwa-implemented: false`, and **D-P2** records that nobody owns self-serve
provisioning. Building them would have produced the only screens in the repo
that no endpoint will ever answer.

**P01 is the only part of the product with a real backend.** Five of nine auth
operations are live against NestJS: `signIn`, `verifyMfa`, `signOut`,
`getCurrentUser`, `lookupSso`.

**P02 — 22 of 22 screens, 0 of 41 endpoints.** `apps/api` has exactly three
controllers: `auth`, `contacts`, `health`. There is **no admin controller**.

| `x-kasuwa-implemented` in `admin.openapi.yaml` | count |
|---|---|
| `false` | 39 |
| `partial` | 2 |
| `true` | **0** |

`apps/web/lib/admin-api.ts` makes 35 typed calls against `/api/v1/admin`. The
only thing answering them is `page.route('**/api/v1/admin/**')` in
`tests/e2e/support/admin-mock.ts` — **Playwright request interception, which
exists only inside a test process.** In a real browser every one of those calls
falls through the `next.config.mjs` rewrite to the API origin and returns 404.

That is a legitimate contract-first state and it is what we planned. It is not
"P02 is complete" without the qualifier.

---

## The six items

### 1. Build the admin API — 41 operations
The largest gap in the project and **it is not in the backlog at all**. Every
P02 screen depends on it. Too large for one task: split by domain across
Agent 1 (roles, field security, audit), Agent 2 (metadata-backed field
security objects) and Agent 3 (programmes, dispositions, SLA). Contract is
published and frozen; the mock is generated from it, so the wiring step is
mechanical if the implementation honours the spec.

### 2. P01 groups 3 and 4 — 8 screens
**Unblocked. Corrected 2026-10-02:** this item originally said "blocked on D-P2,
do not build against the mock". That was wrong. @acexode answered D-P2 on
2026-09-30 (`DECISION-LOG.md`), and part 3 of the answer is to **build all
eight screens against the mock now** (T-0007). `P01/3`, `4` and `5.1` sit
behind `self_serve_signup`, off until v1. `5.2`–`5.5` are the unflagged
first-admin-login flow for provisioned tenants (T-0018). The real backend is
T-0015 (sales-led provisioning, the launch path), then T-0016 (self-serve,
which also needs M8/T-0017 for OTP).

### 3. `reissueMfaChallenge` is `partial`
The one auth operation that is neither done nor absent.

### 4. Two P02 success paths are untestable
`listProgrammeScripts` and the portal-user list have no `200` example in the
spec, so the generated mock can only answer their `501`. The one hand-built
row in the mock is there for this reason and should be deleted when the
examples land.

### 5. `P02/E` pagination is unbuilt
The contract has a cursor; the mock returns one page; the screen does not page.

### 6. `noto-sans-latin-ext-400800.woff2` is 167,960 B
Five times the basic-latin subset. `unicode-range` keeps it off an English
page, but a **Yorùbá, Hausa or Igbo** admin pays it, which puts several routes
back over the 300 KB NFR **in exactly the languages this product exists for**.
The fix is in `fetch-fonts.mjs` and it affects every screen.

---

## Standing instructions from @acexode

- No scheduler. Work progressively; finish one task, start the next, do not pause.
- Pause only when **more than five** PRs are open and unmerged.
- Bookkeeping (`team/**`, `docs/design/**`, `docs/prd/**`, `docs/adr/**`) commits
  straight to `main` — no branch, no PR. Everything else goes through a PR.
- Max **one** ready task per agent. Write the next one when an agent finishes.
- Task files under 25 lines: goal, acceptance-test path, done-when, deps.
- At least **70%** of lines changed per cycle in `apps/` or `packages/`.
- @acexode reads two files: `team/DECISIONS.md` and `team/STATUS.md`.

## The failure class worth remembering

**A mechanism nobody has watched run is not a mechanism.** Five instances so
far: a pre-push hook absent on the branch it guarded; `readNonTenantScopedTable
Security` as dead code; `SignInThrottleInterceptor` never registered; a
migration `DO` guard claiming to protect future migrations; a scheduler with
two runs in 72 hours. This audit is a sixth — 22 screens tested green against a
mock nobody had checked was the only responder.
