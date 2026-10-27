import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0197, csv-parse 5 to 7 (Phase 3 S0; D-L206).
 *
 * GHSA-8cw4-87c7-c6xx (CVSS 6.9, prototype replacement through the `columns`
 * option) is fixed only in csv-parse 7.0.2. D-L206 accepted it as
 * `runtime-bounded` until 2026-12-31 because `apps/worker/src/csv-stream.ts`
 * never sets `columns`; this task is the fix that retires that acceptance.
 *
 * File-only plus one module resolution: it reads package.json, the lockfile
 * and `osv-scanner.toml`, and asks Node which csv-parse the worker resolves. It
 * needs no Docker and no network. It does not parse any CSV: how the worker
 * behaves on real input is held by `apps/worker/src/csv-stream.test.ts`, which
 * this task must leave passing and unedited.
 *
 * What is held:
 *
 *   1. The worker declares csv-parse at 7.0.2 or later, as a range whose lowest
 *      version is already fixed (`^7.0.2`, never `^7.0.0`).
 *   2. The lockfile resolves csv-parse at 7.0.2 or later everywhere. No 5.x
 *      or 6.x entry is left behind by a second consumer.
 *   3. The copy the worker actually resolves is 7.0.2 or later, so the lockfile
 *      and `node_modules` agree.
 *   4. The advisory's `osv-scanner.toml` entry is gone: the finding is fixed,
 *      not re-accepted.
 *
 * Out of scope, and not asserted: how the worker's CSV options change, if they
 * do. The unit tests decide that.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const FIXED = [7, 0, 2] as const;
const ADVISORY = 'GHSA-8cw4-87c7-c6xx';

type Version = readonly [number, number, number];

function versionOf(text: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(v: Version, floor: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = v[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const show = (v: Version | undefined): string => (v === undefined ? 'unreadable' : v.join('.'));

describe('T-0197: csv-parse is upgraded to a fixed major', () => {
  it('declares csv-parse in the worker at 7.0.2 or later', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'apps/worker/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const range = pkg.dependencies?.['csv-parse'];
    expect(range, 'apps/worker/package.json must still depend on csv-parse').toBeDefined();
    const lowest = versionOf(range ?? '');
    expect(
      lowest !== undefined && atLeast(lowest, FIXED),
      `csv-parse range "${range ?? ''}" starts at ${show(lowest)}; the fix is 7.0.2`,
    ).toBe(true);
  });

  it('resolves csv-parse at 7.0.2 or later everywhere in the lockfile', () => {
    const lock = parse(readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    const found = Object.keys(lock.packages ?? {})
      .map((key) => /^csv-parse@(.+)$/.exec(key)?.[1])
      .filter((v): v is string => v !== undefined);
    expect(found.length, 'csv-parse is in the lockfile').toBeGreaterThan(0);
    const unfixed = found.filter((v) => {
      const parsed = versionOf(v);
      return parsed === undefined || !atLeast(parsed, FIXED);
    });
    expect(unfixed, 'csv-parse versions older than 7.0.2 left in pnpm-lock.yaml').toEqual([]);
  });

  it('installs the fixed copy where the worker resolves it', () => {
    // The package's `exports` hides package.json, so resolve the entry the worker
    // imports and walk up to the manifest of the package that owns it.
    const requireFromWorker = createRequire(resolve(repoRoot, 'apps/worker/package.json'));
    let dir = dirname(requireFromWorker.resolve('csv-parse'));
    let installed: { name?: string; version?: string } = {};
    for (let i = 0; i < 8; i += 1) {
      const manifest = resolve(dir, 'package.json');
      if (existsSync(manifest)) {
        installed = JSON.parse(readFileSync(manifest, 'utf8')) as typeof installed;
        if (installed.name === 'csv-parse') break;
      }
      dir = dirname(dir);
    }
    expect(installed.name, 'found the csv-parse manifest').toBe('csv-parse');
    const version = versionOf(installed.version ?? '');
    expect(
      version !== undefined && atLeast(version, FIXED),
      `apps/worker resolves csv-parse ${installed.version ?? 'unreadable'}; run pnpm install`,
    ).toBe(true);
  });

  it('no longer baselines the advisory in osv-scanner.toml', () => {
    const text = readFileSync(resolve(repoRoot, 'osv-scanner.toml'), 'utf8');
    const lines = text
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#') && line.includes(ADVISORY));
    expect(
      lines,
      `${ADVISORY} is fixed by the upgrade, so its entry is deleted, not extended`,
    ).toEqual([]);
  });
});
