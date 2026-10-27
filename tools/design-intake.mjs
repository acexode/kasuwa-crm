#!/usr/bin/env node
/**
 * Design intake (STANDING ORDERS item 2).
 *
 * Scans `docs/design/inbox/` — one subfolder per Part 4 prompt (P01, P02…) —
 * and files new exports under `docs/design/<prompt>/`.
 *
 * FOLDER LAYOUT (settled in T-0155): FLAT. An export lives at
 * `docs/design/<prompt>/<export file>`, exactly as every prompt except P01
 * already does. A re-export of the same filename replaces it, and git holds the
 * history. P01 keeps its legacy `v1.0/` folder; it is not moved.
 *
 * Two rules from the intake addendum, both mechanical for a reason:
 *
 *   1. SKIP BY HASH. A file whose sha256 already exists anywhere under
 *      docs/design/ is a re-export of something we hold, not a new design.
 *      Filing it again would create two copies of one artefact and make
 *      "which one is live" a matter of reading dates.
 *   2. THE MANIFEST LISTS THE SCREENS AND THEIR IDS, which is what task files
 *      cite — P01/1b rather than "the locked-account one". It comes from one
 *      of two places:
 *        a. an `index.txt` (file | size | section | label), the form
 *           `node tools/design-parity.mjs design Pnn` writes for a bundled
 *           export. Looked for in the drop itself, then in
 *           `.artifacts/parity/design/<prompt>/`. A bundled export has no
 *           board with " & " in its name, so this is the form to expect.
 *        b. the old index board: the file whose name contains " & ", whose data
 *           script lists the screens.
 *      `index.txt` wins when both exist.
 *
 * Read-only by default. Pass --apply to move files. Pass
 * `--design-root=<dir>` to run against another tree (a test fixture): the
 * tree needs an `inbox/` folder, and `docs/design` is the default.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const rootArgument = process.argv.find((argument) => argument.startsWith('--design-root='));
const designRoot =
  rootArgument === undefined
    ? join(repoRoot, 'docs', 'design')
    : resolve(rootArgument.slice('--design-root='.length));
const inboxRoot = join(designRoot, 'inbox');

const apply = process.argv.includes('--apply');

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A path as it is printed: relative to the design root, with forward slashes. */
function shown(path) {
  return relative(designRoot, path).split('\\').join('/');
}

/**
 * Pulls the screen manifest out of an index board.
 *
 * The board's data script holds rows of [id, screen, name, note]. Parsing it
 * with a regex is crude and deliberately so: if the export format changes the
 * match returns nothing and the intake reports "no manifest", which is a
 * visible failure. A cleverer parser would more likely return something
 * plausible and wrong.
 */
export function extractManifest(source) {
  // Scan for group headers and rows independently, then assign each row to the
  // last header above it.
  //
  // The obvious approach — capture each group's body with a non-greedy match up
  // to its closing bracket — silently truncates the LAST row of every group,
  // because that row's own `]` is the first half of the `]]` that ends the
  // array. It returned 12 of 16 screens and looked entirely reasonable doing
  // it. Task files built from that manifest would have been missing a quarter
  // of the work with nothing to show anything was wrong.
  const groups = [];
  const groupPattern = /\['(\d{2})',\s*'([^']+)',\s*\[/g;
  let group;
  while ((group = groupPattern.exec(source)) !== null) {
    groups.push({ index: group.index, label: `${group[1]} ${group[2]}` });
  }

  const rows = [];
  const rowPattern =
    /\['([\d.]+[a-z]?)',\s*'([a-z0-9-]+)',\s*'([^']+)',\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\]/g;
  let row;
  while ((row = rowPattern.exec(source)) !== null) {
    const owning = groups.filter((candidate) => candidate.index < row.index).at(-1);
    rows.push({
      group: owning?.label ?? '(ungrouped)',
      id: row[1],
      screen: row[2],
      name: row[3],
      note: (row[4] ?? row[5] ?? '').replace(/\\u2019/g, '’').replace(/\\'/g, "'"),
    });
  }
  return rows;
}

/**
 * Reads the manifest from a `design-parity.mjs design Pnn` `index.txt`.
 *
 * One frame per line: `NN-slug.png | WxH | section | label`. The id is the
 * frame number `NN` (as written, so `P28/07`), the group is the section and the
 * name is the label. A line that is not a frame is NOT skipped quietly: a
 * `FAILED …` line, which the capture writes when a frame could not be shot,
 * is returned in `failed`, so intake says the manifest is short rather than
 * presenting a short one as complete. Any other line is `unreadable`.
 */
export function extractIndexManifest(source) {
  const rows = [];
  const failed = [];
  const unreadable = [];
  const framePattern = /^(\d+)-[^|]*\.png\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*$/;
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.startsWith('FAILED')) {
      failed.push(line);
      continue;
    }
    const match = framePattern.exec(line);
    if (match === null) {
      unreadable.push(line);
      continue;
    }
    rows.push({
      group: match[3] === '' ? '(ungrouped)' : match[3],
      id: match[1],
      screen: '',
      name: match[4],
      note: match[2],
    });
  }
  return { rows, failed, unreadable };
}

/**
 * Finds the manifest for one drop: `index.txt` first (a bundled export), then
 * the " & " board (the old form). Returns `undefined` when there is neither.
 */
function manifestFor(prompt, sourceDir, files) {
  const candidates = [
    files.find((file) => file.split(/[\\/]/).at(-1) === 'index.txt'),
    join(repoRoot, '.artifacts', 'parity', 'design', prompt, 'index.txt'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) {
      const { rows, failed, unreadable } = extractIndexManifest(readFileSync(candidate, 'utf8'));
      return { form: 'index.txt', source: candidate, rows, failed, unreadable };
    }
  }
  const board = files.find((file) => file.includes(' & '));
  if (board !== undefined) {
    return {
      form: 'board',
      source: board,
      rows: extractManifest(readFileSync(board, 'utf8')),
      failed: [],
      unreadable: [],
    };
  }
  return undefined;
}

function main() {
  if (!existsSync(inboxRoot)) {
    console.log(`No inbox at ${inboxRoot} — nothing to intake.`);
    return;
  }

  // Everything already filed, by hash, so a re-export is recognised.
  const known = new Map();
  for (const path of walk(designRoot)) {
    if (path.startsWith(inboxRoot)) continue;
    known.set(sha256(path), shown(path));
  }

  const prompts = readdirSync(inboxRoot).filter((entry) =>
    statSync(join(inboxRoot, entry)).isDirectory(),
  );

  if (prompts.length === 0) {
    console.log('Inbox is empty.');
    return;
  }

  for (const prompt of prompts) {
    const sourceDir = join(inboxRoot, prompt);
    const files = walk(sourceDir);
    const fresh = [];
    const duplicates = [];

    for (const file of files) {
      const hash = sha256(file);
      if (known.has(hash)) {
        duplicates.push([shown(file), known.get(hash)]);
      } else {
        fresh.push(file);
      }
    }

    console.log(`\n=== ${prompt}`);
    for (const [from, existing] of duplicates) {
      console.log(`  skip (hash matches ${existing})\n       ${from}`);
    }

    if (fresh.length === 0) {
      console.log('  nothing new.');
      continue;
    }

    const targetDir = join(designRoot, prompt);
    console.log(`  ${fresh.length} new file(s) -> docs/design/${prompt}/`);
    for (const file of fresh) {
      const target = join(targetDir, relative(sourceDir, file));
      if (existsSync(target)) console.log(`    replaces ${shown(target)} (git keeps the old one)`);
    }

    // The manifest: index.txt first, then the " & " board. A drop that is all
    // duplicates still has a manifest worth citing, so look at every file.
    const manifest = manifestFor(prompt, sourceDir, files);
    if (manifest === undefined) {
      console.log(
        '  WARNING: no index.txt and no " & " index board for this drop — no manifest to cite in tasks.',
      );
      console.log(
        `  Run: node tools/design-parity.mjs design ${prompt}  (writes .artifacts/parity/design/${prompt}/index.txt)`,
      );
    } else {
      console.log(`  manifest (${manifest.form}): ${manifest.rows.length} screens`);
      if (manifest.rows.length === 0) {
        console.log(
          `  WARNING: ${manifest.form} ${shown(manifest.source)} yielded no screens — the export format may have changed.`,
        );
      }
      for (const screen of manifest.rows) {
        console.log(`    ${prompt}/${screen.id.padEnd(4)} ${screen.name}`);
      }
      for (const line of manifest.failed) {
        console.log(`  WARNING: the capture failed a frame, so the manifest is short: ${line}`);
      }
      for (const line of manifest.unreadable) {
        console.log(`  WARNING: unreadable line in index.txt: ${line}`);
      }
    }

    if (apply) {
      for (const file of fresh) {
        const target = join(targetDir, relative(sourceDir, file));
        mkdirSync(dirname(target), { recursive: true });
        renameSync(file, target);
      }
      console.log('  moved.');
    } else {
      console.log('  (dry run — pass --apply to move)');
    }
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to file these.');
  }
}

// Run only as a script, so a test can import the two extractors.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
