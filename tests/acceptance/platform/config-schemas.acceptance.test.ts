import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ACCEPTANCE — T-0014, per-process environment schemas (Agent 1, Platform & Security).
 *
 * The contract, and the only surface this file assumes:
 *
 *   `@kasuwa/config` exports `apiEnv`, `webEnv`, `workerEnv` and `realtimeEnv`.
 *   Each takes ONE argument, a plain environment object
 *   (`Readonly<Record<string, string | undefined>>`, the same shape
 *   `enabledFeatureFlags` and `flagProcessNodeEnv` take, and compatible with
 *   `parseEnv`'s `NodeJS.ProcessEnv`). It returns the parsed environment or
 *   throws. A default of `process.env` is fine. Reading `process.env` when an
 *   argument WAS given is not, and the tests below would catch it.
 *
 * Everything else belongs to the implementer: the shape of the base schema,
 * the return types, whether each process gets its own file, and how dotenv
 * loading is arranged.
 *
 * One thing to think about, stated here so nobody finds it late. The index
 * module loads the workspace `.env` when it is imported, and in development
 * that file holds `DATABASE_URL`. If the web process imports the index and
 * calls `webEnv()` with its default of `process.env`, the dotenv load puts the
 * very variable `webEnv` must reject into the web process's own environment.
 * These tests pass explicit objects, so they do not force an answer. The
 * running web app will.
 *
 * Every export is resolved through `exported()` and a dynamic import, so the
 * suite still collects before T-0014 lands. Each test then fails on its own
 * line, naming the missing function, and the file does not crash at import
 * (D-L23: fail for a real reason, and say which).
 */

type Env = Readonly<Record<string, string | undefined>>;
type EnvFn = (source: Env) => unknown;
type ProcessName = 'apiEnv' | 'webEnv' | 'workerEnv' | 'realtimeEnv';

const PROCESSES: readonly ProcessName[] = ['apiEnv', 'webEnv', 'workerEnv', 'realtimeEnv'];

function isEnvFn(candidate: unknown): candidate is EnvFn {
  return typeof candidate === 'function';
}

async function exported(name: ProcessName): Promise<EnvFn> {
  const module: Record<string, unknown> = { ...(await import('@kasuwa/config')) };
  const candidate = module[name];
  expect(
    typeof candidate,
    `@kasuwa/config does not export ${name}(env) — T-0014 scope 2 requires one schema per process`,
  ).toBe('function');
  if (!isEnvFn(candidate)) {
    throw new Error(`unreachable: ${name} is not a function`);
  }
  return candidate;
}

/** The error a call throws. Fails the test, with a reason, if it does not throw. */
function thrownBy(call: () => unknown, because: string): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`${because}: threw a non-Error value (${String(error)})`);
  }
  throw new Error(`${because}: it did not throw`);
}

// ---------------------------------------------------------------------------
// Fixtures. Invented values only. The password-like token in the database URL
// is there so that a test can check it never shows up in an error message.
// ---------------------------------------------------------------------------

/**
 * A real process environment carries plenty a schema knows nothing about.
 * Every fixture includes these. A schema that rejects every unknown key would
 * otherwise pass "rejects DATABASE_URL" for the wrong reason, and then fail to
 * boot on PATH.
 */
const AMBIENT: Env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/kasuwa',
  LANG: 'C.UTF-8',
  HOSTNAME: 'kasuwa-test-host',
};

const LEAK_MARKER = 'n0t-a-real-pw-7f3k';
const DATABASE_URL = `postgres://kasuwa_app:${LEAK_MARKER}@db.internal.example:5432/kasuwa`;
const DATABASE_MIGRATION_URL = `postgres://kasuwa_migrator:${LEAK_MARKER}@db.internal.example:5432/kasuwa`;
/**
 * The auth module's own connection (T-0049, D-P16). apiEnv requires it, so
 * every API environment below that is meant to parse carries it, and every one
 * meant to fail for a DIFFERENT variable carries it too, so the failure can
 * only be the variable under test.
 */
const DATABASE_AUTH_URL = `postgres://kasuwa_auth:${LEAK_MARKER}@db.internal.example:5432/kasuwa`;

/** Development, nothing API-specific: what the web process legitimately starts with. */
const WEB_DEV: Env = { ...AMBIENT, NODE_ENV: 'development' };

/**
 * Production, with every OTHER production guard satisfied, so the only thing
 * that can make it fail is the auth mode. Without this control, a stub-mode
 * failure could just as well be the key-provider or throttle guard firing, and
 * "assertAuthModeIsSafe runs" would be proved by a different assertion.
 */
const SERVER_PROD_SAFE: Env = {
  ...AMBIENT,
  NODE_ENV: 'production',
  KASUWA_AUTH_MODE: 'jwt',
  KASUWA_CELL: 'za-1',
  DATABASE_URL,
  DATABASE_AUTH_URL,
  REDIS_URL: 'redis://redis.internal.example:6379',
  KASUWA_TRUST_PROXY_HOPS: '1',
  KASUWA_KMS_PROVIDER: 'aws-kms',
  KASUWA_KMS_KEY_ID: 'alias/kasuwa-acceptance',
};

/** The web process in production: no database, no KMS, no throttle. */
const WEB_PROD_SAFE: Env = {
  ...AMBIENT,
  NODE_ENV: 'production',
  KASUWA_AUTH_MODE: 'jwt',
  KASUWA_CELL: 'za-1',
  NEXT_PUBLIC_API_URL: 'https://api.example.test',
};

/**
 * The relay's own connection (T-0098, ADR-0018, D-L156). workerEnv requires
 * it and every other process refuses it by presence, so it is added for the
 * worker alone rather than to SERVER_PROD_SAFE, which apiEnv and realtimeEnv
 * share.
 */
const DATABASE_RELAY_URL = `postgres://kasuwa_relay:${LEAK_MARKER}@db.internal.example:5432/kasuwa`;

function productionSafeFor(name: ProcessName): Env {
  if (name === 'webEnv') return WEB_PROD_SAFE;
  if (name === 'workerEnv') return { ...SERVER_PROD_SAFE, DATABASE_RELAY_URL };
  return SERVER_PROD_SAFE;
}

function without(env: Env, key: string): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. webEnv() does not accept DATABASE_URL. "Not required" is not enough.
// ---------------------------------------------------------------------------

describe('acceptance: the web schema refuses a database url', () => {
  it('accepts a plain web environment, so the rejection below means something', async () => {
    // The control. A webEnv that throws on everything also "rejects
    // DATABASE_URL", and without this test that would count as a pass.
    const webEnv = await exported('webEnv');
    expect(() => webEnv(WEB_DEV)).not.toThrow();
  });

  it('throws when DATABASE_URL is present, rather than stripping it', async () => {
    const webEnv = await exported('webEnv');
    // By default Zod's object() strips unknown keys without complaint. That is
    // exactly the "tolerates it" behaviour the task forbids.
    const error = thrownBy(
      () => webEnv({ ...WEB_DEV, DATABASE_URL }),
      'webEnv accepted an environment holding DATABASE_URL',
    );
    expect(error.message, 'the error should name the variable it refused').toMatch(/DATABASE_URL/);
    // The refusal must not echo the credential it refused. Security guardrail
    // 3: secrets come from the environment. An error message is not where they go.
    expect(error.message, 'the error message leaked the database credential').not.toContain(
      LEAK_MARKER,
    );
  });

  it('throws on DATABASE_URL in production as well, so it is not a dev-only check', async () => {
    const webEnv = await exported('webEnv');
    expect(() => webEnv(WEB_PROD_SAFE)).not.toThrow();
    expect(() => webEnv({ ...WEB_PROD_SAFE, DATABASE_URL })).toThrow(/DATABASE_URL/);
  });

  it('throws on DATABASE_MIGRATION_URL too, the BYPASSRLS connection', async () => {
    // The same invariant as above ("a browser-facing process holding a
    // database URL"), applied to the worst database URL there is (D-L07,
    // D-L54). Blocking DATABASE_URL by name while still accepting this one
    // would honour the letter of scope 3 and break its point.
    const webEnv = await exported('webEnv');
    const error = thrownBy(
      () => webEnv({ ...WEB_DEV, DATABASE_MIGRATION_URL }),
      'webEnv accepted an environment holding DATABASE_MIGRATION_URL',
    );
    expect(error.message).toMatch(/DATABASE_MIGRATION_URL/);
    expect(error.message).not.toContain(LEAK_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail at boot, in the process that needs it, and only there.
// ---------------------------------------------------------------------------

describe('acceptance: a missing API-only variable fails the API and only the API', () => {
  it('fails apiEnv() without DATABASE_URL', async () => {
    const apiEnv = await exported('apiEnv');
    // The control: the same environment WITH the variable parses. Without it,
    // an apiEnv that fails on anything would satisfy the next assertion.
    expect(() =>
      apiEnv({ ...AMBIENT, NODE_ENV: 'development', DATABASE_URL, DATABASE_AUTH_URL }),
    ).not.toThrow();
    expect(() => apiEnv({ ...AMBIENT, NODE_ENV: 'development', DATABASE_AUTH_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('does not fail webEnv() on the same environment', async () => {
    const webEnv = await exported('webEnv');
    expect(() => webEnv({ ...AMBIENT, NODE_ENV: 'development' })).not.toThrow();
  });

  it('judges the environment it is GIVEN, not the ambient process.env', async () => {
    // Today, importing @kasuwa/config runs dotenv, and in CI DATABASE_URL is
    // set on the runner, so process.env can hold a database URL either way.
    // Stubbing it pins that down. If either function merges process.env into
    // its argument, one of these assertions fails: webEnv would see a
    // DATABASE_URL it was not given, and apiEnv would find one it was not given.
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
    const apiEnv = await exported('apiEnv');
    const webEnv = await exported('webEnv');
    expect(() => webEnv({ ...AMBIENT, NODE_ENV: 'development' })).not.toThrow();
    expect(() => apiEnv({ ...AMBIENT, NODE_ENV: 'development', DATABASE_AUTH_URL })).toThrow(
      /DATABASE_URL/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. assertAuthModeIsSafe runs in every process schema.
// ---------------------------------------------------------------------------

describe('acceptance: stub auth cannot boot in production in any process', () => {
  /**
   * "The worst outcome of this task" (T-0014): a refactor that leaves the
   * guard in the API schema and drops it from another one. The four processes
   * are listed out on purpose. A loop over whatever the module happens to
   * export could quietly skip one that was never written.
   */
  for (const name of PROCESSES) {
    it(`${name}: a production environment with a real auth mode boots`, async () => {
      // The control for the two tests below.
      const parse = await exported(name);
      expect(() => parse(productionSafeFor(name))).not.toThrow();
    });

    it(`${name}: KASUWA_AUTH_MODE=stub with NODE_ENV=production refuses to start`, async () => {
      const parse = await exported(name);
      const error = thrownBy(
        () => parse({ ...productionSafeFor(name), KASUWA_AUTH_MODE: 'stub' }),
        `${name} booted stub auth under NODE_ENV=production`,
      );
      // The guard's own message, so a different validation error that happens
      // to fire on the same input cannot stand in for it.
      expect(error.message).toMatch(/Refusing to start/);
      expect(error.message).toMatch(/KASUWA_AUTH_MODE=stub/);
    });

    it(`${name}: an UNSET auth mode in production refuses too, because the default is stub`, async () => {
      // KASUWA_AUTH_MODE defaults to 'stub' today. A process schema that leaves
      // the field out, perhaps because "this process does not do auth", would
      // pass undefined to the guard, and the guard would let it through. This
      // is the quiet way to lose it. The non-goals rule out changing what a
      // process reads, so the default stays and so does the refusal.
      const parse = await exported(name);
      const error = thrownBy(
        () => parse(without(productionSafeFor(name), 'KASUWA_AUTH_MODE')),
        `${name} booted under NODE_ENV=production with no auth mode, i.e. the stub default`,
      );
      expect(error.message).toMatch(/Refusing to start/);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. No process.env read outside @kasuwa/config, apart from a named exemption.
// ---------------------------------------------------------------------------

/**
 * THE EXEMPTION LIST, AND WHY IT IS THIS SHORT.
 *
 * Today `eslint.config.mjs` exempts `packages/config/**`, `tools/**`, and
 * every `**\/*.config.ts` and `**\/*.config.mjs`. That last pair is a wildcard,
 * not a named exemption, and it is how `apps/web/next.config.mjs` got to read
 * three variables. Lint is also weaker than it looks: `no-restricted-syntax`
 * is configured for `*.ts`/`*.tsx` only, and each project lints only the paths
 * in its own `lint` script. `apps/web`'s script covers `app components lib
 * instrumentation.ts`, so `middleware.ts`, `build.mjs` and `next.config.mjs`
 * are never linted at all. That is why this test reads the source itself
 * rather than trusting the lint config.
 *
 * - `apps/web/next.config.mjs` is NOT exempt. T-0014 scope 5 says to migrate
 *   it, and Next 15 loads `next.config.ts`, so a config that gets its values
 *   from `webEnv()` is possible in principle. If Next's config loading turns
 *   out to make that impossible, that is the task's own "escalate if" clause.
 *   The answer is a decision in DECISIONS.md, then an edit to this list by the
 *   lead. A builder does not widen it.
 *
 * - `apps/web/build.mjs` IS exempt, and only for the spread `...process.env`.
 *   It hands the whole environment, unread, to the `next build` child process
 *   with NODE_ENV overridden. It reads no value and makes no configuration
 *   decision, so the rule's purpose (parse configuration at one validated
 *   boundary) does not apply. Node has no other way to override one variable
 *   for a child process while passing the rest through. Any OTHER access in
 *   that file, such as `process.env.FOO`, is still a violation.
 *
 * If the implementer removes the spread, the exemption just goes unused. This
 * test does not require it to exist.
 */
const ALLOWED: ReadonlyArray<{ file: string; form: 'spread'; why: string }> = [
  {
    file: 'apps/web/build.mjs',
    form: 'spread',
    why: 'forwards the environment unread to the `next build` child, overriding NODE_ENV',
  },
];

const repoRoot = resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.nx', '.turbo']);
const SKIP_PATHS = new Set(['packages/config']);
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

interface EnvRead {
  file: string;
  line: number;
  form: 'member' | 'element' | 'destructure' | 'process-module' | 'spread';
  text: string;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const fromRoot = toPosix(relative(repoRoot, full));
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name) && !SKIP_PATHS.has(fromRoot)) {
        sourceFiles(full, found);
      }
    } else if (SOURCE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `process`, `globalThis.process`, `global.process`, `globalThis['process']`. */
function isProcess(node: ts.Expression): boolean {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) {
    return target.text === 'process';
  }
  const holder = (expression: ts.Expression): boolean => {
    const inner = unwrap(expression);
    return (
      ts.isIdentifier(inner) && ['globalThis', 'global', 'window', 'self'].includes(inner.text)
    );
  };
  if (ts.isPropertyAccessExpression(target)) {
    return target.name.text === 'process' && holder(target.expression);
  }
  if (ts.isElementAccessExpression(target)) {
    const key = target.argumentExpression;
    return ts.isStringLiteralLike(key) && key.text === 'process' && holder(target.expression);
  }
  return false;
}

function bindsEnv(pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression): boolean {
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.some((element) => {
      const key = element.propertyName ?? element.name;
      return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'env';
    });
  }
  return pattern.properties.some((property) => {
    const key = property.name;
    return (
      key !== undefined &&
      (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
      key.text === 'env'
    );
  });
}

function isProcessModuleLoad(call: ts.CallExpression): boolean {
  const [specifier] = call.arguments;
  if (
    call.arguments.length !== 1 ||
    specifier === undefined ||
    !ts.isStringLiteralLike(specifier)
  ) {
    return false;
  }
  if (!['process', 'node:process'].includes(specifier.text)) {
    return false;
  }
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    callee.kind === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * Every way a file can get at the process environment, found in the AST, so a
 * comment or a string that MENTIONS process.env is not counted (several files
 * here say "no process.env is needed" in a comment), and a read written to
 * slip past the lint selector still is.
 */
function findEnvReads(fileName: string, text: string): EnvRead[] {
  const kind = /\.[cm]?jsx?$/u.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const reads: EnvRead[] = [];
  const record = (node: ts.Node, form: EnvRead['form']): void => {
    reads.push({
      file: fileName,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      form,
      text: node.getText(source).slice(0, 80),
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      isProcess(node.expression)
    ) {
      const parent = node.parent;
      const spread =
        (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) && parent.expression === node;
      record(node, spread ? 'spread' : 'member');
    } else if (ts.isElementAccessExpression(node) && isProcess(node.expression)) {
      // process['env'], or process[key] with a key no reader can check.
      const key = node.argumentExpression;
      if (!ts.isStringLiteralLike(key) || key.text === 'env') {
        record(node, 'element');
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (
        ts.isObjectBindingPattern(node.name) &&
        isProcess(node.initializer) &&
        bindsEnv(node.name)
      ) {
        record(node, 'destructure');
      }
      // `const e = process.env` is already counted as a member read below it.
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcess(node.right) &&
      ts.isObjectLiteralExpression(unwrap(node.left))
    ) {
      const left = unwrap(node.left);
      if (ts.isObjectLiteralExpression(left) && bindsEnv(left)) {
        record(node, 'destructure');
      }
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['process', 'node:process'].includes(node.moduleSpecifier.text)
    ) {
      // `import { env } from 'node:process'`, or a default import that renames
      // `process` so that `p.env` no longer looks like process.env to anyone.
      record(node, 'process-module');
    } else if (ts.isCallExpression(node) && isProcessModuleLoad(node)) {
      // `require('node:process')` or `await import('process')`.
      record(node, 'process-module');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

function isAllowed(read: EnvRead): boolean {
  return ALLOWED.some((exemption) => exemption.file === read.file && exemption.form === read.form);
}

describe('acceptance: the env-read detector can fail (so a clean scan means something)', () => {
  /**
   * The scan below should find NOTHING once T-0014 is done, and a scan that
   * finds nothing looks the same as a detector that never fires. These cases
   * show it does fire, on every form it claims to catch, and that it ignores
   * comments and strings, which is where most of this repository's mentions
   * of process.env actually are.
   */
  const caught: ReadonlyArray<[string, EnvRead['form']]> = [
    ['const a = process.env.DATABASE_URL;', 'member'],
    ["const a = process['env'].DATABASE_URL;", 'element'],
    ['const a = process[`env`];', 'element'],
    ['const k = "env"; const a = process[k];', 'element'],
    ['const a = globalThis.process.env.X;', 'member'],
    ["const a = globalThis['process'].env.X;", 'member'],
    ['const a = (process as NodeJS.Process).env;', 'member'],
    ['const { env } = process;', 'destructure'],
    ['const { env: e } = globalThis.process;', 'destructure'],
    ["import { env } from 'node:process';", 'process-module'],
    ["import p from 'process';", 'process-module'],
    ["const p = require('node:process');", 'process-module'],
    ["const p = await import('process');", 'process-module'],
    ['const x = { ...process.env };', 'spread'],
  ];

  for (const [snippet, form] of caught) {
    it(`catches ${snippet}`, () => {
      const forms = findEnvReads('probe.ts', snippet).map((read) => read.form);
      expect(forms, `the detector missed: ${snippet}`).toContain(form);
    });
  }

  it('ignores mentions in comments and strings', () => {
    const benign = [
      '// no process.env is needed here',
      '/* process.env.DATABASE_URL */',
      "const s = 'process.env.DATABASE_URL';",
      'const t = `process.env`;',
      'const o = { env: 1 }; const { env } = o;',
      'type T = typeof process.env;',
      'declare const x: NodeJS.ProcessEnv;',
    ].join('\n');
    expect(findEnvReads('probe.ts', benign)).toEqual([]);
  });

  it('flags a member read in the exempt file; only the spread form is exempt', () => {
    const reads = findEnvReads('apps/web/build.mjs', 'const a = process.env.NEXT_PUBLIC_API_URL;');
    expect(reads.map(isAllowed)).toEqual([false]);
    const spread = findEnvReads('apps/web/build.mjs', 'spawn(x, [], { env: { ...process.env } });');
    expect(spread.map(isAllowed)).toEqual([true]);
  });
});

describe('acceptance: no process.env read outside @kasuwa/config', () => {
  it('finds none in apps/** or packages/** beyond the named exemption', () => {
    const files = SCAN_ROOTS.flatMap((root) => sourceFiles(resolve(repoRoot, root)));
    const scanned = new Set(files.map((file) => toPosix(relative(repoRoot, file))));

    // Not vacuous: the walk really reached the files that matter. If an
    // extension filter or a skip rule quietly dropped them, the scan would
    // come back clean for the wrong reason.
    for (const mustScan of [
      'apps/web/next.config.mjs',
      'apps/web/build.mjs',
      'apps/web/middleware.ts',
      'apps/api/src/main.ts',
      'apps/worker/src/main.ts',
      'apps/realtime/src/main.ts',
    ]) {
      expect(scanned.has(mustScan), `the scan never reached ${mustScan}`).toBe(true);
    }
    expect(
      [...scanned].some((file) => file.startsWith('packages/config/')),
      'packages/config is the one place allowed to read process.env; it must be skipped',
    ).toBe(false);

    const violations = files
      .flatMap((file) =>
        findEnvReads(toPosix(relative(repoRoot, file)), readFileSync(file, 'utf8')),
      )
      .filter((read) => !isAllowed(read))
      .map((read) => `${read.file}:${read.line} [${read.form}] ${read.text}`);

    expect(
      violations,
      'process.env is read outside @kasuwa/config. Route it through the process schema ' +
        '(apiEnv/webEnv/workerEnv/realtimeEnv), or raise a decision; do not extend ALLOWED',
    ).toEqual([]);
  });
});
