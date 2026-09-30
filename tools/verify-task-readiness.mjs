#!/usr/bin/env node
/**
 * Enforces the standing rule from D-L23:
 *
 *   No task is assigned until its acceptance tests exist and fail for a real
 *   reason.
 *
 * Addendum A1 section 3.3 principle 3 says acceptance tests are written by the
 * lead, from the PRD, BEFORE a task is assigned — so a builder cannot make its
 * own criteria pass by editing them. The scaffold weakened that: the pilot
 * tasks shipped with `it.todo` stubs so CI could be green on the first PR, and
 * a `todo` holds nobody to anything.
 *
 * The weakness was never in the stubs themselves. It was that converting them
 * depended on someone remembering, at exactly the moment they are busiest. So
 * this check makes the rule mechanical: a task may carry stubs while it is
 * `not-assigned`, and the moment it is marked `assigned` or `in-progress` its
 * acceptance tests must be real.
 *
 * Run by CI on every pull request.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tasksDir = join(root, 'team', 'tasks');

/** Statuses that require real, failing acceptance tests. */
const ASSIGNED_STATUSES = new Set(['assigned', 'in-progress']);
/** Statuses that do not. */
const UNASSIGNED_STATUSES = new Set(['not-assigned', 'blocked', 'done']);

const TODO_PATTERN = /\b(?:it|test|describe)\.todo\b/;
const ACCEPTANCE_PATH_PATTERN = /tests\/acceptance\/[\w./-]*\.acceptance\.test\.ts/g;
// The value is normally in backticks in the task table; tolerate either form.
/*
 * Two accepted shapes, because A11 asks for task files under 25 lines and the
 * old metadata table was twelve of them before a word of content.
 *
 *   | **status** | `not-assigned` |          the original table row
 *   **status** `not-assigned`                the compact inline form
 *
 * Both are matched deliberately rather than migrating every existing file: a
 * sweep to rewrite fourteen task files would be a thousand lines of
 * bookkeeping churn in a cycle A12 requires to be 70% code. Files convert as
 * they are next touched.
 */
const STATUS_PATTERN =
  /(?:\|\s*\*\*status\*\*\s*\|\s*`?([a-z-]+)`?\s*\|)|(?:\*\*status\*\*\s+`?([a-z-]+)`?)/i;

const failures = [];

const taskFiles = readdirSync(tasksDir)
  .filter((name) => name.startsWith('T-') && name.endsWith('.md'))
  .sort();

if (taskFiles.length === 0) {
  console.log('no task files found; nothing to check');
  process.exit(0);
}

for (const fileName of taskFiles) {
  const taskPath = join(tasksDir, fileName);
  const source = readFileSync(taskPath, 'utf8');

  const statusMatch = STATUS_PATTERN.exec(source);
  if (statusMatch === null) {
    failures.push(
      `${fileName}: no **status** field. Every task file must declare one ` +
        `(${[...ASSIGNED_STATUSES, ...UNASSIGNED_STATUSES].join(', ')}).`,
    );
    continue;
  }

  const status = (statusMatch[1] ?? statusMatch[2]).toLowerCase();

  if (!ASSIGNED_STATUSES.has(status) && !UNASSIGNED_STATUSES.has(status)) {
    failures.push(
      `${fileName}: unknown status "${status}". Use one of ` +
        `${[...ASSIGNED_STATUSES, ...UNASSIGNED_STATUSES].join(', ')}.`,
    );
    continue;
  }

  if (!ASSIGNED_STATUSES.has(status)) {
    continue;
  }

  const referenced = [...new Set(source.match(ACCEPTANCE_PATH_PATTERN) ?? [])];

  if (referenced.length === 0) {
    failures.push(
      `${fileName} is "${status}" but names no acceptance test under tests/acceptance/. ` +
        `A task without acceptance criteria cannot be judged done.`,
    );
    continue;
  }

  for (const relativePath of referenced) {
    const testPath = join(root, relativePath);

    if (!existsSync(testPath)) {
      failures.push(`${fileName} is "${status}" but ${relativePath} does not exist.`);
      continue;
    }

    // A `.pending.` file holds real, failing acceptance tests for work not yet
    // started. It sits outside the blocking CI gate on purpose, so a backlog of
    // unstarted tasks does not look like a broken build — "CI red on main" is a
    // stop-the-line condition and must keep meaning something.
    //
    // Assigning a task means promoting its tests out of pending. That rename is
    // the moment CI starts enforcing them, and this check is what makes the
    // rename non-optional.
    if (/\.pending\.acceptance\.test\.ts$/.test(relativePath)) {
      failures.push(
        `${fileName} is "${status}" but ${relativePath} is still PENDING.\n` +
          `    Rename it to drop ".pending" so the blocking suite enforces it (D-L23).`,
      );
      continue;
    }

    if (TODO_PATTERN.test(readFileSync(testPath, 'utf8'))) {
      failures.push(
        `${fileName} is "${status}" but ${relativePath} still contains .todo stubs.\n` +
          `    Convert them to real, failing tests before assigning the task (D-L23).`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Task readiness check failed:\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    '\nRule (team/DECISION-LOG.md D-L23): no task is assigned until its acceptance\n' +
      'tests exist and fail for a real reason. Set the task back to "not-assigned",\n' +
      'or write the tests.\n',
  );
  process.exit(1);
}

console.log(`task readiness verified for ${taskFiles.length} task(s)`);
