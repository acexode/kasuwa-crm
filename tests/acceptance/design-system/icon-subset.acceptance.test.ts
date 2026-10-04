import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0006, fail CI when a screen uses an icon that is not in the
 * font subset. Agent 11.
 *
 * Material Symbols Rounded ships as a ~14 KB subset holding only the names in
 * `packages/ui/icon-subset.txt`. A name outside it renders as a BLANK BOX —
 * silently, only in production. The generated `IconName` union already makes
 * `<Icon name="…">` with an unlisted literal a compile error; this check is the
 * backstop for everything the union cannot see: a raw `k-icon` span, a second
 * app, a list edited without re-running the fetch.
 *
 * ---------------------------------------------------------------------------
 * THE INTERFACE THIS SUITE PINS (the builder implements it)
 * ---------------------------------------------------------------------------
 *
 * Script: `tools/verify-icons.mjs`, plain Node, no new dependency.
 * Root `package.json`: `"verify:icons"` runs it (`node tools/verify-icons.mjs`).
 *
 *   node tools/verify-icons.mjs                  checks this repository
 *   node tools/verify-icons.mjs --root <dir>     checks <dir> AS IF it were the
 *                                                repository root
 *
 * Under a root (the repo, or `--root`), it reads `<root>/packages/ui/icon-subset.txt`
 * (blank lines and `#` lines ignored, each line trimmed — CRLF must work) and
 * scans every `.ts`/`.tsx` file under `<root>/apps/` — every app, not only
 * `web` — skipping `node_modules`, `.next` and `dist`. A `--root` fixture holds
 * ONLY those two things: no font, no package.json, no git. The script must not
 * require anything else to be there.
 *
 * `--root` is how this suite plants a broken screen without dirtying the repo:
 * it builds a throwaway tree in the OS temp directory and points the script at
 * it. The repository itself is never written to.
 *
 * Icon references it must recognise (all three exist in apps/web today):
 *
 *   1. `<Icon name="arrow_back" … />`                 a string-literal prop
 *   2. `<Icon name={open ? 'expand_less' : 'expand_more'} />`
 *                                                     each literal arm of a ternary
 *                                                     (NOT a literal in its
 *                                                     condition: `v === 'email' ?`)
 *   3. `<span className="k-icon …">home</span>`       raw ligature text in an
 *                                                     element carrying the
 *                                                     `k-icon` class — the case
 *                                                     the union does NOT cover
 *
 * A name built from a non-literal expression (`name={group.icon}`) is not a
 * failure for this suite; the union types it. If a real one cannot be resolved,
 * T-0006 says escalate.
 *
 * Exit status and output (stdout and stderr are read together):
 *
 *   - Exit NON-ZERO (and not by crashing) if any referenced name is not in the
 *     subset. Each offence is reported on ONE line naming both the icon and the
 *     file, the file as a path relative to the root (`apps/web/components/x.tsx`;
 *     either separator is accepted, a `:line` suffix is fine).
 *   - Exit 0 otherwise.
 *   - A name in the subset that nothing references is a WARNING, not a failure
 *     (T-0006 scope 3: a too-eager failure gets the check disabled). Each is
 *     reported on its own line containing the word "unused" and the name.
 *
 * Names are matched whole: `arrow` is not satisfied by `arrow_back`, and
 * `# settings` in the subset file is a comment, not an entry.
 *
 * CI: a blocking step in the `lint` job of a workflow that runs on every
 * pull_request (no paths filter) runs `verify:icons`, directly or through the
 * root script.
 *
 * The committed font itself is checked by THIS suite, not the script: it reads
 * the WOFF2 (Brotli via node:zlib), the `cmap` and the GSUB ligature lookups,
 * and asserts every listed name is a ligature in the file. That guards against
 * the list being edited without `pnpm ui:fetch-fonts`. No new dependency.
 * ---------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const SCRIPT = 'tools/verify-icons.mjs';
const SUBSET = 'packages/ui/icon-subset.txt';
const FONT = 'apps/web/public/fonts/material-symbols-rounded-subset.woff2';

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readSubset(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------
// Running the script
// ---------------------------------------------------------------------------

interface Run {
  status: number | null;
  output: string;
  lines: string[];
}

function runScript(...args: string[]): Run {
  const result = spawnSync(process.execPath, [fromRoot(SCRIPT), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { status: result.status, output, lines: output.split(/\r?\n/) };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The icon name as a whole token: `arrow` does not match inside `arrow_back`. */
function namesIcon(line: string, icon: string): boolean {
  return new RegExp(`(?<![\\w-])${escape(icon)}(?![\\w-])`).test(line);
}

/** A root-relative path with either separator (an absolute path contains it too). */
function namesFile(line: string, relative: string): boolean {
  const pattern = relative.split('/').map(escape).join('[\\\\/]');
  return new RegExp(pattern).test(line);
}

function describeRun(run: Run): string {
  return `exit ${String(run.status)}, output:\n${run.output.trim() || '(none)'}`;
}

// ---------------------------------------------------------------------------
// Fixture roots, in the OS temp directory — the repository is never written
// ---------------------------------------------------------------------------

const fixtureDirs: string[] = [];

afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'kasuwa-icons-'));
  fixtureDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const path = resolve(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return dir;
}

// The subset every fixture shares. `settings` appears only as a comment, so a
// check that greps the raw file for the name accepts it; `arrow` is a prefix of
// `arrow_back`, so a substring check accepts it. Both must still be missing.
// CRLF on purpose: a Windows checkout with core.autocrlf hands the real file
// back that way, and a scanner that keeps the `\r` reports every icon missing.
const FIXTURE_SUBSET = [
  '# Fixture subset for the T-0006 acceptance suite.',
  '# settings',
  'arrow_back',
  'expand_more',
  'home',
  'savings',
  '',
].join('\r\n');

const ICON_COMPONENT = [
  "import type { ReactNode } from 'react';",
  'export function Icon({ name }: { name: string }): ReactNode {',
  '  return <span className="k-icon shrink-0">{name}</span>;',
  '}',
  '',
].join('\n');

/** Every icon used is in the subset, in all three reference forms; `savings` is not used. */
const CLEAN_FILES: Record<string, string> = {
  [SUBSET]: FIXTURE_SUBSET,
  'apps/web/components/icon.tsx': ICON_COMPONENT,
  'apps/web/components/back-link.tsx': [
    "import { Icon } from './icon';",
    'export function BackLink() {',
    '  return <a href="/"><Icon name="arrow_back" /> Back</a>;',
    '}',
    '',
  ].join('\n'),
  'apps/web/app/(admin)/home/page.tsx': [
    'export default function Page() {',
    '  return <span className="k-icon text-h4" aria-hidden="true">home</span>;',
    '}',
    '',
  ].join('\n'),
  'apps/portal/src/toggle.tsx': [
    "import { Icon } from './icon';",
    'export function Toggle({ open }: { open: boolean }) {',
    "  return <Icon name={open ? 'arrow_back' : 'expand_more'} />;",
    '}',
    '',
  ].join('\n'),
  // The CONDITION of a ternary is not an icon: only the arms are. apps/web has
  // exactly this (`value === 'email' ? 'mail' : 'chat'`, invite-step.tsx), and
  // one whose condition uses optional chaining, so the first `?` is not the
  // ternary (`error?.code === 'otp_expired' ? …`, verify-screen.tsx).
  'apps/web/components/tab-icon.tsx': [
    "import { Icon } from './icon';",
    "export function TabIcon({ value }: { value: 'email' | 'link' }) {",
    "  return <Icon name={value === 'email' ? 'home' : 'arrow_back'} />;",
    '}',
    'export function ErrorIcon({ error }: { error?: { code: string } }) {',
    "  return <Icon name={error?.code === 'otp_expired' ? 'home' : 'expand_more'} />;",
    '}',
    '',
  ].join('\n'),
  // Vendored and built code is not ours to check.
  'apps/web/node_modules/some-lib/widget.tsx':
    'export const W = () => <Icon name="zz_vendored_glyph" />;\n',
  'apps/web/.next/server/page.tsx': 'export const P = () => <Icon name="zz_built_glyph" />;\n',
};

/** Three planted offences, one per reference form, in three files and two apps. */
const PLANTED = [
  {
    icon: 'arrow',
    file: 'apps/web/components/planted-literal.tsx',
    content: [
      "import { Icon } from './icon';",
      'export function Planted() {',
      '  return <button type="button"><Icon name="arrow" /></button>;',
      '}',
      '',
    ].join('\n'),
  },
  {
    icon: 'settings',
    file: 'apps/web/app/(admin)/planted/page.tsx',
    content: [
      'export default function Page() {',
      '  return <span className="k-icon" aria-hidden="true">settings</span>;',
      '}',
      '',
    ].join('\n'),
  },
  {
    icon: 'expand_circle_down',
    file: 'apps/portal/src/planted-ternary.tsx',
    content: [
      "import { Icon } from './icon';",
      'export function Planted({ open }: { open: boolean }) {',
      "  return <Icon name={open ? 'expand_more' : 'expand_circle_down'} />;",
      '}',
      '',
    ].join('\n'),
  },
] as const;

function brokenRoot(): string {
  return makeRoot({
    ...CLEAN_FILES,
    ...Object.fromEntries(PLANTED.map((planted) => [planted.file, planted.content])),
  });
}

// ---------------------------------------------------------------------------
// Workflows (trimmed from features-register.acceptance.test.ts)
// ---------------------------------------------------------------------------

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

interface Step {
  run: string;
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
            const run = str(step.run);
            return {
              run,
              continueOnError: step['continue-on-error'] === true,
              executes: expandScripts(run),
            };
          });
          return { id, continueOnError: job['continue-on-error'] === true, steps };
        }),
      };
    });
}

function runsOnEveryPullRequest(workflow: Workflow): boolean {
  if (!('pull_request' in workflow.triggers)) return false;
  const pr = workflow.triggers.pull_request;
  return !(isMapping(pr) && (pr.paths !== undefined || pr['paths-ignore'] !== undefined));
}

// ---------------------------------------------------------------------------
// WOFF2 -> cmap + GSUB ligatures, with node:zlib only
// ---------------------------------------------------------------------------

/** WOFF2 known-table index (the spec's table of 63 tags). */
// prettier-ignore
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

interface FontLigatures {
  /** Decompressed size matched the sum of the table directory's lengths. */
  directoryConsistent: boolean;
  ligatureCount: number;
  /** True if `name`, typed as text, is replaced by a ligature in the font. */
  hasLigature: (name: string) => boolean;
}

function readWoff2Ligatures(file: Buffer): FontLigatures {
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`${FONT} is not WOFF2`);
  const numTables = file.readUInt16BE(12);
  const totalCompressedSize = file.readUInt32BE(20);

  let cursor = 48; // end of the WOFF2 header
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = file.readUInt8(cursor);
      cursor += 1;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('malformed UIntBase128');
  };

  const directory: { tag: string; offset: number; length: number }[] = [];
  let offset = 0;
  for (let i = 0; i < numTables; i += 1) {
    const flags = file.readUInt8(cursor);
    cursor += 1;
    let tag = WOFF2_TAGS[flags & 0x3f] ?? '';
    if ((flags & 0x3f) === 63) {
      tag = file.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    }
    const version = (flags >> 6) & 3;
    const origLength = base128();
    // glyf/loca are transformed at version 0; everything else at non-zero.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128() : origLength;
    directory.push({ tag, offset, length });
    offset += length;
  }

  const data = brotliDecompressSync(file.subarray(cursor, cursor + totalCompressedSize));
  const table = (tag: string): Buffer => {
    const entry = directory.find((candidate) => candidate.tag === tag);
    if (entry === undefined) throw new Error(`${FONT} has no ${tag} table`);
    return data.subarray(entry.offset, entry.offset + entry.length);
  };

  // cmap: formats 4 and 12, which is all a Google Fonts subset carries.
  const cmap = table('cmap');
  const glyphOf = new Map<number, number>();
  for (let i = 0; i < cmap.readUInt16BE(2); i += 1) {
    const sub = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = cmap.readUInt16BE(ends + s * 2);
        const start = cmap.readUInt16BE(starts + s * 2);
        const delta = cmap.readInt16BE(deltas + s * 2);
        const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph = 0;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const raw = cmap.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (code - start) * 2);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0) glyphOf.set(code, glyph);
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < cmap.readUInt32BE(sub + 12); g += 1) {
        const first = cmap.readUInt32BE(sub + 16 + g * 12);
        const last = cmap.readUInt32BE(sub + 20 + g * 12);
        const startGlyph = cmap.readUInt32BE(sub + 24 + g * 12);
        for (let code = first; code <= last; code += 1)
          glyphOf.set(code, startGlyph + code - first);
      }
    }
  }

  // GSUB: every LigatureSubst (type 4, or type 7 extension wrapping a 4).
  const gsub = table('GSUB');
  const coverage = (at: number): number[] => {
    const glyphs: number[] = [];
    const count = gsub.readUInt16BE(at + 2);
    if (gsub.readUInt16BE(at) === 1) {
      for (let i = 0; i < count; i += 1) glyphs.push(gsub.readUInt16BE(at + 4 + i * 2));
    } else {
      for (let i = 0; i < count; i += 1) {
        const last = gsub.readUInt16BE(at + 6 + i * 6);
        for (let g = gsub.readUInt16BE(at + 4 + i * 6); g <= last; g += 1) glyphs.push(g);
      }
    }
    return glyphs;
  };
  const ligatures = new Set<string>();
  const lookupList = gsub.readUInt16BE(8);
  for (let i = 0; i < gsub.readUInt16BE(lookupList); i += 1) {
    const lookup = lookupList + gsub.readUInt16BE(lookupList + 2 + i * 2);
    const lookupType = gsub.readUInt16BE(lookup);
    for (let s = 0; s < gsub.readUInt16BE(lookup + 4); s += 1) {
      let sub = lookup + gsub.readUInt16BE(lookup + 6 + s * 2);
      let type = lookupType;
      if (type === 7) {
        type = gsub.readUInt16BE(sub + 2);
        sub += gsub.readUInt32BE(sub + 4);
      }
      if (type !== 4) continue;
      const firsts = coverage(sub + gsub.readUInt16BE(sub + 2));
      for (let k = 0; k < gsub.readUInt16BE(sub + 4); k += 1) {
        const set = sub + gsub.readUInt16BE(sub + 6 + k * 2);
        for (let m = 0; m < gsub.readUInt16BE(set); m += 1) {
          const lig = set + gsub.readUInt16BE(set + 2 + m * 2);
          const components = [firsts[k] ?? -1];
          for (let q = 1; q < gsub.readUInt16BE(lig + 2); q += 1)
            components.push(gsub.readUInt16BE(lig + 2 + q * 2));
          ligatures.add(components.join(','));
        }
      }
    }
  }

  return {
    directoryConsistent: offset === data.length,
    ligatureCount: ligatures.size,
    hasLigature: (name) => {
      const glyphs = [...name].map((char) => glyphOf.get(char.codePointAt(0) ?? -1));
      return !glyphs.includes(undefined) && ligatures.has(glyphs.join(','));
    },
  };
}

// ---------------------------------------------------------------------------

describe('acceptance: verify:icons exists (T-0006)', () => {
  it('the root package.json has a verify:icons script backed by tools/verify-icons.mjs', () => {
    expect(
      rootScripts['verify:icons'],
      'root package.json has no "verify:icons" script',
    ).toBeDefined();
    expect(rootScripts['verify:icons'], `verify:icons must run ${SCRIPT}`).toMatch(
      /\bnode\s+tools\/verify-icons\.mjs\b/,
    );
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
  });
});

describe('acceptance: a screen using an icon outside the subset fails the check (T-0006)', () => {
  it('exits non-zero, naming each offending icon together with the file it came from', () => {
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
    const run = runScript('--root', brokenRoot());

    expect(
      run.status,
      `crashed or timed out rather than reporting: ${describeRun(run)}`,
    ).not.toBeNull();
    expect(run.status, `accepted icons missing from the subset: ${describeRun(run)}`).not.toBe(0);

    for (const { icon, file } of PLANTED) {
      const reported = run.lines.some((line) => namesIcon(line, icon) && namesFile(line, file));
      expect(reported, `no line names "${icon}" with ${file}: ${describeRun(run)}`).toBe(true);

      // …and blames the right file: no line pins this icon on a different planted file.
      for (const other of PLANTED.filter((candidate) => candidate.file !== file)) {
        const misattributed = run.lines.some(
          (line) => namesIcon(line, icon) && namesFile(line, other.file),
        );
        expect(misattributed, `"${icon}" reported against ${other.file}: ${describeRun(run)}`).toBe(
          false,
        );
      }
    }

    // A subset icon that IS used is never reported as an offence against a file.
    for (const used of ['arrow_back', 'expand_more', 'home']) {
      const blamed = run.lines.some(
        (line) => namesIcon(line, used) && PLANTED.some(({ file }) => namesFile(line, file)),
      );
      expect(blamed, `"${used}" is in the subset but was reported: ${describeRun(run)}`).toBe(
        false,
      );
    }
  });

  it('fails on each reference form alone, not only when all three are present', () => {
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
    for (const planted of PLANTED) {
      const run = runScript(
        '--root',
        makeRoot({ ...CLEAN_FILES, [planted.file]: planted.content }),
      );
      expect(run.status, `"${planted.icon}" alone: ${describeRun(run)}`).not.toBeNull();
      expect(run.status, `"${planted.icon}" alone was accepted: ${describeRun(run)}`).not.toBe(0);
      expect(
        run.lines.some((line) => namesIcon(line, planted.icon) && namesFile(line, planted.file)),
        `"${planted.icon}" alone was not named with ${planted.file}: ${describeRun(run)}`,
      ).toBe(true);
    }
  });
});

describe('acceptance: icons in the subset pass; unused ones warn (T-0006)', () => {
  it('exits 0 on a tree whose every icon is in the subset (CRLF list, vendored code ignored)', () => {
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
    const run = runScript('--root', makeRoot(CLEAN_FILES));
    expect(run.status, `rejected a clean tree: ${describeRun(run)}`).toBe(0);
  });

  it('exits 0 on the repository as committed', () => {
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
    const run = runScript();
    expect(run.status, `the committed repository fails the check: ${describeRun(run)}`).toBe(0);

    // Not vacuous: a scanner that found no references at all would also exit 0,
    // and would call every icon unused. These three are used literally in
    // apps/web/components/admin (admin-shell, dialog, dispositions-tab).
    for (const used of ['menu', 'close', 'add']) {
      const calledUnused = run.lines.some((line) => /unused/i.test(line) && namesIcon(line, used));
      expect(
        calledUnused,
        `"${used}" is used in apps/web but reported unused: ${describeRun(run)}`,
      ).toBe(false);
    }
  });

  it('reports a subset icon nothing uses as an "unused" warning, without failing', () => {
    expect(existsSync(fromRoot(SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
    const run = runScript('--root', makeRoot(CLEAN_FILES));
    expect(run.status, `an unused icon must warn, not fail: ${describeRun(run)}`).toBe(0);

    const warned = run.lines.some((line) => /unused/i.test(line) && namesIcon(line, 'savings'));
    expect(warned, `no "unused" line names "savings": ${describeRun(run)}`).toBe(true);

    for (const used of ['arrow_back', 'expand_more', 'home']) {
      const calledUnused = run.lines.some((line) => /unused/i.test(line) && namesIcon(line, used));
      expect(calledUnused, `"${used}" is used but reported unused: ${describeRun(run)}`).toBe(
        false,
      );
    }
  });
});

describe('acceptance: the committed font contains every listed icon (T-0006)', () => {
  const names = readSubset(readFileSync(fromRoot(SUBSET), 'utf8'));
  const font = readWoff2Ligatures(readFileSync(fromRoot(FONT)));

  it('the WOFF2 reader is sound: it parses, and rejects real icons that were never subset', () => {
    expect(
      font.directoryConsistent,
      'WOFF2 table directory disagrees with the decompressed data',
    ).toBe(true);
    expect(names.length, `${SUBSET} parsed to nothing`).toBeGreaterThan(50);
    expect(font.ligatureCount, 'no ligatures read from GSUB').toBeGreaterThanOrEqual(names.length);

    // Real Material Symbols names, deliberately not in the subset. If the reader
    // said yes to these it would say yes to anything, and the next test is void.
    for (const absent of ['rocket_launch', 'pets', 'arrow']) {
      expect(names, `${absent} is now in the subset; pick another control`).not.toContain(absent);
      expect(font.hasLigature(absent), `reader claims "${absent}" is in the font`).toBe(false);
    }
  });

  it('every name in icon-subset.txt is a ligature in the committed subset font', () => {
    const missing = names.filter((name) => !font.hasLigature(name));
    expect(
      missing,
      `${SUBSET} lists icons the committed font does not contain — run pnpm ui:fetch-fonts`,
    ).toEqual([]);
  });
});

describe('acceptance: CI runs verify:icons on every pull request (T-0006)', () => {
  it('a blocking step in the lint job runs verify:icons', () => {
    const steps = loadWorkflows()
      .filter(runsOnEveryPullRequest)
      .flatMap((workflow) =>
        workflow.jobs
          .filter((job) => job.id === 'lint' && !job.continueOnError)
          .flatMap((job) => job.steps.map((step) => ({ workflow, job, step }))),
      )
      .filter(({ step }) => !step.continueOnError)
      .filter(({ step }) => /tools\/verify-icons\.mjs/.test(step.executes))
      .filter(({ step }) => !/\|\|\s*true\b/.test(step.run));
    expect(
      steps.length,
      'no blocking step in a pull_request lint job runs verify:icons',
    ).toBeGreaterThan(0);
  });
});
