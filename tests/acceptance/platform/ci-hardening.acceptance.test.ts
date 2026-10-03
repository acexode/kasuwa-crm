import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0005 scope 1, CI hardening (Agent 13, DevOps).
 *
 * Parses `.github/workflows/*.yml` rather than grepping one file, so that:
 *
 *   - a scanner may live in its own workflow (as the guard does), and
 *   - a keyword in a COMMENT does not satisfy an assertion. The predecessor of
 *     these tests (in the old `observability-pii.pending` suite) matched
 *     `/audit/` against the raw text of `ci.yml`, which a comment saying
 *     "we should audit dependencies" would have passed.
 *
 * `pnpm <script>` in a `run:` is expanded through the root `package.json`, so a
 * job is judged by what it actually executes — moving `nx affected` into a
 * script is fine; renaming `pnpm test` to mean all three projects is caught.
 *
 * Out of scope here, stated so its absence is not read as an oversight:
 * container image scanning. The task lists Trivy, but nothing in the
 * repository builds an image yet, so there is nothing for an assertion to
 * point at. It belongs with the first Dockerfile (T-0005 scope 2).
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

// ---------------------------------------------------------------------------
// A deliberately small model of a GitHub Actions workflow: only what is read.
// ---------------------------------------------------------------------------

type Mapping = Record<string, unknown>;

interface Step {
  uses: string;
  run: string;
  if: string;
  with: Mapping;
  continueOnError: boolean;
}

interface Job {
  id: string;
  name: string;
  if: string;
  continueOnError: boolean;
  steps: Step[];
  /** Every `uses:` and `run:` in the job, with `pnpm` scripts expanded. */
  executes: string;
}

interface Workflow {
  file: string;
  triggers: Mapping;
  env: Mapping;
  jobs: Job[];
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const rootScripts: Record<string, string> = (() => {
  const parsed: unknown = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8'));
  const scripts = isMapping(parsed) && isMapping(parsed.scripts) ? parsed.scripts : {};
  return Object.fromEntries(Object.entries(scripts).map(([key, value]) => [key, str(value)]));
})();

/** `pnpm test:isolation` -> also the text of the script it runs, recursively. */
function expandScripts(command: string, depth = 0): string {
  if (depth > 4) return command;
  const expansions: string[] = [];
  for (const match of command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)) {
    const name = match[1];
    const body = name === undefined ? undefined : rootScripts[name];
    if (body !== undefined && body !== '') {
      expansions.push(expandScripts(body, depth + 1));
    }
  }
  return [command, ...expansions].join('\n');
}

function normaliseTriggers(on: unknown): Mapping {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [str(event), {}]));
  return isMapping(on) ? on : {};
}

function toStep(raw: unknown): Step {
  const step = isMapping(raw) ? raw : {};
  return {
    uses: str(step.uses),
    run: str(step.run),
    if: String(step.if ?? ''),
    with: isMapping(step.with) ? step.with : {},
    continueOnError: step['continue-on-error'] === true,
  };
}

function loadWorkflows(): Workflow[] {
  const dir = fromRoot('.github/workflows');
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const doc: unknown = parse(readFileSync(resolve(dir, file), 'utf8'));
      const workflow = isMapping(doc) ? doc : {};
      const jobs = isMapping(workflow.jobs) ? workflow.jobs : {};
      return {
        file,
        triggers: normaliseTriggers(workflow.on),
        env: isMapping(workflow.env) ? workflow.env : {},
        jobs: Object.entries(jobs).map(([id, raw]): Job => {
          const job = isMapping(raw) ? raw : {};
          const steps = Array.isArray(job.steps) ? job.steps.map(toStep) : [];
          return {
            id,
            name: str(job.name),
            if: String(job.if ?? ''),
            continueOnError: job['continue-on-error'] === true,
            steps,
            executes: steps
              .map((step) => [step.uses, expandScripts(step.run)].join('\n'))
              .join('\n'),
          };
        }),
      };
    });
}

function runsOnPullRequests(workflow: Workflow): boolean {
  return 'pull_request' in workflow.triggers;
}

function runsOnPushToMain(workflow: Workflow): boolean {
  if (!('push' in workflow.triggers)) return false;
  const push = workflow.triggers.push;
  if (!isMapping(push) || push.branches === undefined) return true; // every branch
  const branches = Array.isArray(push.branches) ? push.branches.map(str) : [str(push.branches)];
  return branches.some((branch) => branch === 'main' || branch === '**' || branch === '*');
}

/** Steps matching `pattern` in jobs that can fail the build. */
function blockingStepsMatching(workflow: Workflow, pattern: RegExp): { job: Job; step: Step }[] {
  return workflow.jobs
    .filter((job) => !job.continueOnError)
    .flatMap((job) => job.steps.map((step) => ({ job, step })))
    .filter(({ step }) => !step.continueOnError)
    .filter(({ step }) => pattern.test(`${step.uses}\n${expandScripts(step.run)}`))
    // `scanner || true` is a scanner that cannot fail anything.
    .filter(({ step }) => !/\|\|\s*true\b/.test(step.run));
}

function describeWorkflows(workflows: Workflow[]): string {
  return workflows.map((wf) => `${wf.file}: ${wf.jobs.map((job) => job.id).join(', ')}`).join('; ');
}

const workflows = loadWorkflows();
const prWorkflows = workflows.filter(runsOnPullRequests);
const allJobs = workflows.flatMap((workflow) => workflow.jobs.map((job) => ({ workflow, job })));

const ISOLATION = /vitest\s+run\b[^\n]*--project[\s=]+isolation\b/;
const OTHER_PROJECT = /--project[\s=]+(?:unit|integration|pending)\b/;

// ---------------------------------------------------------------------------

describe('acceptance: CI is hardened', () => {
  it('scans for secrets on every pull request and every push to main', () => {
    // GitGuardian already runs as a GitHub App check on every PR, so secret
    // scanning is not absent today. The ask is an in-repo scanner as well: it
    // runs on a fork and on a developer's machine, where the App does not, and
    // it fails the build rather than posting a check someone can decline to
    // read. Pushes to main are included because a secret that reaches main by
    // any route — a direct push, a merge queue — is the one that matters.
    const SECRET_SCANNER = /gitleaks|trufflehog/i;

    const onPr = prWorkflows.flatMap((wf) => blockingStepsMatching(wf, SECRET_SCANNER));
    const onMain = workflows
      .filter(runsOnPushToMain)
      .flatMap((wf) => blockingStepsMatching(wf, SECRET_SCANNER));

    expect(onPr.length, 'no blocking secret-scanning step runs on pull_request').toBeGreaterThan(0);
    expect(onMain.length, 'no blocking secret-scanning step runs on push to main').toBeGreaterThan(
      0,
    );
  });

  it('scans dependencies for known vulnerabilities on every pull request', () => {
    // Nothing equivalent exists today, not even as an App check.
    const DEPENDENCY_SCANNER =
      /osv-scanner|google\/osv-scanner-action|\b(?:pnpm|npm|yarn)\s+audit\b|snyk|trivy[^\n]*\bfs\b|aquasecurity\/trivy-action|actions\/dependency-review-action/i;

    const steps = prWorkflows.flatMap((wf) => blockingStepsMatching(wf, DEPENDENCY_SCANNER));
    expect(steps.length, 'no blocking dependency-vulnerability scan runs on pull_request').toBeGreaterThan(
      0,
    );
  });

  it('runs the isolation suite as its own job, so it can be a required check on its own', () => {
    // A required status check is a JOB. If isolation shares a job with
    // anything else, "Tenant isolation suite" cannot be required without also
    // requiring the other thing — and when it fails, the checks list does not
    // say which.
    const isolationJobs = prWorkflows.flatMap((wf) =>
      wf.jobs.filter((job) => ISOLATION.test(job.executes)).map((job) => ({ wf, job })),
    );

    expect(
      isolationJobs.length,
      `exactly one job on pull_request should run the isolation project (${describeWorkflows(prWorkflows)})`,
    ).toBe(1);

    for (const { wf, job } of isolationJobs) {
      const where = `${wf.file}#${job.id}`;
      expect(job.name, `${where} has no stable name to require it by`).not.toBe('');
      expect(OTHER_PROJECT.test(job.executes), `${where} also runs another test project`).toBe(
        false,
      );
      expect(job.continueOnError, `${where} is continue-on-error`).toBe(false);
      // A job-level `if` can turn a required check into "skipped", which
      // GitHub treats as passing.
      expect(job.if, `${where} is conditional, so it can be skipped`).toBe('');
    }
  });

  it('runs the whole isolation suite, never just the affected part of it', () => {
    // Incremental CI (`nx affected`, `vitest --changed`) is right for lint and
    // unit tests and wrong for the tenancy gate: a change to a migration, a
    // guard or an RLS policy breaks isolation in files the diff never touched.
    const isolationJobs = allJobs.filter(({ job }) => ISOLATION.test(job.executes));
    expect(isolationJobs.length, 'no job runs the isolation project').toBeGreaterThan(0);

    for (const { workflow, job } of isolationJobs) {
      expect(
        job.executes,
        `${workflow.file}#${job.id} narrows the isolation suite to what changed`,
      ).not.toMatch(/nx\s+affected|--changed\b|\bvitest\s+related\b/);
    }
  });

  it('uploads test reports and artefacts when a test job fails', () => {
    // A red build that cannot be diagnosed without re-running it locally gets
    // re-run rather than read, and then gets ignored. The e2e job already does
    // this; every other test job must as well.
    const TEST_JOB = /vitest\s+run\b|playwright\s+test|run-e2e/;
    const testJobs = allJobs.filter(({ job }) => TEST_JOB.test(job.executes));
    expect(testJobs.length, 'no test jobs found at all').toBeGreaterThan(0);

    const missing = testJobs
      .filter(
        ({ job }) =>
          !job.steps.some(
            (step) =>
              step.uses.startsWith('actions/upload-artifact') &&
              // `failure()` or `always()`, in either the bare or ${{ }} form.
              // `!cancelled()` uploads on failure too.
              /\bfailure\(\)|\balways\(\)|!\s*cancelled\(\)/.test(step.if) &&
              str(step.with.path).trim() !== '',
          ),
      )
      .map(({ workflow, job }) => `${workflow.file}#${job.id}`);

    expect(missing, 'test jobs that upload nothing when they fail').toEqual([]);
  });

  it('does not re-lint, re-typecheck or re-test the world for a one-file change', () => {
    // Stated as a measured improvement in the task's definition of done; this
    // is the structural half of it. Either Nx decides what is affected, or Nx
    // replays cached results — a cache only helps a job that runs through Nx.
    const nxCloud = (workflow: Workflow): boolean =>
      /nx-cloud|NX_CLOUD_ACCESS_TOKEN|NX_CLOUD_AUTH_TOKEN/.test(
        `${JSON.stringify(workflow.env)}\n${workflow.jobs.map((job) => job.executes).join('\n')}`,
      ) || workflow.jobs.some((job) => job.steps.some((step) => /NX_CLOUD/.test(JSON.stringify(step))));

    const nxLocalCache = (job: Job): boolean =>
      job.steps.some(
        (step) => step.uses.startsWith('actions/cache') && /\.nx\/cache/.test(str(step.with.path)),
      );

    const incremental = (workflow: Workflow, job: Job): boolean =>
      /\bnx\s+affected\b/.test(job.executes) ||
      (/\bnx\s+(?:run-many|run|affected)\b/.test(job.executes) &&
        (nxCloud(workflow) || nxLocalCache(job))) ||
      /\bvitest\s+(?:run\s+)?[^\n]*--changed\b|\bvitest\s+related\b/.test(job.executes);

    const kinds: { kind: string; matches: RegExp }[] = [
      { kind: 'lint', matches: /\bnx\s+\S+[^\n]*-t\s+lint\b|\beslint\b/ },
      { kind: 'typecheck', matches: /\bnx\s+\S+[^\n]*-t\s+typecheck\b|\btsc\b/ },
      { kind: 'unit tests', matches: /--project[\s=]+unit\b|\bnx\s+\S+[^\n]*-t\s+test\b/ },
    ];

    const offenders: string[] = [];
    for (const { kind, matches } of kinds) {
      const jobs = prWorkflows.flatMap((wf) =>
        wf.jobs.filter((job) => matches.test(job.executes)).map((job) => ({ wf, job })),
      );
      expect(jobs.length, `no pull_request job runs ${kind}`).toBeGreaterThan(0);

      for (const { wf, job } of jobs) {
        if (!incremental(wf, job)) offenders.push(`${kind}: ${wf.file}#${job.id}`);
      }
    }

    expect(
      offenders,
      'jobs that run over the whole workspace on every PR (no nx affected, and no Nx cache they could replay from)',
    ).toEqual([]);
  });

  it('writes down what a red isolation check means', () => {
    // The one runbook that has to exist before there is an incident, because
    // the pressure during one is always toward merging past it.
    const runbook = fromRoot('docs/runbooks/red-isolation-check.md');
    expect(existsSync(runbook), 'docs/runbooks/red-isolation-check.md is missing').toBe(true);

    const text = readFileSync(runbook, 'utf8');
    expect(text, 'the runbook does not say never to merge past it').toMatch(/never merge/i);
  });
});
