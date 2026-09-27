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

process.stderr.write(
  `Refusing to edit ${relative}\n\n` +
    `${match} is lead-owned (Addendum A1 section 3.3, principle 3). Acceptance\n` +
    `tests are written by the lead from the PRD before a task is assigned, and\n` +
    `migrations are append-only and reviewed.\n\n` +
    `If the test looks wrong, say so in your completion report at\n` +
    `team/reports/<task-id>.md. Do not change it to make your build pass — CI\n` +
    `fails any pull request touching this path without the 'lead-approved'\n` +
    `label, so the change would be rejected anyway.\n\n` +
    `If you ARE the lead: set KASUWA_LEAD_SESSION=1 in this session's environment.\n`,
);

// Exit code 2 blocks the tool call and returns stderr to the model.
process.exit(2);
