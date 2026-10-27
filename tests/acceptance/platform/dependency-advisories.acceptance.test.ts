import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0037, clear the drizzle-orm advisory before its baseline
 * expires (D-L41).
 *
 * File-only: reads `osv-scanner.toml` and `pnpm-lock.yaml`, needs no Docker.
 *
 * What is being held:
 *
 *   1. drizzle-orm resolves, everywhere in the lockfile, at or above 0.45.2 —
 *      the first version fixing GHSA-gpj5-g38j-94v9, as recorded in that
 *      advisory's own baseline reason ("fixed in 0.45.2") — and the advisory
 *      is no longer baselined. The task says to remove the entry once
 *      upgraded; a still-present entry is either stale or hiding a second
 *      resolution of the old version.
 *
 *   2. Every remaining baseline entry is honest about what it covers: it has
 *      an expiry, it names the package(s) and version(s) it exempts, and each
 *      of those is actually in the lockfile. A reason that names nothing
 *      cannot be classified below, and a reason naming a version that is no
 *      longer resolved is an exemption nobody is reading.
 *
 *   3. Any baselined advisory on a package in the RUNTIME closure of
 *      `apps/api` or `packages/*` says, in its reason, either "upgraded" or
 *      "not reachable:" followed by the analysis. "Pre-existing" is not a
 *      triage.
 *
 *   4. Nothing is exempted past 2026-10-31 (the D-L41 expiry) unless its
 *      reason is a written "not reachable:" analysis. An extension without a
 *      reachability argument is the permanent exemption D-L41 forbids.
 *
 * "Runtime" is decided from the dependency FIELDS, as the lockfile's
 * `importers` section records them from each package.json: an importer's
 * `dependencies` and `optionalDependencies` are followed transitively through
 * `snapshots`; `devDependencies` are not. Workspace links (`link:`) are
 * followed into the linked importer's runtime fields.
 *
 * `packages/testing` is NOT a runtime root, although it lives under
 * `packages/` and lists testcontainers under `dependencies`: CLAUDE.md
 * section 6.6 makes importing it from application code a lint error, so its
 * dependency tree never ships. It is reached only if a real runtime package
 * links to it, which the lint rule already forbids.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

const ADVISORY = 'GHSA-gpj5-g38j-94v9';
const FIXED_DRIZZLE = '0.45.2';
const D_L41_EXPIRY = Date.parse('2026-10-31T00:00:00Z');

const NOT_REACHABLE = /not reachable:\s*\S.{19,}/i;
const UPGRADED = /\bupgraded\b/i;

/**
 * D-L206 (lead amendment): a runtime finding whose only fix is a major upgrade
 * may be accepted briefly as "runtime-bounded", with a "bounded:" argument that
 * the triggering input is capped, a "fix: T-nnnn" naming the upgrade task, and
 * an `ignoreUntil` no later than 2026-12-31. The T-0153 suite holds the same
 * rule; this is the matching triage for the two checks below.
 */
const RUNTIME_BOUNDED_UNTIL = Date.parse('2026-12-31T23:59:59Z');
function runtimeBounded(entry: { reason: string; ignoreUntil: number }): boolean {
  return (
    /\bruntime-bounded\b/i.test(entry.reason) &&
    /bounded:\s*\S.{19,}/i.test(entry.reason) &&
    /\bfix:\s*T-\d{4}\b/i.test(entry.reason) &&
    entry.ignoreUntil <= RUNTIME_BOUNDED_UNTIL
  );
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// osv-scanner.toml — a deliberately strict reader for the one shape it uses.
// An unrecognised line fails the suite rather than being skipped, so a value
// cannot hide in syntax this reader does not understand.
// ---------------------------------------------------------------------------

interface BaselineEntry {
  id: string;
  /** Raw text as written, for messages. Empty when absent. */
  ignoreUntilRaw: string;
  /** Epoch ms, or NaN when absent or not a TOML date/datetime. */
  ignoreUntil: number;
  reason: string;
}

function parseTomlValue(raw: string, line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    // A TOML basic string's escapes are a subset of JSON's.
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error(`osv-scanner.toml:${line}: bad string`);
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`osv-scanner.toml:${line}: bad literal string`);
    }
    return value.slice(1, -1);
  }
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return value;
  throw new Error(`osv-scanner.toml:${line}: unsupported value ${value}`);
}

function tomlDate(raw: string): number {
  if (raw === '') return Number.NaN;
  // A bare local date or local datetime is read as UTC, the generous reading.
  const iso = raw.replace(' ', 'T');
  const withZone = /T/.test(iso) && !/(Z|[+-]\d{2}:\d{2})$/.test(iso) ? `${iso}Z` : iso;
  return Date.parse(/T/.test(withZone) ? withZone : `${withZone}T00:00:00Z`);
}

function loadBaseline(): BaselineEntry[] {
  const text = readFileSync(resolve(repoRoot, 'osv-scanner.toml'), 'utf8');
  const entries: Mapping[] = [];
  let current: Mapping | undefined;
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) return;
    if (line.trim() === '[[IgnoredVulns]]') {
      current = {};
      entries.push(current);
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (kv === null || current === undefined) {
      throw new Error(`osv-scanner.toml:${index + 1}: unrecognised line: ${line}`);
    }
    const [, key, value] = kv;
    if (key === undefined || value === undefined) return;
    current[key] = parseTomlValue(value, index + 1);
  });
  return entries.map((entry) => {
    const ignoreUntilRaw = typeof entry.ignoreUntil === 'string' ? entry.ignoreUntil : '';
    return {
      id: typeof entry.id === 'string' ? entry.id : '',
      ignoreUntilRaw,
      ignoreUntil: tomlDate(ignoreUntilRaw),
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    };
  });
}

/** `drizzle-orm 0.38.4`, `@vitest/mocker 2.1.9` -> [name, version] pairs. */
function namedPackages(reason: string): Array<{ name: string; version: string }> {
  const found: Array<{ name: string; version: string }> = [];
  for (const match of reason.matchAll(
    /(?:^|[\s,;:(])(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)@?\s?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/gi,
  )) {
    const [, name, version] = match;
    if (name === undefined || version === undefined) continue;
    // "fixed in 0.45.2" names a version, not a package.
    if (/^(in|to|at|from|v|and|or|cvss)$/i.test(name)) continue;
    found.push({ name: name.toLowerCase(), version });
  }
  return found;
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml (v9)
// ---------------------------------------------------------------------------

interface Lockfile {
  importers: Record<string, Mapping>;
  snapshots: Record<string, Mapping>;
  packages: Record<string, Mapping>;
}

function loadLockfile(): Lockfile {
  const doc: unknown = parse(readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const lock = isMapping(doc) ? doc : {};
  const section = (key: string): Record<string, Mapping> => {
    const value = lock[key];
    if (!isMapping(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isMapping(v) ? v : {}]));
  };
  return {
    importers: section('importers'),
    snapshots: section('snapshots'),
    packages: section('packages'),
  };
}

/** `0.38.4(@opentelemetry/api@1.9.1)(pg@8.23.0)` -> `0.38.4`. */
function bareVersion(version: string): string {
  const paren = version.indexOf('(');
  return paren === -1 ? version : version.slice(0, paren);
}

/** `@scope/name@1.2.3(peer@1)` -> { name: '@scope/name', version: '1.2.3' }. */
function splitKey(key: string): { name: string; version: string } {
  const bare = bareVersion(key);
  const at = bare.lastIndexOf('@');
  return at <= 0
    ? { name: bare, version: '' }
    : { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

/** Every `name@version` the lockfile installs, peers stripped. */
function resolvedVersions(lock: Lockfile): Set<string> {
  const out = new Set<string>();
  for (const key of [...Object.keys(lock.packages), ...Object.keys(lock.snapshots)]) {
    const { name, version } = splitKey(key);
    if (version !== '') out.add(`${name.toLowerCase()}@${version}`);
  }
  return out;
}

function depEntries(block: unknown): Array<[string, string]> {
  if (!isMapping(block)) return [];
  return Object.entries(block).map(([name, spec]) => {
    // importers: { specifier, version }; snapshots: a bare version string.
    if (isMapping(spec)) return [name, typeof spec.version === 'string' ? spec.version : ''];
    return [name, typeof spec === 'string' ? spec : String(spec)];
  });
}

const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies'] as const;

function isRuntimeRoot(importer: string): boolean {
  if (importer === 'apps/api') return true;
  return importer.startsWith('packages/') && importer !== 'packages/testing';
}

/** `name@version` (peers stripped) for everything in the runtime closure. */
function runtimeClosure(lock: Lockfile): Set<string> {
  const reached = new Set<string>();
  const seenSnapshots = new Set<string>();
  const seenImporters = new Set<string>();

  const visitImporter = (path: string): void => {
    if (seenImporters.has(path)) return;
    seenImporters.add(path);
    const importer = lock.importers[path] ?? {};
    for (const field of RUNTIME_FIELDS) {
      for (const [name, version] of depEntries(importer[field])) {
        if (version.startsWith('link:')) {
          const target = resolve(repoRoot, path, version.slice('link:'.length));
          const relative = target.slice(repoRoot.length + 1).replace(/\\/g, '/');
          visitImporter(relative);
        } else {
          visitSnapshot(name, version);
        }
      }
    }
  };

  const visitSnapshot = (name: string, version: string): void => {
    // An `npm:` alias names the real package in its version.
    const aliased = /^npm:(.+)$/.exec(version);
    const key = aliased?.[1] ?? `${name}@${version}`;
    if (seenSnapshots.has(key)) return;
    seenSnapshots.add(key);
    const { name: realName, version: realVersion } = splitKey(key);
    reached.add(`${realName.toLowerCase()}@${realVersion}`);
    const snapshot = lock.snapshots[key] ?? {};
    for (const field of RUNTIME_FIELDS) {
      for (const [dep, depVersion] of depEntries(snapshot[field])) {
        visitSnapshot(dep, depVersion);
      }
    }
  };

  for (const path of Object.keys(lock.importers).filter(isRuntimeRoot)) visitImporter(path);
  return reached;
}

function compareSemver(a: string, b: string): number {
  const parts = (v: string): number[] =>
    bareVersion(v)
      .split('-')[0]
      ?.split('.')
      .map((n) => Number.parseInt(n, 10)) ?? [];
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------

const baseline = loadBaseline();
const lock = loadLockfile();

describe('T-0037: drizzle-orm advisory (D-L41)', () => {
  it(`resolves drizzle-orm at or above ${FIXED_DRIZZLE} everywhere in the lockfile`, () => {
    const versions = [...resolvedVersions(lock)]
      .filter((entry) => entry.startsWith('drizzle-orm@'))
      .map((entry) => entry.slice('drizzle-orm@'.length));

    // @kasuwa/db must still depend on it at runtime — "no drizzle at all"
    // would pass a filter but is not the task.
    const dbDeps = depEntries(lock.importers['packages/db']?.dependencies);
    expect(dbDeps.map(([name]) => name)).toContain('drizzle-orm');
    expect(versions.length).toBeGreaterThan(0);

    const vulnerable = versions.filter((v) => compareSemver(v, FIXED_DRIZZLE) < 0);
    expect(vulnerable, `drizzle-orm below ${FIXED_DRIZZLE} still resolved`).toEqual([]);
  });

  it(`no longer baselines ${ADVISORY} in osv-scanner.toml`, () => {
    const entry = baseline.find((e) => e.id === ADVISORY);
    expect(entry?.reason, `${ADVISORY} is still baselined`).toBeUndefined();
  });
});

describe('T-0037: the remaining osv-scanner baseline is triaged', () => {
  it('has a parseable baseline whose every entry carries an id, a reason and an ignoreUntil date', () => {
    expect(baseline.length).toBeGreaterThan(0);
    const missing = baseline
      .filter((e) => e.id === '' || e.reason.trim() === '' || Number.isNaN(e.ignoreUntil))
      .map((e) => `${e.id || '(no id)'} ignoreUntil=${e.ignoreUntilRaw || '(none)'}`);
    expect(missing, 'baseline entries without id, reason or a valid ignoreUntil').toEqual([]);
  });

  it('exempts nothing past 2026-10-31 without a written "not reachable:" analysis', () => {
    const late = baseline
      .filter(
        (e) => e.ignoreUntil > D_L41_EXPIRY && !NOT_REACHABLE.test(e.reason) && !runtimeBounded(e),
      )
      .map((e) => `${e.id} ignoreUntil=${e.ignoreUntilRaw}`);
    expect(late).toEqual([]);
  });

  it('names, in every reason, the package versions it exempts, and each is in the lockfile', () => {
    const installed = resolvedVersions(lock);
    const problems: string[] = [];
    for (const entry of baseline) {
      const named = namedPackages(entry.reason);
      if (named.length === 0) {
        problems.push(`${entry.id}: reason names no "<package> <version>"`);
        continue;
      }
      const stale = named.filter((p) => !installed.has(`${p.name}@${p.version}`));
      // Only fail when NOTHING named is installed: a reason may legitimately
      // also cite a version it does not exempt (e.g. a parent package).
      if (stale.length === named.length) {
        problems.push(
          `${entry.id}: none of ${named.map((p) => `${p.name}@${p.version}`).join(', ')} is in pnpm-lock.yaml`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('marks every baselined runtime-path advisory "upgraded" or "not reachable: <why>"', () => {
    const runtime = runtimeClosure(lock);

    // The walker must see the API's real runtime tree, or an empty closure
    // would pass everything below.
    const runtimeNames = new Set([...runtime].map((entry) => splitKey(entry).name));
    expect(runtimeNames.has('pg')).toBe(true);
    expect(runtimeNames.has('drizzle-orm')).toBe(true);
    expect(runtimeNames.has('@nestjs/core')).toBe(true);
    // ...and must not have wandered into dev tooling.
    expect(runtimeNames.has('vitest')).toBe(false);

    const untriaged = baseline
      .filter((entry) =>
        namedPackages(entry.reason).some((p) => runtime.has(`${p.name}@${p.version}`)),
      )
      .filter(
        (entry) =>
          !UPGRADED.test(entry.reason) &&
          !NOT_REACHABLE.test(entry.reason) &&
          !runtimeBounded(entry),
      )
      .map((entry) => {
        const hits = namedPackages(entry.reason)
          .filter((p) => runtime.has(`${p.name}@${p.version}`))
          .map((p) => `${p.name}@${p.version}`);
        return `${entry.id} (${hits.join(', ')})`;
      });
    expect(untriaged, 'runtime-path advisories baselined without a triage note').toEqual([]);
  });
});
