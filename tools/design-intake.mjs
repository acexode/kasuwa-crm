#!/usr/bin/env node
/**
 * Design intake (STANDING ORDERS item 2).
 *
 * Scans `docs/design/inbox/` — one subfolder per Part 4 prompt (P01, P02…) —
 * and files new exports under `docs/design/<prompt>/<version>/`.
 *
 * Two rules from the intake addendum, both mechanical for a reason:
 *
 *   1. SKIP BY HASH. A file whose sha256 already exists anywhere under
 *      docs/design/ is a re-export of something we hold, not a new design.
 *      Versioning it again would create two copies of one artefact and make
 *      "which version is live" a matter of reading dates.
 *   2. THE "& " BOARD IS THE MANIFEST. Each drop contains an index board whose
 *      name contains " & " (e.g. "Kasuwa Auth & Onboarding.dc.html"). Its data
 *      script lists the screens and their ids, which is what task files cite —
 *      P01/1b rather than "the locked-account one".
 *
 * Read-only by default. Pass --apply to move files.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const designRoot = join(repoRoot, 'docs', 'design');
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

function nextVersion(promptDir) {
  if (!existsSync(promptDir)) return 'v1.0';
  const versions = readdirSync(promptDir)
    .filter((entry) => /^v\d+\.\d+$/.test(entry))
    .map((entry) => Number.parseFloat(entry.slice(1)));
  return versions.length === 0 ? 'v1.0' : `v${(Math.max(...versions) + 0.1).toFixed(1)}`;
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
    known.set(sha256(path), path.slice(repoRoot.length + 1));
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
        duplicates.push([file.slice(repoRoot.length + 1), known.get(hash)]);
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

    const promptDir = join(designRoot, prompt);
    const version = nextVersion(promptDir);
    const targetDir = join(promptDir, version);
    console.log(`  ${fresh.length} new file(s) -> docs/design/${prompt}/${version}/`);

    // The index board is the one whose name contains " & ".
    const board = fresh.find((file) => file.includes(' & '));
    if (board === undefined) {
      console.log('  WARNING: no " & " index board in this drop — no manifest to cite in tasks.');
    } else {
      const manifest = extractManifest(readFileSync(board, 'utf8'));
      console.log(`  manifest: ${manifest.length} screens`);
      for (const screen of manifest) {
        console.log(`    ${prompt}/${screen.id.padEnd(4)} ${screen.name}`);
      }
    }

    if (apply) {
      mkdirSync(targetDir, { recursive: true });
      for (const file of fresh) {
        renameSync(file, join(targetDir, file.slice(sourceDir.length + 1)));
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

main();
