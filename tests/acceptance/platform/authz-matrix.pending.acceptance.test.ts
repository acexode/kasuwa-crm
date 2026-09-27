import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0004, adversarial isolation testing and the authz matrix
 * harness (Agent 12, QA).
 *
 * PENDING. `pnpm test:pending` runs them. Renaming this file to drop `.pending`
 * is what assigns the task.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE ASSERTS DELIVERABLES AND NOT ATTACKS
 *
 * D-L23 says a task is not assigned until its acceptance tests exist and fail.
 * T-0004 is the one task where applying that literally would defeat the task:
 * its deliverable IS a set of tests, and if the lead writes the attacks first,
 * Agent 12 inherits the lead's imagination and the independence the task exists
 * for is gone before it starts. The whole point of T-0004 is the eighth attack
 * nobody listed.
 *
 * That risk is not hypothetical here. The tenancy scaffold and the tests
 * asserting it works were written by the same model in the same session —
 * a correlated blind spot by construction. @acexode's D-A3 answer puts the
 * security-critical review paths on a human, but the attacks themselves are
 * still ours to find.
 *
 * So this file asserts the SHAPE of the deliverable — that the todos became
 * real tests, that the matrix harness exists and is exhaustive, that a report
 * was filed — and says nothing about what the attacks should be. Recorded as
 * D-L25.
 *
 * Six of the eight fail today. The two that pass — `runs inside the blocking
 * isolation gate` and `does not fix what it finds` — are constraints on HOW the
 * work is done rather than on its output, so they necessarily hold before it
 * starts. They are here to go red if Agent 12 moves the suite out of the gate
 * or patches the hole it found, which are the two ways this task quietly stops
 * being worth doing. Said plainly so the count is not mistaken for coverage.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const ADVERSARIAL_SUITE = 'tests/acceptance/tenancy/adversarial.acceptance.test.ts';

describe('acceptance (pending): the adversarial suite became real', () => {
  it('leaves no todo behind', () => {
    // The nine todos in the stub are the lead's guesses. Converting them is the
    // floor, not the ceiling — see the next assertion.
    const source = readFileSync(fromRoot(ADVERSARIAL_SUITE), 'utf8');

    expect(source, 'the adversarial suite still contains it.todo').not.toMatch(/it\.todo/);
  });

  it('contains more tests than the stub listed', () => {
    // Nine todos went in. Nine tests coming out means the stub was transcribed,
    // and a transcription is precisely the correlated blind spot this task
    // exists to break. The tenth test is the deliverable.
    //
    // If Agent 12 honestly cannot find one, the definition of done says to say
    // so in the report rather than pad — and then this assertion is the right
    // place to have the conversation, not a number to quietly satisfy.
    const source = readFileSync(fromRoot(ADVERSARIAL_SUITE), 'utf8');
    const count = (source.match(/\bit\(/g) ?? []).length;

    expect(count, 'no attack beyond the nine the lead already thought of').toBeGreaterThan(9);
  });

  it('runs inside the blocking isolation gate', () => {
    // An adversarial suite outside the blocking project is documentation.
    // Addendum A1 section 3.5 makes the isolation suite blocking; this is the
    // part of it that matters most.
    expect(ADVERSARIAL_SUITE).not.toMatch(/\.pending\./);
    expect(existsSync(fromRoot(ADVERSARIAL_SUITE))).toBe(true);
  });

  it('does not fix what it finds', () => {
    // Non-goal, and the reason it is a non-goal is worth restating: an agent
    // that patches the hole it found becomes the author of the fix and loses
    // the independence that made the finding worth anything.
    //
    // Asserted structurally — the task's own diff must not touch the tenancy
    // implementation. Reviewed by eye on the PR too; this catches the easy case.
    const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    const implementation = changed.filter(
      (file) =>
        file.startsWith('packages/db/src/') ||
        file.startsWith('apps/api/src/tenancy/') ||
        file.startsWith('packages/db/migrations/'),
    );

    expect(
      implementation,
      'T-0004 changed tenancy implementation — report the defect, do not fix it',
    ).toEqual([]);
  });
});

describe('acceptance (pending): the authz matrix harness', () => {
  const HARNESS = 'packages/testing/src/authz-matrix.ts';

  it('exists and is exported from @kasuwa/testing', async () => {
    expect(existsSync(fromRoot(HARNESS)), `${HARNESS} is missing`).toBe(true);

    const index = readFileSync(fromRoot('packages/testing/src/index.ts'), 'utf8');
    expect(index, 'the harness is not exported').toMatch(/authz-matrix/);
  });

  it('enumerates every role × object × action with no implicit default', async () => {
    // The failure mode this guards against: a matrix where an unlisted
    // combination reads as "deny". It looks safe and it is not — it means a new
    // object silently arrives with no expectations at all, and nobody notices
    // until it is the object that mattered.
    //
    // Every cell must be stated. A missing cell is an error, not a deny.
    const module: {
      buildAuthzMatrix: (input: {
        roles: readonly string[];
        objects: readonly string[];
        actions: readonly string[];
        expectations: Record<string, 'allow' | 'deny'>;
      }) => { cells: readonly { key: string; expected: 'allow' | 'deny' }[] };
    } = await import(fromRoot(HARNESS));

    const roles = ['agent', 'supervisor'] as const;
    const objects = ['contact'] as const;
    const actions = ['read', 'delete'] as const;

    const complete = {
      'agent:contact:read': 'allow',
      'agent:contact:delete': 'deny',
      'supervisor:contact:read': 'allow',
      'supervisor:contact:delete': 'allow',
    } as const;

    const built = module.buildAuthzMatrix({
      roles,
      objects,
      actions,
      expectations: { ...complete },
    });
    expect(built.cells).toHaveLength(roles.length * objects.length * actions.length);

    // And the omission must be loud.
    const { 'supervisor:contact:delete': _omitted, ...incomplete } = complete;
    expect(() =>
      module.buildAuthzMatrix({ roles, objects, actions, expectations: { ...incomplete } }),
    ).toThrow(/supervisor:contact:delete/);
  });

  it('runs against a placeholder role set while the engine is unbuilt', async () => {
    // M2 is blocked on D-L06. The harness must be usable before the engine
    // exists, or it gets retrofitted under time pressure with thirty objects
    // already in place, which is how matrices end up with implicit defaults.
    const permissions: { PERMISSIONS_ENGINE_STATUS: string } = await import(
      fromRoot('packages/permissions/src/index.ts')
    );
    expect(permissions.PERMISSIONS_ENGINE_STATUS).toBe('not-implemented');

    const module: { runAuthzMatrix: unknown } = await import(fromRoot(HARNESS));
    expect(typeof module.runAuthzMatrix, 'the harness cannot be run').toBe('function');
  });
});

describe('acceptance (pending): the finding is written down', () => {
  it('files a completion report', () => {
    // Required by CLAUDE.md section 5 for every task. It matters more here:
    // an attack that was tried and failed is a finding, and the only place it
    // survives is the report. The next person to ask "did anyone check
    // timing?" should not have to guess.
    const report = fromRoot('team/reports/T-0004.md');
    expect(existsSync(report), 'no completion report at team/reports/T-0004.md').toBe(true);

    const text = readFileSync(report, 'utf8');
    expect(text.length, 'the report is a stub').toBeGreaterThan(400);

    // Either a new attack class, or an honest statement that none was found.
    // Both are acceptable outcomes; silence is not.
    expect(
      text,
      'the report does not say what was newly attempted, or that nothing new was found',
    ).toMatch(/new attack|could not break|nothing new/i);
  });
});
