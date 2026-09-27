#!/usr/bin/env node
/**
 * Imports colour tokens from the Claude Design export into TypeScript.
 *
 * WHY THIS IS A SCRIPT AND NOT A TYPING EXERCISE
 *
 * The export carries seven 11-step scales and two full semantic token sets —
 * well over 150 hex values. Transcribing those by hand would be wrong
 * somewhere, and a single mistyped digit in a semantic token is a contrast
 * failure or an off-brand surface that nobody spots by eye. Parsing the export
 * means the values in the repository are the values the designer approved, and
 * re-running this after a design update is a diff rather than an audit.
 *
 * Source:  docs/design/v1.1/Kasuwa Design System.dc.html (committed unchanged)
 * Output:  packages/ui/src/tokens.colours.generated.ts
 *
 * Run with `pnpm ui:import-design`. CI regenerates and fails on any diff, so
 * the generated file cannot drift from the export.
 *
 * What is NOT extracted here: the type scale, spacing, radius, elevation and
 * motion values live in the export as rendered markup rather than as data, so
 * they are hand-encoded in tokens.ts with a citation to the section they came
 * from. They are a dozen values, not a hundred and fifty.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');
const exportPath = resolve(root, 'docs/design/v1.1/Kasuwa Design System.dc.html');
const outPath = resolve(root, 'packages/ui/src/tokens.colours.generated.ts');

const source = readFileSync(exportPath, 'utf8');

// --- semantic token sets ---------------------------------------------------
// Both themes appear as inline `style` attributes: the light set on the root
// board, the dark set on the dark-preview column. Each is a run of
// `--k-name:value;` declarations, so we read every declaration in the block.

function extractTokenBlocks() {
  const blocks = [];
  const pattern = /--k-bg:/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    // Walk back to the opening quote of the style attribute, forward to its close.
    const start = source.lastIndexOf('"', match.index) + 1;
    const end = source.indexOf('"', match.index);
    blocks.push(source.slice(start, end));
  }
  return blocks;
}

function parseTokens(block) {
  const tokens = {};
  for (const declaration of block.split(';')) {
    const index = declaration.indexOf(':');
    if (index === -1) continue;
    const name = declaration.slice(0, index).trim();
    if (!name.startsWith('--k-')) continue;
    tokens[name.slice('--k-'.length)] = declaration.slice(index + 1).trim();
  }
  return tokens;
}

const blocks = extractTokenBlocks();
if (blocks.length < 2) {
  throw new Error(
    `Expected at least two --k- token blocks (light and dark) in the export, found ${blocks.length}. ` +
      `The export format may have changed; do not hand-edit the generated file to compensate.`,
  );
}

const light = parseTokens(blocks[0]);
const dark = parseTokens(blocks[1]);

// The two themes must define exactly the same token names. A token present in
// one theme and not the other renders as `unset` — invisible text, or an
// invisible border — and only in the theme nobody tested.
const lightNames = Object.keys(light).sort();
const darkNames = Object.keys(dark).sort();
const onlyLight = lightNames.filter((name) => !(name in dark));
const onlyDark = darkNames.filter((name) => !(name in light));
if (onlyLight.length > 0 || onlyDark.length > 0) {
  throw new Error(
    `Light and dark token sets differ.\n` +
      `  only in light: ${onlyLight.join(', ') || '(none)'}\n` +
      `  only in dark:  ${onlyDark.join(', ') || '(none)'}`,
  );
}

// --- colour scales ---------------------------------------------------------
// The scales live in the export's data script as a literal array of
// [key, label, [11 hex values], anchorStep].

const scalesMatch = /const S = \[([\s\S]*?)\n\s{4}\];/.exec(source);
if (scalesMatch === null) {
  throw new Error('Could not find the colour scale array (`const S = [...]`) in the export.');
}

const scaleRowPattern = /\['([a-z]+)',\s*'([^']*)',\s*\[([^\]]*)\],\s*(\d+)\]/g;
const scales = [];
let row;
while ((row = scaleRowPattern.exec(scalesMatch[1])) !== null) {
  const [, key, label, hexList, anchor] = row;
  const hexes = hexList.split(',').map((value) => value.trim().replace(/'/g, ''));
  if (hexes.length !== 11) {
    throw new Error(`Scale "${key}" has ${hexes.length} steps, expected 11.`);
  }
  scales.push({ key, label, hexes, anchor: Number(anchor) });
}

if (scales.length !== 7) {
  throw new Error(`Expected 7 colour scales, found ${scales.length}.`);
}

// --- emit ------------------------------------------------------------------

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function quote(value) {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

function renderScale({ key, label, hexes, anchor }) {
  const entries = hexes
    .map((hex, index) => `    '${STEPS[index]}': ${quote(hex.toLowerCase())},`)
    .join('\n');
  const anchorNote = anchor > 0 ? ` Brand anchor at ${anchor}.` : '';
  return `  /** ${label}.${anchorNote} */\n  ${key}: {\n${entries}\n  },`;
}

function renderTokenMap(tokens) {
  return Object.entries(tokens)
    .map(([name, value]) => `  ${quote(name)}: ${quote(value)},`)
    .join('\n');
}

const output = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: docs/design/v1.1/Kasuwa Design System.dc.html
 * Regenerate: pnpm ui:import-design
 *
 * CI regenerates this and fails on any diff, so editing it by hand will be
 * reverted by the next run. Change the design export, or change the importer.
 */

export const DESIGN_VERSION = 'v1.1';

export type ToneKey =
${STEPS.map((step) => `  | '${step}'`).join('\n')};

export type Scale = Record<ToneKey, string>;

/** The seven 50–950 scales from the export. */
export const COLOUR_SCALES = {
${scales.map(renderScale).join('\n')}
} as const satisfies Record<string, Scale>;

export type ColourFamily = keyof typeof COLOUR_SCALES;

/** Step that carries the brand anchor, where the scale has one. */
export const SCALE_ANCHORS: Partial<Record<ColourFamily, number>> = {
${scales
  .filter((scale) => scale.anchor > 0)
  .map((scale) => `  ${scale.key}: ${scale.anchor},`)
  .join('\n')}
};

/** Semantic tokens, light theme. Keys are the \`--k-\` name without the prefix. */
export const SEMANTIC_LIGHT = {
${renderTokenMap(light)}
} as const;

/** Semantic tokens, dark theme. Same key set as light — the importer enforces it. */
export const SEMANTIC_DARK = {
${renderTokenMap(dark)}
} as const;

export type SemanticToken = keyof typeof SEMANTIC_LIGHT;

export const SEMANTIC_TOKEN_NAMES = Object.keys(SEMANTIC_LIGHT) as SemanticToken[];
`;

writeFileSync(outPath, output, 'utf8');

process.stdout.write(
  `imported ${scales.length} scales and ${lightNames.length} semantic tokens ` +
    `(light + dark) -> ${outPath}\n`,
);
