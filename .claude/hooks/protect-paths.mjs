#!/usr/bin/env node
/**
 * PreToolUse hook: refuse edits to lead-owned paths.
 *
 * Protects `tests/acceptance/` and `packages/db/migrations/` (Addendum A1
 * section 3.4). Acceptance tests are written by the lead from the PRD; a
 * builder that can edit them can make any task pass by deleting the assertion.
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMITATION — read before relying on this.
 *
 * This hook is a guardrail against accident, NOT a security control. It checks
 * an environment variable that any session could set. It stops an agent from
 * wandering into a protected file mid-task; it would not stop one that decided
 * to get around it.
 *
 * The enforcement that an agent cannot set is in CI: the `guard-protected-paths`
 * job fails a pull request touching these paths without the `lead-approved`
 * label. Even that is a convention backed by repository settings rather than a
 * hard boundary — see .github/workflows/ci.yml, which says so in its own
 * comment, and team/DECISIONS.md D-L16.
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';

const PROTECTED_PREFIXES = ['tests/acceptance/', 'packages/db/migrations/', 'packages/db/sql/'];

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
  });
}

function toRepoRelative(filePath) {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^.*?\/?(?=tests\/|packages\/)/, '');
}

const raw = await readStdin();

let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // A hook that cannot parse its input must not block work; it has no opinion.
  process.exit(0);
}

const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.path;
if (!filePath) {
  process.exit(0);
}

const relative = toRepoRelative(filePath);
const match = PROTECTED_PREFIXES.find((prefix) => relative.startsWith(prefix));

if (!match) {
  process.exit(0);
}

if (process.env.KASUWA_LEAD_SESSION === '1') {
  process.exit(0);
}

/**
 * Lead work happens on a `lead/*` branch.
 *
 * The env var above is the documented escape, and it turned out to be
 * unusable: an agent cannot set its own session's environment, so the lead was
 * blocked from the paths the lead owns and the only way through was to route
 * around the hook with a shell command — which is precisely the habit this hook
 * exists to discourage.
 *
 * A branch name is something the lead can actually set, and unlike the env var
 * it is visible on the pull request. It is NOT a control: any session could
 * name its branch `lead/…`. That is fine, because this hook was never a
 * control — see README.md in this directory. The control is CI's label gate
 * plus branch protection, neither of which an agent can set.
 */
function currentBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return (result.stdout ?? '').trim();
}

function onLeadBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && /^lead\//.test((result.stdout ?? '').trim());
}

/**
 * A narrow, per-branch allowance for the one file a task legitimately assigns
 * to a builder.
 *
 * T-0004 makes `tests/acceptance/tenancy/adversarial.acceptance.test.ts` Agent
 * 12's deliverable — it WRITES that suite rather than consuming it (D-L25).
 * The hook blocked it anyway, and D-L32 had just told builders not to use the
 * `lead/*` branch that would have exempted them. So the only way to do the
 * assigned work was to route around the hook with a shell command, which is
 * exactly what the builder did — and then said so plainly in its report.
 *
 * That is the right disclosure and the wrong situation. **A guardrail that
 * forbids the assigned work teaches people to go around it**, and the next
 * person may not mention it. The lesson is not "trust the builder"; it is that
 * a rule with no legitimate path through it stops being a rule and becomes an
 * obstacle, and obstacles get removed rather than respected.
 *
 * So the allowance is explicit, narrow and visible: one path or path prefix,
 * one branch prefix, announced on stderr every time it fires. Adding an entry
 * here is a deliberate act that shows up in a diff, unlike a shell command that
 * shows up nowhere.
 *
 * EXTENDED 2026-09-30, after it happened a second time. T-0020 assigns Agent 1
 * a migration, and `packages/db/migrations/` was blocked, so that builder also
 * wrote through the shell and also said so. Two agents routing around the same
 * hook, both disclosing it, is not two lapses — it is the hook being wrong
 * about who owns what.
 *
 * The owning agent for a protected directory is not an exception to the rule;
 * it is the rule's whole point. `tests/acceptance/` is lead-owned so builders
 * cannot edit the tests they must satisfy — that reasoning does not extend to
 * a migration the task explicitly assigns. Migrations are guarded by being
 * append-only, checksummed by the runner, and reviewed by `migration-reviewer`
 * before merge. Those are the real controls; this hook was only ever a
 * reminder, and a reminder that blocks assigned work gets routed around.
 *
 * EXTENDED 2026-10-03 for the admin-API wave (T-0025-T-0031). Seven builders
 * run in parallel and each task reserves one migration number (0008-0014), so
 * two branches can never claim the same file. An entry may now match a
 * `pathPattern` (a RegExp over the repo-relative path) instead of a fixed
 * `path` or a directory `pathPrefix`, and the wave entries use it to allow ONE
 * filename prefix per task branch: `agent3/T-0027-*` may create
 * `packages/db/migrations/0010_*.sql` and nothing else under migrations. They
 * are listed first so the narrow entry, not a blanket one, is what the stderr
 * notice names. Remove them when the wave has merged.
 */
const WAVE_WHY =
  "Admin-API wave (DECISION-LOG 2026-10-03, 'the admin API goes in one wave'): migration numbers are reserved per task, and this branch may create only its own.";

/** One reserved migration file per wave task: `<NNNN>_*.sql`, directly in migrations/. */
const reservedMigration = (number) => new RegExp(`^packages/db/migrations/${number}_[^/]+\\.sql$`);

const PER_AGENT_ALLOWANCES = [
  { branchPrefix: 'agent1/T-0025', pathPattern: reservedMigration('0008'), why: WAVE_WHY },
  { branchPrefix: 'agent2/T-0026', pathPattern: reservedMigration('0009'), why: WAVE_WHY },
  { branchPrefix: 'agent3/T-0027', pathPattern: reservedMigration('0010'), why: WAVE_WHY },
  { branchPrefix: 'agent4/T-0028', pathPattern: reservedMigration('0011'), why: WAVE_WHY },
  { branchPrefix: 'agent6/T-0029', pathPattern: reservedMigration('0012'), why: WAVE_WHY },
  { branchPrefix: 'agent5/T-0030', pathPattern: reservedMigration('0013'), why: WAVE_WHY },
  { branchPrefix: 'agent7/T-0031', pathPattern: reservedMigration('0014'), why: WAVE_WHY },
  {
    branchPrefix: 'agent3/T-0040',
    pathPattern: reservedMigration('0019'),
    why: 'T-0040 (D-L60) assigns Agent 3 one migration, number 0019 reserved; T-0011 holds 0018.',
  },
  {
    branchPrefix: 'agent3/T-0054',
    pathPattern: reservedMigration('0026'),
    why: 'T-0054 (D-L69, D-L74) assigns Agent 3 one migration, number 0026 reserved; 0025 is T-0053.',
  },
  {
    branchPrefix: 'agent3/T-0060',
    pathPattern: reservedMigration('0027'),
    why: 'T-0060 (D-L69, D-L77) assigns Agent 3 one migration, number 0027 reserved; 0026 is T-0054.',
  },
  {
    branchPrefix: 'agent3/T-0076',
    pathPattern: reservedMigration('0028'),
    why: 'T-0076 (D-P17, D-L82) assigns Agent 3 one migration, number 0028 reserved; 0027 is T-0060.',
  },
  {
    branchPrefix: 'agent12/',
    path: 'tests/acceptance/tenancy/adversarial.acceptance.test.ts',
    why: 'T-0004 assigns this suite to Agent 12 — it writes these tests rather than consuming them (D-L25).',
  },
  {
    branchPrefix: 'agent1/',
    pathPrefix: 'packages/db/migrations/',
    why: 'Agent 1 owns the schema (ROSTER: tenancy, RLS, auth). Its tasks assign migrations; blocking them leaves no legitimate path.',
  },
  {
    branchPrefix: 'agent2/',
    pathPrefix: 'packages/db/migrations/',
    why: 'Agent 2 owns M15 metadata tables and its tasks assign migrations.',
  },
  {
    branchPrefix: 'agent6/T-0113',
    pathPattern: reservedMigration('0030'),
    why: 'T-0113 (D-L88, D-L93, D-L96) assigns Agent 6 one migration, number 0030 reserved; 0029 is T-0102.',
  },
];

function allows(entry, path) {
  if (entry.path !== undefined) return path === entry.path;
  if (entry.pathPattern !== undefined) return entry.pathPattern.test(path);
  return path.startsWith(entry.pathPrefix);
}

const branch = currentBranch();
const allowance = PER_AGENT_ALLOWANCES.find(
  (entry) => branch.startsWith(entry.branchPrefix) && allows(entry, relative),
);

if (allowance) {
  process.stderr.write(
    `protect-paths: allowing ${relative} on '${currentBranch()}'.
` +
      `${allowance.why}
` +
      `This is the ONLY protected path this branch may touch.
`,
  );
  process.exit(0);
}

if (onLeadBranch()) {
  // Say so, every time. On 2026-09-28 the lead put two builder subagents on
  // `lead/*` branches so their work would stack cleanly, and this exemption
  // silently disarmed the hook for both. One of them then edited an acceptance
  // test it had been told twice not to touch, and nothing fired.
  //
  // The edit was harmless — a stale comment — and CI's label gate would still
  // have caught the pull request. But the hook was quiet at exactly the moment
  // it was supposed to speak, and the lead found out from the builder's report
  // rather than from the hook.
  //
  // A silent exemption is indistinguishable from a working guard. This one is
  // loud now, so the next person who disarms it sees it happen.
  process.stderr.write(
    `protect-paths: allowing an edit to ${relative} because the branch is ` +
      `'lead/*'.
If you are NOT the lead, you are on the wrong branch — ` +
      `builders work on 'agent<N>/<task>'.
`,
  );
  process.exit(0);
}

process.stderr.write(
  `Refusing to edit ${relative}\n\n` +
    `${match} is lead-owned (Addendum A1 section 3.3, principle 3). Acceptance\n` +
    `tests are written by the lead from the PRD before a task is assigned, and\n` +
    `migrations are append-only and reviewed.\n\n` +
    `If the test looks wrong, say so in your completion report at\n` +
    `team/reports/<task-id>.md. Do not change it to make your build pass — CI\n` +
    `fails any pull request touching this path without the 'lead-approved'\n` +
    `label, so the change would be rejected anyway.\n\n` +
    `If you ARE the lead: work on a 'lead/*' branch, or set KASUWA_LEAD_SESSION=1\n` +
    `in the session environment.\n`,
);

// Exit code 2 blocks the tool call and returns stderr to the model.
process.exit(2);
