import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0198, zod 3 to 4 (Phase 3 S0; D-L206).
 *
 * GHSA-mrhx-c7xc-m3w5 (CVSS 8.2, memory exhaustion validating oversized
 * constrained collections) is fixed only in zod 4.6.6. D-L206 accepted it as
 * `runtime-bounded` until 2026-12-31 because every API body is capped at
 * 512 KiB before zod runs. This task is the fix that retires that acceptance,
 * and it lands in S0 ahead of S1 so the commerce, portal and inbox schemas are
 * written for zod 4 instead of migrated afterwards.
 *
 * File-only plus one module resolution: it reads every package.json, the
 * lockfile, `osv-scanner.toml` and the TypeScript sources, and asks Node which
 * zod the API resolves. It needs no Docker and no network. It parses no schema:
 * what each schema accepts and rejects is held by the existing unit,
 * integration and isolation suites, which this task must leave passing and
 * unedited. A migration that changes what a request body is allowed to say is a
 * bug, not a finding.
 *
 * What is held:
 *
 *   1. Every package that declares zod declares it at 4.6.6 or later, as a
 *      range whose lowest version is already fixed (`^4.6.6`, never `^4.0.0`).
 *   2. The lockfile resolves zod at 4.6.6 or later everywhere, so no 3.x copy is
 *      left behind by a second consumer.
 *   3. The copy the API actually resolves is 4.6.6 or later, so the lockfile and
 *      `node_modules` agree.
 *   4. It is a migration, not a shim: no source file imports the `zod/v3`
 *      compatibility subpath.
 *   5. The advisory's `osv-scanner.toml` entry is gone: fixed, not re-accepted.
 *
 * Out of scope, and not asserted: which zod 4 APIs the schemas use, and the
 * wire contract of any endpoint (unchanged).
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const FIXED = [4, 6, 6] as const;
const ADVISORY = 'GHSA-mrhx-c7xc-m3w5';
/** Where code and manifests live. Walking the whole repo (docs, artefacts) is slow and finds nothing. */
const CODE_ROOTS = ['apps', 'packages', 'tests', 'tools', 'scripts'];
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.artifacts', '.nx', 'coverage']);

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

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const relative = (file: string): string =>
  file
    .slice(repoRoot.length + 1)
    .split('\\')
    .join('/');

describe('T-0198: zod is upgraded to a fixed major', () => {
  it('declares zod at 4.6.6 or later wherever it is declared', () => {
    const manifests = [
      resolve(repoRoot, 'package.json'),
      ...CODE_ROOTS.flatMap((root) =>
        walk(resolve(repoRoot, root), (f) => basename(f) === 'package.json'),
      ),
    ];
    const declared = manifests.flatMap((file) => {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      return [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].flatMap((field) => {
        const range = (pkg[field] as Record<string, string> | undefined)?.zod;
        return range === undefined ? [] : [{ file: relative(file), field, range }];
      });
    });
    expect(declared.length, 'at least one package declares zod').toBeGreaterThan(0);
    const unfixed = declared
      .filter(({ range }) => {
        const lowest = versionOf(range);
        return lowest === undefined || !atLeast(lowest, FIXED);
      })
      .map(({ file, field, range }) => `${file} ${field}.zod "${range}"`);
    expect(unfixed, 'zod ranges that still allow an affected version (fix: 4.6.6)').toEqual([]);
  });

  it('resolves zod at 4.6.6 or later everywhere in the lockfile', () => {
    const lock = parse(readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    const found = Object.keys(lock.packages ?? {})
      .map((key) => /^zod@(.+)$/.exec(key)?.[1])
      .filter((v): v is string => v !== undefined);
    expect(found.length, 'zod is in the lockfile').toBeGreaterThan(0);
    const unfixed = found.filter((v) => {
      const parsed = versionOf(v);
      return parsed === undefined || !atLeast(parsed, FIXED);
    });
    expect(unfixed, 'zod versions older than 4.6.6 left in pnpm-lock.yaml').toEqual([]);
  });

  it('installs the fixed copy where the API resolves it', () => {
    // Resolve the entry the API imports and walk up to the manifest of the
    // package that owns it, so this does not depend on what `exports` exposes.
    const requireFromApi = createRequire(resolve(repoRoot, 'apps/api/package.json'));
    let dir = dirname(requireFromApi.resolve('zod'));
    let installed: { name?: string; version?: string } = {};
    for (let i = 0; i < 8; i += 1) {
      const manifest = resolve(dir, 'package.json');
      if (existsSync(manifest)) {
        installed = JSON.parse(readFileSync(manifest, 'utf8')) as typeof installed;
        if (installed.name === 'zod') break;
      }
      dir = dirname(dir);
    }
    expect(installed.name, 'found the zod manifest').toBe('zod');
    const version = versionOf(installed.version ?? '');
    expect(
      version !== undefined && atLeast(version, FIXED),
      `apps/api resolves zod ${installed.version ?? 'unreadable'}; run pnpm install`,
    ).toBe(true);
  });

  it('migrates the schemas instead of importing the zod 3 compatibility subpath', () => {
    const sources = CODE_ROOTS.flatMap((root) =>
      walk(
        resolve(repoRoot, root),
        (f) => /\.(?:ts|tsx|mts|cts|mjs)$/.test(f) && !f.endsWith('zod-4.acceptance.test.ts'),
      ),
    );
    const shimmed = sources
      .filter((file) =>
        /from\s+['"]zod\/v3['"]|require\(\s*['"]zod\/v3['"]\s*\)/.test(readFileSync(file, 'utf8')),
      )
      .map(relative);
    expect(shimmed, 'files importing zod/v3: migrate them to zod 4').toEqual([]);
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
