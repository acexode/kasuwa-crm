import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0010, a production build in the e2e path and a real byte
 * budget on the sign-in critical path (PRD 2.13, D-L28).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE IS PROTECTING
 *
 * T-0008 proved the budget machinery fires. It did not make the number mean
 * anything: the harness serves `next dev`, so the bytes it counts are a
 * development bundle. D-L28 answered how to fix that — build `apps/web` for
 * production, measure the gzipped critical path against it, and fail on
 * regression. Each of the four ways that can quietly go wrong gets a test:
 *
 *   1. the stack still serves a dev bundle (or a static export we do not ship)
 *   2. the figure is decoded bytes, not gzipped transfer — a ~3x error
 *   3. the budget is pinned at the 300 KB ceiling instead of near today's
 *      weight, so it never catches the regression it exists for
 *   4. "critical path" is whatever the measurer wanted, and a lazy chunk that
 *      loads after first paint is counted (or a blocking one is not)
 * ------------------------------------------------------------------------
 *
 * THE INTERFACE THE BUILDER MUST PROVIDE
 *
 * A. Module `tests/e2e/support/critical-path.ts`, importable WITHOUT a browser
 *    (type-only imports from Playwright are fine; no runtime launch at import):
 *
 *      export interface CapturedResource {
 *        url: string;
 *        // the CDP Network.ResourceType string: 'Document' | 'Script' |
 *        // 'Stylesheet' | 'Font' | 'Image' | 'Fetch' | 'XHR' | 'Other' | ...
 *        resourceType: string;
 *        startedAtMs: number;   // request sent, ms after navigation start
 *        transferBytes: number; // what crossed the wire (CDP encodedDataLength)
 *        decodedBytes: number;  // the body after content decoding
 *      }
 *
 *      export const CRITICAL_PATH_RULE: {
 *        route: string;                       // the sign-in route: '/'
 *        resourceTypes: readonly string[];    // exactly Document, Script, Stylesheet, Font
 *        cutoff: 'first-contentful-paint';    // requested at or before FCP
 *      };
 *
 *      export function measureCriticalPath(
 *        resources: readonly CapturedResource[],
 *        fcpMs: number,
 *      ): {
 *        counted: CapturedResource[];   // resources the rule includes
 *        excluded: CapturedResource[];  // everything else
 *        gzippedBytes: number;          // sum of counted transferBytes
 *        rawBytes: number;              // sum of counted decodedBytes
 *      };
 *
 *      export const SIGN_IN_CRITICAL_PATH_BUDGET_BYTES: number;
 *
 *      // Throws when gzippedBytes > budgetBytes. The message names the route,
 *      // the measured bytes, the budget and the overage, and says "budget".
 *      export function assertCriticalPathWithinBudget(
 *        route: string,
 *        gzippedBytes: number,
 *        budgetBytes: number,
 *      ): void;
 *
 * B. A Playwright test tagged `@byte-budget`. `pnpm test:e2e -- --grep
 *    @byte-budget` builds `apps/web` for production, serves the BUILT app
 *    (`next start`, not `next dev`, not a static export), loads the sign-in
 *    route, applies `assertCriticalPathWithinBudget`, and writes
 *    `tests/e2e/.artifacts/critical-path.json`:
 *
 *      {
 *        "route": "/",
 *        "fcpMs": number,
 *        "gzippedBytes": number,
 *        "rawBytes": number,
 *        "budgetBytes": number,
 *        "buildId": string,              // what the served build reports
 *        "resources": [ CapturedResource & {
 *          "contentEncoding": string | null,   // response Content-Encoding
 *          "cacheControl": string | null,      // response Cache-Control
 *          "counted": boolean
 *        } ]
 *      }
 *
 * No implementation detail beyond those names is fixed here.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const MODULE = 'tests/e2e/support/critical-path.ts';
const ARTIFACT = 'tests/e2e/.artifacts/critical-path.json';
const BUILD_ID = 'apps/web/.next/BUILD_ID';

/** PRD 2.13, read strictly: 300 KB as 300,000 bytes, not 300 KiB. */
const NFR_CEILING_BYTES = 300_000;

/** A build plus a container plus a browser. Same allowance as the T-0008 suite. */
const STACK_RUN_TIMEOUT_MS = 600_000;

interface CapturedResource {
  url: string;
  resourceType: string;
  startedAtMs: number;
  transferBytes: number;
  decodedBytes: number;
}

interface CriticalPathModule {
  CRITICAL_PATH_RULE: {
    route: string;
    resourceTypes: readonly string[];
    cutoff: string;
  };
  measureCriticalPath: (
    resources: readonly CapturedResource[],
    fcpMs: number,
  ) => {
    counted: CapturedResource[];
    excluded: CapturedResource[];
    gzippedBytes: number;
    rawBytes: number;
  };
  SIGN_IN_CRITICAL_PATH_BUDGET_BYTES: number;
  assertCriticalPathWithinBudget: (
    route: string,
    gzippedBytes: number,
    budgetBytes: number,
  ) => void;
}

interface RecordedResource extends CapturedResource {
  contentEncoding: string | null;
  cacheControl: string | null;
  counted: boolean;
}

interface CriticalPathArtifact {
  route: string;
  fcpMs: number;
  gzippedBytes: number;
  rawBytes: number;
  budgetBytes: number;
  buildId: string;
  resources: RecordedResource[];
}

async function loadModule(): Promise<CriticalPathModule> {
  const path = fromRoot(MODULE);
  expect(existsSync(path), `${MODULE} does not exist`).toBe(true);
  return (await import(path)) as CriticalPathModule;
}

/**
 * A resource record whose two sizes are REAL: the body is gzipped here, with
 * the same algorithm a production server applies, so the gap between raw and
 * gzipped is a measured fact about the fixture rather than a number typed in.
 */
function resourceFromBody(
  url: string,
  resourceType: string,
  startedAtMs: number,
  body: Buffer,
): CapturedResource {
  return {
    url,
    resourceType,
    startedAtMs,
    transferBytes: gzipSync(body).byteLength,
    decodedBytes: body.byteLength,
  };
}

/** Highly compressible, like minified JS: raw and gzipped differ by ~two orders. */
function compressibleBody(bytes: number): Buffer {
  const unit = 'function k(a,b){return a.map(function(c){return c+b})}\n';
  return Buffer.from(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes), 'utf8');
}

describe('acceptance: the critical path is a rule in code, not a judgement', () => {
  it('states the rule: sign-in route, documents/scripts/styles/fonts, up to first paint', async () => {
    // D-L28: "state what counts". A rule that lives in a comment or a PR
    // description becomes whatever the next person measuring wants it to be.
    const { CRITICAL_PATH_RULE } = await loadModule();

    expect(CRITICAL_PATH_RULE.route, 'the sign-in route is `/` (apps/web/app/page.tsx)').toBe('/');
    expect([...CRITICAL_PATH_RULE.resourceTypes].sort()).toEqual(
      ['Document', 'Font', 'Script', 'Stylesheet'].sort(),
    );
    expect(CRITICAL_PATH_RULE.cutoff).toBe('first-contentful-paint');
  });

  it('counts what first paint needs and nothing loaded lazily after it', async () => {
    const { measureCriticalPath } = await loadModule();

    const fcpMs = 400;
    const html = resourceFromBody('http://web/', 'Document', 0, compressibleBody(8_000));
    const css = resourceFromBody(
      'http://web/_next/static/css/app.css',
      'Stylesheet',
      40,
      compressibleBody(12_000),
    );
    const main = resourceFromBody(
      'http://web/_next/static/chunks/main.js',
      'Script',
      50,
      compressibleBody(90_000),
    );
    const font: CapturedResource = {
      url: 'http://web/fonts/noto-sans-latin.woff2',
      resourceType: 'Font',
      startedAtMs: 120,
      // woff2 is already compressed; a server does not gzip it.
      transferBytes: 18_000,
      decodedBytes: 18_000,
    };
    const logo = resourceFromBody('http://web/logo.png', 'Image', 60, compressibleBody(5_000));
    const api = resourceFromBody('http://web/api/v1/locale', 'Fetch', 70, compressibleBody(2_000));
    // The lazily-loaded chunk: requested after first paint. It costs the user
    // bytes, but not the bytes standing between them and a usable screen.
    const lazy = resourceFromBody(
      'http://web/_next/static/chunks/lazy-verify.js',
      'Script',
      fcpMs + 250,
      compressibleBody(60_000),
    );

    const result = measureCriticalPath([html, css, main, font, logo, api, lazy], fcpMs);

    expect(result.counted.map((r) => r.url).sort()).toEqual(
      [html.url, css.url, main.url, font.url].sort(),
    );
    expect(
      result.excluded.map((r) => r.url),
      'the lazy chunk was counted',
    ).toContain(lazy.url);
    expect(result.excluded.map((r) => r.url)).toEqual(
      expect.arrayContaining([logo.url, api.url, lazy.url]),
    );
    expect(result.gzippedBytes).toBe(
      html.transferBytes + css.transferBytes + main.transferBytes + font.transferBytes,
    );
  });

  it('reports gzipped transfer, not decoded bytes, against a fixture whose two sizes are known', async () => {
    // The NFR is stated gzipped. Summing decoded bytes overstates the page by
    // roughly 3x; summing transfer for an uncompressed response understates
    // nothing. This fixture makes the two figures impossible to confuse.
    const { measureCriticalPath } = await loadModule();

    const compressible = compressibleBody(200_000);
    // Deterministic per run is not needed: random bytes are incompressible by
    // construction, so gzip costs a few bytes rather than saving any.
    const incompressible = randomBytes(20_000);

    const a = resourceFromBody('http://web/_next/static/chunks/a.js', 'Script', 10, compressible);
    const b = resourceFromBody('http://web/_next/static/chunks/b.js', 'Script', 20, incompressible);

    const knownRaw = compressible.byteLength + incompressible.byteLength;
    const knownGzipped = a.transferBytes + b.transferBytes;
    // Guard the fixture itself: if these were close, the test below proves nothing.
    expect(knownRaw - knownGzipped).toBeGreaterThan(150_000);

    const result = measureCriticalPath([a, b], 1_000);
    expect(result.gzippedBytes, 'the reported figure is not the gzipped transfer').toBe(
      knownGzipped,
    );
    expect(result.rawBytes).toBe(knownRaw);
  });
});

describe('acceptance: the budget fails on a regression — demonstrated, not asserted', () => {
  it('throws on an over-budget page, naming the route, bytes, budget and overage', async () => {
    const { assertCriticalPathWithinBudget } = await loadModule();

    // One byte over is a regression. The check must not round, tolerate or warn.
    expect(() => assertCriticalPathWithinBudget('/', 141_337, 141_336)).toThrow(/budget/i);

    let message = '';
    try {
      assertCriticalPathWithinBudget('/fixture-route', 150_250, 141_000);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, 'an over-budget page did not throw').not.toBe('');
    expect(message, 'the message does not name the route').toContain('/fixture-route');
    expect(message, 'the message does not give the measured bytes').toContain('150250');
    expect(message, 'the message does not give the budget').toContain('141000');
    expect(message, 'the message does not give the overage').toContain('9250');
  });

  it('passes a page exactly at its budget', async () => {
    // The other half of "demonstrated": a check that throws on everything is
    // as useless as one that throws on nothing.
    const { assertCriticalPathWithinBudget } = await loadModule();
    expect(() => assertCriticalPathWithinBudget('/', 141_336, 141_336)).not.toThrow();
  });
});

describe('acceptance: measured against the production build that ships', () => {
  let runStatus: number | null = null;
  let runOutput = '';
  let artifact: CriticalPathArtifact | null = null;
  const runStartedAt = Date.now();

  beforeAll(() => {
    // Do not read the harness; run it.
    const run = spawnSync('pnpm', ['test:e2e', '--', '--grep', '@byte-budget'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: STACK_RUN_TIMEOUT_MS,
    });
    runStatus = run.status;
    runOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`;

    const path = fromRoot(ARTIFACT);
    // A file left over from an earlier run is indistinguishable from one this
    // run wrote, so only a fresh one counts.
    if (existsSync(path) && statSync(path).mtimeMs >= runStartedAt) {
      artifact = JSON.parse(readFileSync(path, 'utf8')) as CriticalPathArtifact;
    }
  }, STACK_RUN_TIMEOUT_MS);

  it("runs green at today's weight and records the measurement", () => {
    expect(
      runStatus,
      `pnpm test:e2e --grep @byte-budget did not exit 0:\n${runOutput.slice(-2_000)}`,
    ).toBe(0);
    expect(artifact, `${ARTIFACT} was not written by this run`).not.toBeNull();
    expect(artifact?.route).toBe('/');
    expect(artifact?.gzippedBytes).toBeGreaterThan(0);
  });

  it('serves a production build — something only `next build` + `next start` produce', () => {
    // A fresh build of THIS checkout. A stale `.next` measures code that is
    // not the code under review.
    const buildIdPath = fromRoot(BUILD_ID);
    expect(existsSync(buildIdPath), `${BUILD_ID} is missing — apps/web was not built`).toBe(true);
    expect(statSync(buildIdPath).mtimeMs, 'the build predates this run').toBeGreaterThanOrEqual(
      runStartedAt,
    );
    const buildId = readFileSync(buildIdPath, 'utf8').trim();
    expect(buildId).not.toBe('development');
    expect(artifact?.buildId, 'the served app is not the build on disk').toBe(buildId);

    const resources = artifact?.resources ?? [];

    // `next start` serves hashed chunks as immutable; `next dev` serves them
    // no-store. This is a property of the wire, not of a config file.
    const chunks = resources.filter(
      (r) => r.counted && r.resourceType === 'Script' && r.url.includes('/_next/static/'),
    );
    expect(chunks.length, 'no /_next/static script on the critical path').toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.cacheControl ?? '', `${chunk.url} is not served immutable`).toMatch(/immutable/);
    }

    // Nothing that only a development server emits.
    for (const resource of resources) {
      expect(resource.url, 'a development-only resource was loaded').not.toMatch(
        /webpack-hmr|react-refresh|_next\/static\/development|__nextjs_|turbopack-hmr/,
      );
    }
  });

  it('reports gzipped transfer of a response the server actually compressed', () => {
    const counted = (artifact?.resources ?? []).filter((r) => r.counted);
    expect(counted.length).toBeGreaterThan(0);

    // Documents, scripts and styles above the compression threshold arrive
    // gzipped. Fonts are woff2 and already compressed, so they are not asked.
    const compressible = counted.filter((r) => r.resourceType !== 'Font' && r.decodedBytes > 2_048);
    expect(compressible.length).toBeGreaterThan(0);
    for (const resource of compressible) {
      expect(resource.contentEncoding, `${resource.url} was not served gzipped`).toBe('gzip');
      expect(resource.transferBytes).toBeLessThan(resource.decodedBytes);
    }

    const sum = counted.reduce((total, r) => total + r.transferBytes, 0);
    expect(artifact?.gzippedBytes, 'gzippedBytes is not the sum of counted transfer').toBe(sum);
    expect(artifact?.gzippedBytes ?? 0).toBeLessThan(artifact?.rawBytes ?? 0);
  });

  it('computed the recorded figure with the stated rule, and counted nothing after first paint', async () => {
    const { measureCriticalPath } = await loadModule();
    const resources = artifact?.resources ?? [];
    const fcpMs = artifact?.fcpMs ?? 0;
    expect(fcpMs).toBeGreaterThan(0);

    const recomputed = measureCriticalPath(resources, fcpMs);
    expect(recomputed.gzippedBytes, 'the spec measured something other than the rule').toBe(
      artifact?.gzippedBytes,
    );
    expect(
      resources
        .filter((r) => r.counted)
        .map((r) => r.url)
        .sort(),
    ).toEqual(recomputed.counted.map((r) => r.url).sort());

    for (const resource of resources.filter((r) => r.counted)) {
      expect(
        resource.startedAtMs,
        `${resource.url} was requested after FCP but counted`,
      ).toBeLessThanOrEqual(fcpMs);
    }
  });

  it('pins the budget near the measured weight, under the 300 KB ceiling, and it bites', async () => {
    const { SIGN_IN_CRITICAL_PATH_BUDGET_BYTES: budget, assertCriticalPathWithinBudget } =
      await loadModule();
    const measured = artifact?.gzippedBytes ?? 0;
    expect(measured).toBeGreaterThan(0);

    expect(artifact?.budgetBytes, 'the spec asserted a different budget').toBe(budget);

    // The NFR ceiling. If TODAY'S weight is above it, that is a finding about
    // the app for DECISIONS.md — not a reason to relax this line.
    expect(budget, 'the budget is above the PRD 2.13 ceiling').toBeLessThanOrEqual(
      NFR_CEILING_BYTES,
    );
    expect(measured).toBeLessThanOrEqual(budget);

    // The trap in T-0010: a budget at the ceiling permits every regression
    // between here and there. Headroom is capped at the larger of 10% of the
    // measured weight or 10 KiB.
    const allowedHeadroom = Math.max(Math.ceil(measured * 0.1), 10 * 1024);
    expect(
      budget - measured,
      `budget ${budget} leaves ${budget - measured} bytes of headroom over ${measured}; ` +
        `pin it within ${allowedHeadroom}`,
    ).toBeLessThanOrEqual(allowedHeadroom);

    // And the real number, one byte heavier, fails.
    expect(() => assertCriticalPathWithinBudget('/', budget + 1, budget)).toThrow(/budget/i);
  });
});
