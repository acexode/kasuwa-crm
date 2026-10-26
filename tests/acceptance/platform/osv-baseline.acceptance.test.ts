import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0153, the osv-scanner baseline must not simply expire
 * (Phase 3 WS0 #2; D-L41, D-L205).
 *
 * `osv-scanner.toml` was a baseline of findings that were already in the
 * lockfile when the scan arrived (T-0005). Every entry expires together on
 * 2026-10-31, after which the `Dependency scan` job goes red. The file says what
 * must happen instead: each finding is fixed, or re-accepted "with a real,
 * per-finding reason". This suite holds that second half, mechanically, so
 * "re-accepted" cannot mean "the date was moved".
 *
 * File-only: it reads `osv-scanner.toml`, needs no Docker and no network, and
 * does not run the scanner. Whether a finding is really unreachable is a
 * judgement the reviewer makes from the reason; this suite only makes sure there
 * is a reason to judge.
 *
 * It sits beside `dependency-advisories.acceptance.test.ts` (T-0037), which is
 * unchanged and keeps holding: a reason must name package versions that are in
 * the lockfile, a runtime-path package must be "upgraded" or "not reachable:",
 * and nothing is exempted past 2026-10-31 without a written "not reachable:"
 * analysis. This suite adds what T-0037 does not say.
 *
 * What is held:
 *
 *   1. Nothing is left to lapse. No entry's `ignoreUntil` is on or before
 *      2026-10-31. An entry is either gone (upgraded) or has a later date.
 *
 *   2. A bounded horizon. No entry's `ignoreUntil` is later than 2027-01-31, so
 *      a re-acceptance is a quarter, not a permanent exemption. (The horizon is
 *      this task's proposal; the lead may move it by editing the constant.)
 *
 *   3. No boilerplate. The T-0005 reason ("baseline, pre-existing") says nothing
 *      per finding and may not survive.
 *
 *   4. Every remaining reason is a triage, with three parts:
 *        - its scope: "dev-only", "test-only" or "build-only";
 *        - the reachability argument, as "not reachable: <why>";
 *        - the way out: "fix: <what and when>", or "no fixed version".
 *
 *   5. No duplicate ids, and no id without an `ignoreUntil`: a second entry for
 *      the same advisory would let the later date hide the earlier one.
 *
 * Out of scope, and not asserted: which dependency upgrades are made. T-0153
 * decides that per finding. Where an upgrade fixes a finding, the entry is
 * deleted and the finding leaves this file.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

const D_L41_EXPIRY = Date.parse('2026-10-31T00:00:00Z');
const HORIZON = Date.parse('2027-01-31T23:59:59Z');

const BOILERPLATE = /baseline,\s*pre-existing/i;
const SCOPE = /\b(?:dev|test|build)-only\b/i;
const NOT_REACHABLE = /not reachable:\s*\S.{19,}/i;
const WAY_OUT = /\bfix:\s*\S.{9,}|\bno fixed version\b/i;

interface Entry {
  id: string;
  ignoreUntilRaw: string;
  ignoreUntil: number;
  reason: string;
}

/**
 * A deliberately strict reader for the one shape the file uses. An unrecognised
 * line fails the suite instead of being skipped, so a value cannot hide in
 * syntax this reader does not understand.
 */
function loadBaseline(): Entry[] {
  const text = readFileSync(resolve(repoRoot, 'osv-scanner.toml'), 'utf8');
  const entries: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line === '[[IgnoredVulns]]') {
      current = {};
      entries.push(current);
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (kv === null || current === undefined) {
      throw new Error(`osv-scanner.toml:${index + 1}: unrecognised line`);
    }
    const [, key, value] = kv;
    if (key === undefined || value === undefined) return;
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    // Basic strings only; the escapes this file uses are \" and \\.
    current[key] = quoted?.[1] !== undefined ? quoted[1].replace(/\\(["\\])/g, '$1') : value;
  });

  return entries.map((entry) => ({
    id: entry.id ?? '',
    ignoreUntilRaw: entry.ignoreUntil ?? '',
    ignoreUntil: Date.parse(entry.ignoreUntil ?? ''),
    reason: entry.reason ?? '',
  }));
}

const baseline = loadBaseline();

describe('T-0153: the osv-scanner baseline does not simply lapse', () => {
  it('reads a non-empty, well-formed baseline', () => {
    expect(baseline.length).toBeGreaterThan(0);
    const malformed = baseline
      .filter((e) => e.id === '' || e.reason.trim() === '' || Number.isNaN(e.ignoreUntil))
      .map((e) => e.id || '(no id)');
    expect(malformed, 'entries without an id, a reason or a valid ignoreUntil').toEqual([]);
  });

  it('leaves no entry to expire on or before 2026-10-31', () => {
    const lapsing = baseline
      .filter((e) => e.ignoreUntil <= D_L41_EXPIRY)
      .map((e) => `${e.id} ignoreUntil=${e.ignoreUntilRaw}`);
    expect(lapsing, 'each of these either leaves the file (upgraded) or gets a later date').toEqual(
      [],
    );
  });

  it('exempts nothing beyond 2027-01-31', () => {
    const open = baseline
      .filter((e) => e.ignoreUntil > HORIZON)
      .map((e) => `${e.id} ignoreUntil=${e.ignoreUntilRaw}`);
    expect(open, 'a re-acceptance is one quarter, not a permanent exemption').toEqual([]);
  });

  it('carries no "baseline, pre-existing" boilerplate reason', () => {
    const boilerplate = baseline.filter((e) => BOILERPLATE.test(e.reason)).map((e) => e.id);
    expect(boilerplate, 'a reason that says nothing per finding').toEqual([]);
  });

  it('gives every remaining entry a scope, a "not reachable:" analysis and a way out', () => {
    const incomplete = baseline.flatMap((e) => {
      const missing: string[] = [];
      if (!SCOPE.test(e.reason)) missing.push('scope (dev-only, test-only or build-only)');
      if (!NOT_REACHABLE.test(e.reason)) missing.push('"not reachable: <why>"');
      if (!WAY_OUT.test(e.reason)) missing.push('"fix: <what and when>" or "no fixed version"');
      return missing.length === 0 ? [] : [`${e.id}: missing ${missing.join(', ')}`];
    });
    expect(incomplete).toEqual([]);
  });

  it('lists each advisory once', () => {
    const seen = new Set<string>();
    const repeated = baseline
      .map((e) => e.id)
      .filter((id) => {
        const dupe = seen.has(id);
        seen.add(id);
        return dupe;
      });
    expect(repeated, 'a second entry would let the later date hide the earlier one').toEqual([]);
  });
});
