#!/usr/bin/env node
/**
 * Fails when a screen references an icon that is not in the font subset.
 *
 * Material Symbols Rounded ships as a subset holding only the names listed in
 * `packages/ui/icon-subset.txt` — kilobytes instead of megabytes, which is what
 * makes it affordable at 256 kbps. A name outside that list renders as a BLANK
 * BOX: silently, only in production, with nothing in any log.
 *
 * The generated `IconName` union already makes `<Icon name="…">` with an
 * unlisted literal a compile error. This is the backstop for what the union
 * cannot see: a raw `k-icon` span, an app that does not use the component, a
 * cast. (Whether the committed font matches the list is asserted by
 * tests/acceptance/design-system/icon-subset.acceptance.test.ts, not here.)
 *
 *   node tools/verify-icons.mjs                 checks this repository
 *   node tools/verify-icons.mjs --root <dir>    checks <dir> as if it were the root
 *
 * Under the root it reads `packages/ui/icon-subset.txt` and scans every `.ts`
 * and `.tsx` file under `apps/`, skipping node_modules, .next and dist. The
 * reference forms it recognises:
 *
 *   1. `<Icon name="arrow_back" />`                  a string-literal prop
 *   2. `<Icon name={open ? 'a' : 'b'} />`            each literal ARM of a ternary
 *      (never a literal in its condition: `v === 'email' ? …`, nor after `?.`),
 *      and the literal fallback of `??` / `||` / `&&`
 *   3. `<span className="k-icon …">home</span>`      ligature text in any element
 *                                                    carrying the `k-icon` class
 *
 * A name from a non-literal expression (`name={group.icon}`) is left to the
 * union, which types it.
 *
 * FILLED ICONS (T-0127, D-L198). Filled glyphs ship in a second, small face
 * holding only `packages/ui/icon-subset-filled.txt`. A reference is filled when
 * the `<Icon>` carries a `filled` prop (bare, or any value but `{false}`), or
 * when the element's class list has `k-icon-filled`. A filled reference to a
 * name outside that list fails, as does a filled list naming a glyph the main
 * subset lacks (`filled={active}` falls back to the main face when false). The
 * filled list is optional: a root without one has no filled glyphs at all.
 *
 * Both directions are reported. Used-but-not-subset fails (exit 1), one line per
 * offence naming the icon and the file. Subset-but-unused only WARNS: a check
 * that fails on dead weight gets disabled (T-0006 scope 3). For the unused
 * report, a quoted literal equal to a subset name anywhere under apps/ counts as
 * a use, because most dynamic names come from `IconName`-typed records
 * (`icon: 'domain'`) the strict scan rightly does not treat as references.
 *
 * No dependencies beyond Node. Run by CI in the lint job on every pull request.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const SUBSET_FILE = 'packages/ui/icon-subset.txt';
const FILLED_FILE = 'packages/ui/icon-subset-filled.txt';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);
const ICON_TOKEN = /^[a-z0-9_]+$/;

function parseArgs(argv) {
  let root = resolve(import.meta.dirname, '..');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--root needs a directory');
      root = resolve(value);
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

class UsageError extends Error {}

/** Blank lines and `#` lines ignored, each line trimmed (so CRLF works). */
function readSubset(root, file = SUBSET_FILE, required = true) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    if (required) throw new UsageError(`${file} not found under ${root}`);
    return new Set();
  }
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
}

function listSources(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...listSources(resolve(dir, entry.name)));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(resolve(dir, entry.name));
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// A deliberately small lexer: enough to find tag ends and top-level operators
// without being fooled by braces, quotes or `>` inside strings.
// ---------------------------------------------------------------------------

/** Replace comments with spaces, keeping newlines so line numbers survive. */
function blankComments(source) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Index just past the string starting at `start` (a quote or backtick). */
function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') i += 2;
    else if (ch === quote) return i + 1;
    else if (quote === '`' && ch === '$' && src[i + 1] === '{') i = skipBalanced(src, i + 1);
    else i += 1;
  }
  return src.length;
}

/** `start` is at an opening bracket; returns the index just past its match. */
function skipBalanced(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

/**
 * Walks an opening JSX tag from just after its name. Returns its attributes
 * text and the index just past the closing `>`, and whether it self-closes.
 */
function readTag(src, from) {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") i = skipString(src, i);
    else if (ch === '{') i = skipBalanced(src, i);
    else if (ch === '>') {
      return { attrs: src.slice(from, i), end: i + 1, selfClosing: src[i - 1] === '/' };
    } else if (ch === '<')
      return undefined; // not a tag after all (a generic, a comparison)
    else i += 1;
  }
  return undefined;
}

/** Iterates `[operatorIndex]` of characters at bracket depth 0 of `expr`. */
function* topLevel(expr) {
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'" || ch === '`') i = skipString(expr, i);
    else if (ch === '{' || ch === '(' || ch === '[') i = skipBalanced(expr, i);
    else {
      yield i;
      i += 1;
    }
  }
}

function isTernaryQuestion(expr, i) {
  if (expr[i] !== '?') return false;
  const next = expr[i + 1];
  // `?.` is optional chaining (unless it is `? .5`), `??` is nullish coalescing.
  if (next === '?' || expr[i - 1] === '?') return false;
  if (next === '.' && !/[0-9]/.test(expr[i + 2] ?? '')) return false;
  return true;
}

function stripParens(expr) {
  let text = expr.trim();
  while (text.startsWith('(') && skipBalanced(text, 0) === text.length) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** A string literal (or a backtick literal with no substitution), else undefined. */
function literalValue(expr) {
  const match = /^(?:'([^'\\]*)'|"([^"\\]*)"|`([^`\\$]*)`)$/.exec(expr);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * The icon names an expression can evaluate to, as far as literals tell.
 * `dynamic` is set when some branch is not a literal (the union covers it).
 */
function valuesOf(rawExpr) {
  const expr = stripParens(rawExpr);
  const literal = literalValue(expr);
  if (literal !== undefined) return { names: [literal], dynamic: false };

  // cond ? a : b — split at the first top-level ternary `?` and its matching `:`.
  let question = -1;
  let nesting = 0;
  for (const i of topLevel(expr)) {
    if (question === -1) {
      if (isTernaryQuestion(expr, i)) question = i;
    } else if (isTernaryQuestion(expr, i)) {
      nesting += 1;
    } else if (expr[i] === ':') {
      if (nesting === 0) {
        return merge(valuesOf(expr.slice(question + 1, i)), valuesOf(expr.slice(i + 1)));
      }
      nesting -= 1;
    }
  }

  // a ?? 'x', a || 'x', cond && 'x' — the right-hand side is a possible value.
  for (const i of topLevel(expr)) {
    const pair = expr.slice(i, i + 2);
    if (pair === '??' || pair === '||') {
      return merge(valuesOf(expr.slice(0, i)), valuesOf(expr.slice(i + 2)));
    }
    if (pair === '&&') {
      return merge({ names: [], dynamic: false }, valuesOf(expr.slice(i + 2)));
    }
  }

  return { names: [], dynamic: true };
}

function merge(a, b) {
  return { names: [...a.names, ...b.names], dynamic: a.dynamic || b.dynamic };
}

/** The value of attribute `name` in a tag's attribute text: a string or `{expr}`. */
function attributeValue(attrs, attribute) {
  const pattern = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*`, 'g');
  for (const match of attrs.matchAll(pattern)) {
    // Skip a match that is inside another attribute's value.
    const at = match.index + match[0].length;
    if (!isTopLevel(attrs, match.index)) continue;
    const ch = attrs[at];
    if (ch === '"' || ch === "'") return attrs.slice(at, skipString(attrs, at));
    if (ch === '{') return attrs.slice(at + 1, skipBalanced(attrs, at) - 1);
  }
  return undefined;
}

/** True if the tag's attributes ask for the filled face: `filled`, `filled={x}`, not `{false}`. */
function hasFilled(attrs) {
  for (const match of attrs.matchAll(/(?:^|\s)filled(?![\w-])/g)) {
    if (!isTopLevel(attrs, match.index)) continue;
    const rest = attrs.slice(match.index + match[0].length).trimStart();
    if (!rest.startsWith('=')) return true;
    const value = attributeValue(attrs, 'filled');
    return value === undefined || value.trim() !== 'false';
  }
  return false;
}

function isTopLevel(text, index) {
  let i = 0;
  while (i < index) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') i = skipString(text, i);
    else if (ch === '{' || ch === '(' || ch === '[') i = skipBalanced(text, i);
    else i += 1;
  }
  return i === index;
}

// ---------------------------------------------------------------------------

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Every literal icon reference in one file: `{ name, line, filled }`. */
function referencesIn(rawSource) {
  const src = blankComments(rawSource);
  const found = [];
  let dynamic = 0;
  const add = (values, index, filled = false) => {
    for (const name of values.names) found.push({ name, line: lineOf(src, index), filled });
    if (values.dynamic) dynamic += 1;
  };

  for (const match of src.matchAll(/<([A-Za-z][\w.:-]*)(?=[\s/>])/g)) {
    const tag = readTag(src, match.index + match[0].length);
    if (tag === undefined) continue;

    // Form 1 and 2: <Icon name=…>
    if (match[1] === 'Icon') {
      const value = attributeValue(tag.attrs, 'name');
      if (value !== undefined) add(valuesOf(value), match.index, hasFilled(tag.attrs));
    }

    // Form 3: ligature text inside an element carrying the k-icon class.
    if (!tag.selfClosing && /(?<![\w-])k-icon(?:-filled)?(?![\w-])/.test(tag.attrs)) {
      const filled = /(?<![\w-])k-icon-filled(?![\w-])/.test(tag.attrs);
      const close = src.indexOf('<', tag.end);
      const text = src.slice(tag.end, close === -1 ? src.length : close).trim();
      if (text.startsWith('{') && text.endsWith('}')) {
        add(valuesOf(text.slice(1, -1)), tag.end, filled);
      } else if (text !== '') {
        add({ names: [text], dynamic: false }, tag.end, filled);
      }
    }
  }
  return { found, dynamic };
}

/** Quoted literals equal to a subset name — "maybe used", for the unused report only. */
function softUses(source, subset) {
  const uses = new Set();
  for (const match of source.matchAll(/(['"`])([a-z0-9_]+)\1/g)) {
    if (subset.has(match[2])) uses.add(match[2]);
  }
  return uses;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const subset = readSubset(root);
  const filledSubset = readSubset(root, FILLED_FILE, false);
  const files = listSources(resolve(root, 'apps'));

  const missing = [];
  const missingFilled = [];
  const usedFilled = new Set();
  const used = new Set();
  let references = 0;
  let dynamic = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(root, file).split('\\').join('/');
    const result = referencesIn(source);
    dynamic += result.dynamic;
    for (const { name, line } of result.found) {
      references += 1;
      used.add(name);
      if (!subset.has(name) || !ICON_TOKEN.test(name)) missing.push({ name, rel, line });
    }
    for (const { name, line } of result.found.filter((reference) => reference.filled)) {
      usedFilled.add(name);
      if (!filledSubset.has(name)) missingFilled.push({ name, rel, line });
    }
    for (const name of softUses(source, subset)) used.add(name);
  }

  const unused = [...subset].filter((name) => !used.has(name)).sort();
  for (const name of unused) {
    console.warn(
      `verify-icons: warning: unused subset icon "${name}" (nothing under apps/ names it)`,
    );
  }

  // Worded without "unused": the name is still used by the main face, and the
  // unused report is about the main subset. Often a false alarm, because the
  // bottom bar fills a dynamic name (`filled={active}`), which no scan resolves.
  for (const name of [...filledSubset].filter((n) => !usedFilled.has(n)).sort()) {
    console.warn(
      `verify-icons: warning: filled icon "${name}" is never drawn filled by a literal reference`,
    );
  }

  const strays = [...filledSubset].filter((name) => !subset.has(name)).sort();
  if (missingFilled.length > 0 || strays.length > 0) {
    for (const { name, rel, line } of missingFilled) {
      console.error(
        `verify-icons: missing filled icon "${name}" at ${rel}:${line} (not in ${FILLED_FILE})`,
      );
    }
    for (const name of strays) {
      console.error(
        `verify-icons: filled icon "${name}" is in ${FILLED_FILE} but not in ${SUBSET_FILE}`,
      );
    }
    for (const { name, rel, line } of missing) {
      console.error(
        `verify-icons: missing icon "${name}" at ${rel}:${line} (not in ${SUBSET_FILE})`,
      );
    }
    console.error(
      `\nFILLED ICON CHECK FAILED: ${missingFilled.length + strays.length} filled glyph problem(s).\n` +
        'A filled glyph missing from the filled face renders as a blank box. Put the name in ' +
        `${FILLED_FILE} (and ${SUBSET_FILE}) and run pnpm ui:fetch-fonts.`,
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    for (const { name, rel, line } of missing) {
      console.error(
        `verify-icons: missing icon "${name}" at ${rel}:${line} (not in ${SUBSET_FILE})`,
      );
    }
    console.error(
      `\nICON CHECK FAILED: ${missing.length} reference(s) to glyphs the font subset does not contain.\n` +
        'Each renders as a blank box in production. Put the name in ' +
        `${SUBSET_FILE} and run pnpm ui:fetch-fonts (commit the regenerated font).`,
    );
    process.exit(1);
  }

  console.log(
    `icon subset verified: ${references} literal reference(s) in ${files.length} file(s), ` +
      `all within the ${subset.size}-glyph subset (${usedFilled.size} drawn filled, ` +
      `all within the ${filledSubset.size}-glyph filled subset); ${dynamic} non-literal name(s) left to the IconName union; ` +
      `${unused.length} subset glyph(s) without a reference`,
  );
}

try {
  main();
} catch (error) {
  console.error(`verify-icons: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
