import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FLAGS } from '@kasuwa/feature-flags';

/**
 * ACCEPTANCE — T-0034, the feature register (D-L36) and hooks mirrored in CI
 * (D-L34 compensating control). Agent 13.
 *
 * D-L36: "no feature may be quietly buried". A flag-gated, deferred, contract-
 * only or mock-only feature is reasonable on its own; together they let a
 * feature disappear without anyone deciding it should. The register makes each
 * of them a row with a state and the decision behind it.
 *
 * ---------------------------------------------------------------------------
 * THE INTERFACE THIS SUITE PINS (the builder implements it)
 * ---------------------------------------------------------------------------
 *
 * Generator: `tools/generate-features.mjs`, plain Node, no arguments needed.
 *
 *   node tools/generate-features.mjs                 writes team/FEATURES.md
 *   node tools/generate-features.mjs --stdout        prints the register, writes nothing
 *   node tools/generate-features.mjs --check         exit 0 if team/FEATURES.md is current,
 *                                                    non-zero (naming the drift) if not
 *   node tools/generate-features.mjs --check --file <path>
 *                                                    the same check against another file
 *
 * It reads the PRD (`docs/prd/M*.md`), the OpenAPI specs (`docs/api/*.openapi.yaml`,
 * `x-kasuwa-implemented` and `x-kasuwa-screens`), the flag registry
 * (`FLAGS` in `@kasuwa/feature-flags`), the e2e screen manifests and
 * `team/DECISIONS.md`. Output is deterministic (no timestamps) and LF-only;
 * `.gitattributes` pins `team/FEATURES.md` to `eol=lf`, exactly as it does the
 * generated token files, or a Windows checkout with core.autocrlf fails the
 * byte-for-byte check on its first run.
 *
 * Format of `team/FEATURES.md`:
 *
 *   - Within its first 10 lines, a banner naming `tools/generate-features.mjs`
 *     and saying "do not edit".
 *   - One or more Markdown tables, every one with exactly this header:
 *
 *       | Kind | ID | Feature | State | Flag | Decision | Source |
 *
 *     Cell content may be wrapped in backticks; a literal pipe is written `\|`.
 *     `Flag`, `Decision` and `Source` may be empty or `—` when there is none.
 *
 *   - Kind  ∈ module | screen | operation | flag | decision
 *   - ID    the PRD module id (`M01`…`M23`), the screen id (`P02/B3`), the
 *           `operationId`, the flag name, or the decision id (`D-T1`).
 *   - State ∈ built | partial | mock-only | flagged-off | deferred | not-started
 *   - Decision holds every decision id behind the state (`D-P2`, `D-T1`, …).
 *   - Source names where the row came from (for an operation, its spec file).
 *
 * Operation states follow `x-kasuwa-implemented` mechanically:
 *   true → built · partial → partial · false → not-started or deferred.
 *
 * ---------------------------------------------------------------------------
 *
 * CI: some blocking job that runs on pull_request runs the `--check` (directly
 * or through a root `package.json` script, which is expanded), and that
 * workflow has no `paths` filter that could skip it. And every check the git
 * hooks run (`.husky/commit-msg`, `.husky/pre-commit`) is also run, blocking,
 * on pull_request — commitlint over the PR's COMMIT RANGE, not just its title —
 * so `--no-verify` buys nothing (D-L34).
 *
 * The workflow model below is the one from ci-hardening.acceptance.test.ts,
 * trimmed: parse the YAML, so a keyword in a comment satisfies nothing.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const GENERATOR = 'tools/generate-features.mjs';
const REGISTER = 'team/FEATURES.md';
const HEADER = ['Kind', 'ID', 'Feature', 'State', 'Flag', 'Decision', 'Source'] as const;
const KINDS = ['module', 'screen', 'operation', 'flag', 'decision'] as const;
const STATES = ['built', 'partial', 'mock-only', 'flagged-off', 'deferred', 'not-started'] as const;

type Kind = (typeof KINDS)[number];
type State = (typeof STATES)[number];

interface Row {
  kind: string;
  id: string;
  feature: string;
  state: string;
  flag: string;
  decision: string;
  source: string;
  line: number;
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

function runGenerator(...args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [fromRoot(GENERATOR), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanCell(raw: string): string {
  const trimmed = raw.trim().replace(/\\\|/g, '|');
  const unticked = trimmed.replace(/^`(.*)`$/, '$1').trim();
  return unticked === '—' || unticked === '-' ? '' : unticked;
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map(cleanCell);
}

function readRegister(): string {
  return existsSync(fromRoot(REGISTER)) ? readFileSync(fromRoot(REGISTER), 'utf8') : '';
}

function parseRegister(text: string): { rows: Row[]; malformed: string[] } {
  const rows: Row[] = [];
  const malformed: string[] = [];
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim().startsWith('|')) return;
    const cells = splitRow(line);
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return; // separator
    if (cells.join('|') === HEADER.join('|')) return;
    if (cells.length !== HEADER.length) {
      malformed.push(`line ${index + 1}: ${cells.length} cells`);
      return;
    }
    const [kind = '', id = '', feature = '', state = '', flag = '', decision = '', source = ''] =
      cells;
    rows.push({ kind, id, feature, state, flag, decision, source, line: index + 1 });
  });
  return { rows, malformed };
}

const registerText = readRegister();
const { rows, malformed } = parseRegister(registerText);

function rowsOf(kind: Kind): Row[] {
  return rows.filter((row) => row.kind === kind);
}

function rowFor(kind: Kind, id: string): Row | undefined {
  return rows.find((row) => row.kind === kind && row.id === id);
}

function namesDecision(cell: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w])`).test(cell);
}

// ---------------------------------------------------------------------------
// The sources, read independently of the generator
// ---------------------------------------------------------------------------

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface Operation {
  operationId: string;
  implemented: string;
  screens: string[];
  file: string;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

function loadOperations(): Operation[] {
  const dir = fromRoot('docs/api');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.openapi.yaml'))
    .sort()
    .flatMap((file) => {
      const doc: unknown = parse(readFileSync(resolve(dir, file), 'utf8'));
      const paths = isMapping(doc) && isMapping(doc.paths) ? doc.paths : {};
      return Object.values(paths).flatMap((item) =>
        isMapping(item)
          ? HTTP_METHODS.map((method) => item[method])
              .filter(isMapping)
              .map((op): Operation => ({
                operationId: str(op.operationId),
                implemented: String(op['x-kasuwa-implemented']),
                screens: Array.isArray(op['x-kasuwa-screens'])
                  ? op['x-kasuwa-screens'].map(str)
                  : [],
                file: `docs/api/${file}`,
              }))
          : [],
      );
    });
}

const operations = loadOperations();

const prdModules = readdirSync(fromRoot('docs/prd'))
  .map((file) => /^(M\d{2})-.*\.md$/.exec(file)?.[1])
  .filter((id): id is string => id !== undefined)
  .sort();

/** The `MANIFEST = { built: [...], notBuilt: [...] }` constant of an e2e spec. */
function readScreenManifest(spec: string): { built: string[]; notBuilt: string[] } {
  const text = readFileSync(fromRoot('tests/e2e', spec), 'utf8');
  const block = /const MANIFEST = \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  const list = (key: string): string[] => {
    const body = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(block)?.[1] ?? '';
    return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
  };
  return { built: list('built'), notBuilt: list('notBuilt') };
}

const screenManifests = [
  readScreenManifest('p01-auth.spec.ts'),
  readScreenManifest('p02-admin.spec.ts'),
];
const allScreens = screenManifests.flatMap((m) => [...m.built, ...m.notBuilt]);
const notBuiltScreens = new Set(screenManifests.flatMap((m) => m.notBuilt));

/** Decisions whose status line in team/DECISIONS.md says DEFERRED. */
function deferredDecisions(): string[] {
  const text = readFileSync(fromRoot('team/DECISIONS.md'), 'utf8');
  const ids: string[] = [];
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(D-[A-Z]+\d+)\b/.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (current !== undefined && /^\*\*Status:\*\*\s*DEFERRED\b/.test(line)) {
      ids.push(current);
      current = undefined;
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Workflows (trimmed from ci-hardening.acceptance.test.ts)
// ---------------------------------------------------------------------------

interface Step {
  uses: string;
  run: string;
  with: Mapping;
  continueOnError: boolean;
  executes: string;
}

interface Job {
  id: string;
  continueOnError: boolean;
  steps: Step[];
}

interface Workflow {
  file: string;
  triggers: Mapping;
  jobs: Job[];
}

const rootScripts: Record<string, string> = (() => {
  const parsed: unknown = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8'));
  const scripts = isMapping(parsed) && isMapping(parsed.scripts) ? parsed.scripts : {};
  return Object.fromEntries(Object.entries(scripts).map(([key, value]) => [key, str(value)]));
})();

function expandScripts(command: string, depth = 0): string {
  if (depth > 4) return command;
  const expansions: string[] = [];
  for (const match of command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)) {
    const name = match[1];
    const body = name === undefined ? undefined : rootScripts[name];
    if (body !== undefined && body !== '') expansions.push(expandScripts(body, depth + 1));
  }
  return [command, ...expansions].join('\n');
}

function normaliseTriggers(on: unknown): Mapping {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [str(event), {}]));
  return isMapping(on) ? on : {};
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
        jobs: Object.entries(jobs).map(([id, raw]): Job => {
          const job = isMapping(raw) ? raw : {};
          const steps = (Array.isArray(job.steps) ? job.steps : []).map((rawStep): Step => {
            const step = isMapping(rawStep) ? rawStep : {};
            const uses = str(step.uses);
            const run = str(step.run);
            return {
              uses,
              run,
              with: isMapping(step.with) ? step.with : {},
              continueOnError: step['continue-on-error'] === true,
              executes: `${uses}\n${expandScripts(run)}`,
            };
          });
          return { id, continueOnError: job['continue-on-error'] === true, steps };
        }),
      };
    });
}

/** Runs on every pull request: the trigger is present and nothing filters it by path. */
function runsOnEveryPullRequest(workflow: Workflow): boolean {
  if (!('pull_request' in workflow.triggers)) return false;
  const pr = workflow.triggers.pull_request;
  return !(isMapping(pr) && (pr.paths !== undefined || pr['paths-ignore'] !== undefined));
}

function blockingPrSteps(pattern: RegExp): { workflow: Workflow; job: Job; step: Step }[] {
  return loadWorkflows()
    .filter(runsOnEveryPullRequest)
    .flatMap((workflow) =>
      workflow.jobs
        .filter((job) => !job.continueOnError)
        .flatMap((job) => job.steps.map((step) => ({ workflow, job, step }))),
    )
    .filter(({ step }) => !step.continueOnError)
    .filter(({ step }) => pattern.test(step.executes))
    .filter(({ step }) => !/\|\|\s*true\b/.test(step.run));
}

// ---------------------------------------------------------------------------

describe('acceptance: the feature register is generated and cannot drift (D-L36)', () => {
  it('team/FEATURES.md exists, carries the generated banner, and every table row is well-formed', () => {
    expect(existsSync(fromRoot(GENERATOR)), `${GENERATOR} does not exist`).toBe(true);
    expect(registerText, `${REGISTER} does not exist or is empty`).not.toBe('');

    const banner = registerText.split('\n').slice(0, 10).join('\n');
    expect(banner, 'the banner must name the generator').toContain(GENERATOR);
    expect(banner, 'the banner must say the file is not edited by hand').toMatch(/do not edit/i);

    expect(malformed, 'rows without exactly seven cells').toEqual([]);
    expect(rows.length, 'the register has no rows').toBeGreaterThan(0);

    const badKind = rows.filter((row) => !(KINDS as readonly string[]).includes(row.kind));
    const badState = rows.filter((row) => !(STATES as readonly string[]).includes(row.state));
    expect(
      badKind.map((r) => `line ${r.line}: ${r.kind}`),
      'unknown Kind',
    ).toEqual([]);
    expect(
      badState.map((r) => `line ${r.line}: ${r.state}`),
      'unknown State',
    ).toEqual([]);

    const keys = rows.map((row) => `${row.kind}:${row.id}`);
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);
    expect(duplicates, 'a feature is listed twice').toEqual([]);
  });

  it('the generator reproduces team/FEATURES.md byte for byte, deterministically', () => {
    const first = runGenerator('--stdout');
    expect(first.status, `--stdout failed: ${first.stderr}`).toBe(0);
    expect(first.stdout, 'regenerating changes the committed register').toBe(registerText);
    expect(registerText.includes('\r'), 'the register must be LF-only').toBe(false);

    const second = runGenerator('--stdout');
    expect(second.stdout, 'two runs disagree: the output is not deterministic').toBe(first.stdout);

    // core.autocrlf on Windows would otherwise hand the file back with CRLF.
    const attributes = readFileSync(fromRoot('.gitattributes'), 'utf8');
    expect(attributes).toMatch(/^team\/FEATURES\.md\s+.*\beol=lf\b/m);
  });

  it('--check passes on the committed register and fails on a stale one', () => {
    const clean = runGenerator('--check');
    expect(clean.status, `--check fails on the committed register: ${clean.stderr}`).toBe(0);

    // Two kinds of drift: a row removed, and a state changed.
    const firstRow = rows[0];
    expect(firstRow, 'no row to tamper with').toBeDefined();
    if (firstRow === undefined) return;
    const lines = registerText.split('\n');
    const removed = lines.filter((_, i) => i !== firstRow.line - 1).join('\n');
    const otherState = firstRow.state === 'built' ? 'not-started' : 'built';
    const flipped = lines
      .map((line, i) => {
        if (i !== firstRow.line - 1) return line;
        // Cell 4 (State) counting the empty cell before the leading pipe.
        const cells = line.split(/(?<!\\)\|/);
        cells[4] = ` ${otherState} `;
        return cells.join('|');
      })
      .join('\n');
    expect(flipped, 'could not flip the state of the first row').not.toBe(registerText);

    const dir = mkdtempSync(resolve(tmpdir(), 'kasuwa-features-'));
    try {
      for (const [name, text] of [
        ['removed.md', removed],
        ['flipped.md', flipped],
      ] as const) {
        const path = resolve(dir, name);
        writeFileSync(path, text, 'utf8');
        const result = runGenerator('--check', '--file', path);
        expect(result.status, `--check accepted a stale register (${name})`).not.toBe(0);
        expect(result.status, `--check crashed rather than reporting (${name})`).not.toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('acceptance: every feature has a row with its true state (D-L36)', () => {
  it('every flag in the registry has a row with its state and the decisions that own it', () => {
    const names = Object.keys(FLAGS) as (keyof typeof FLAGS)[];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const definition = FLAGS[name];
      const row = rowFor('flag', name);
      expect(row, `flag ${name} has no row`).toBeDefined();
      if (row === undefined) continue;
      const expected: State = definition.defaultValue ? 'built' : 'flagged-off';
      expect(row.state, `flag ${name}`).toBe(expected);
      expect(row.flag, `flag ${name}: its own Flag cell`).toBe(name);
      for (const decision of definition.owner.match(/\bD-[A-Z]+\d+\b/g) ?? []) {
        expect(namesDecision(row.decision, decision), `flag ${name} omits ${decision}`).toBe(true);
      }
    }
  });

  it('every OpenAPI operation has a row whose state matches x-kasuwa-implemented', () => {
    expect(operations.length, 'no operations parsed from docs/api').toBeGreaterThan(40);
    const allowed: Record<string, readonly State[]> = {
      true: ['built'],
      partial: ['partial'],
      false: ['not-started', 'deferred'],
    };
    const problems: string[] = [];
    for (const op of operations) {
      const states = allowed[op.implemented];
      if (states === undefined) {
        problems.push(`${op.operationId}: x-kasuwa-implemented is ${op.implemented}`);
        continue;
      }
      const row = rowFor('operation', op.operationId);
      if (row === undefined) {
        problems.push(`${op.operationId}: no row`);
        continue;
      }
      if (!states.includes(row.state as State)) {
        problems.push(`${op.operationId}: ${row.state}, spec says ${op.implemented}`);
      }
      if (!row.source.includes(op.file)) {
        problems.push(`${op.operationId}: Source does not name ${op.file}`);
      }
    }
    expect(problems).toEqual([]);

    // No phantom operations either: a row for an operation that no longer
    // exists is the register lying in the other direction.
    const known = new Set(operations.map((op) => op.operationId));
    const phantoms = rowsOf('operation').filter((row) => !known.has(row.id));
    expect(
      phantoms.map((r) => r.id),
      'operation rows with no operation',
    ).toEqual([]);
  });

  it('every PRD module has a row', () => {
    expect(prdModules.length).toBe(23);
    const missing = prdModules.filter((id) => rowFor('module', id) === undefined);
    expect(missing, 'PRD modules missing from the register').toEqual([]);
  });

  it('every P01 and P02 screen has a row, and none claims more than its backend allows', () => {
    expect(allScreens.length, 'screen manifests not parsed').toBe(16 + 22);
    const missing = allScreens.filter((id) => rowFor('screen', id) === undefined);
    expect(missing, 'screens missing from the register').toEqual([]);

    // A screen named by a flag's description is behind that flag.
    const problems: string[] = [];
    for (const [name, definition] of Object.entries(FLAGS)) {
      const gated = definition.description.match(/\bP\d{2}\/[\w.]+/g) ?? [];
      for (const screen of gated) {
        const row = rowFor('screen', screen);
        if (row === undefined) continue; // reported above
        if (row.flag !== name) problems.push(`${screen}: Flag is "${row.flag}", expected ${name}`);
        if (!definition.defaultValue && row.state !== 'flagged-off') {
          problems.push(`${screen}: ${row.state}, but ${name} is off by default`);
        }
      }
    }

    // A screen every one of whose backing operations is contract-only cannot
    // be `built` — it is on the mock (P02/B2 KPIs, P02/B3 skill cover).
    const backing = new Map<string, string[]>();
    for (const op of operations) {
      for (const screen of op.screens)
        backing.set(screen, [...(backing.get(screen) ?? []), op.implemented]);
    }
    for (const screen of allScreens) {
      const row = rowFor('screen', screen);
      if (row === undefined) continue;
      const implemented = backing.get(screen);
      if (implemented !== undefined && implemented.every((value) => value === 'false')) {
        if (row.state === 'built') problems.push(`${screen}: built, but no operation behind it is`);
      }
      if (notBuiltScreens.has(screen) && row.state === 'built') {
        problems.push(`${screen}: built, but its e2e manifest lists it as not built`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every DEFERRED decision, and every feature it holds back, has a row naming the decision', () => {
    const deferred = deferredDecisions();
    // D-T1..D-T5, D-W1, D-W2 on 2026-10-03. A parse that finds none is broken.
    expect(deferred.length, 'no DEFERRED decisions parsed').toBeGreaterThanOrEqual(7);
    const unnamed = deferred.filter(
      (id) => !rows.some((row) => row.state === 'deferred' && namesDecision(row.decision, id)),
    );
    expect(unnamed, 'DEFERRED decisions with no deferred row naming them').toEqual([]);

    // DECISION-LOG 2026-10-03: KPIs and skill cover stay unbuilt because their
    // data comes from the deferred telephony and WFM work. M9 is that work.
    const heldBack: [Kind, string][] = [
      ['operation', 'getProgrammeKpis'],
      ['operation', 'getProgrammeSkillCover'],
      ['module', 'M09'],
    ];
    for (const [kind, id] of heldBack) {
      const row = rowFor(kind, id);
      expect(row, `${kind} ${id} has no row`).toBeDefined();
      if (row === undefined) continue;
      expect(row.state, `${kind} ${id}`).toBe('deferred');
      expect(row.decision, `${kind} ${id} must name the D-T/D-W decision`).toMatch(/\bD-[TW]\d+\b/);
    }

    // Every deferred row says why; a deferral with no decision is a burial.
    const silent = rows.filter(
      (row) => row.state === 'deferred' && !/\bD-[A-Z]+\d+\b/.test(row.decision),
    );
    expect(
      silent.map((r) => `${r.kind} ${r.id}`),
      'deferred rows naming no decision',
    ).toEqual([]);
  });
});

describe('acceptance: CI enforces the register and mirrors the git hooks (D-L36, D-L34)', () => {
  it('a blocking job on every pull request runs the register check', () => {
    const check = blockingPrSteps(/generate-features\.mjs[^\n]*--check/);
    expect(check.length, 'no blocking pull_request step runs the register --check').toBeGreaterThan(
      0,
    );
  });

  it('CI runs commitlint over the pull request commit range, blocking', () => {
    // The commit-msg hook runs commitlint; `git commit --no-verify` skips it.
    expect(readFileSync(fromRoot('.husky/commit-msg'), 'utf8')).toMatch(/\bcommitlint\b/);

    const cli = blockingPrSteps(/\bcommitlint\b[^\n]*--from\b/);
    const action = blockingPrSteps(/wagoid\/commitlint-github-action/);
    expect(
      cli.length + action.length,
      'no blocking pull_request step runs commitlint over a commit range (--from …, or the action)',
    ).toBeGreaterThan(0);

    // The CLI form needs the PR's history; a depth-1 checkout has one commit
    // and lints nothing it was meant to.
    for (const { workflow, job } of cli) {
      const checkout = job.steps.find((step) => step.uses.startsWith('actions/checkout'));
      expect(checkout?.with['fetch-depth'], `${workflow.file}#${job.id}: shallow checkout`).toBe(0);
    }
  });

  it('every target the pre-commit hook runs is also run, blocking, on pull requests', () => {
    const hook = readFileSync(fromRoot('.husky/pre-commit'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const targets = [
      ...hook.matchAll(/\bnx\s+(?:affected|run-many)\b[^\n]*?-t\s+([\w\s,-]+?)(?:\s--|\s*$)/gm),
    ]
      .flatMap((match) => (match[1] ?? '').split(/[\s,]+/))
      .filter((target) => target !== '');
    expect(targets, 'could not read the targets the pre-commit hook runs').toContain('lint');

    for (const target of targets) {
      const mirrored = blockingPrSteps(
        new RegExp(`\\bnx\\s+(?:affected|run-many)\\b[^\\n]*-t\\s+[\\w\\s,-]*\\b${target}\\b`),
      );
      expect(
        mirrored.length,
        `pre-commit runs "${target}" but no blocking PR job does`,
      ).toBeGreaterThan(0);
    }
  });
});
