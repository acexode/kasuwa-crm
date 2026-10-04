/**
 * The `en-XA` pseudo-locale transform, shared by `scripts/generate-pseudo.ts`
 * and the runtime (T-0042).
 *
 * Two transformations, each catching a different bug:
 *   1. accent every vowel  -> any string still reading as plain English in the
 *      UI was never externalised
 *   2. pad to ~140% length -> layouts that only fit English break visibly here
 *      rather than in production in French or Swahili
 *
 * ICU STRUCTURE IS PRESERVED, NOT SPLIT ON BRACES. `{count, plural, one {# step}
 * other {# steps}}` keeps its argument name, its type and its branch keys
 * verbatim and accents only the branch TEXT. The first version split on
 * `\{[^}]*\}`, which accented the `other` keyword of every plural and produced
 * a catalogue that no longer parsed — harmless while nothing rendered it, and
 * a crash the moment `?locale=en-XA` did.
 */

const VOWELS: Readonly<Record<string, string>> = {
  a: 'ä',
  e: 'ë',
  i: 'ï',
  o: 'ö',
  u: 'ü',
  A: 'Ä',
  E: 'Ë',
  I: 'Ï',
  O: 'Ö',
  U: 'Ü',
};

function accent(text: string): string {
  return text.replace(/[aeiouAEIOU]/g, (character) => VOWELS[character] ?? character);
}

/** Index of the `}` that closes the `{` at `open`, or -1. */
function closing(message: string, open: number): number {
  let depth = 0;
  for (let index = open; index < message.length; index += 1) {
    const character = message[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const BRANCHING = new Set(['plural', 'select', 'selectordinal']);

interface Counter {
  letters: number;
}

/** `{name, plural, one {…} other {…}}` with only the branch text accented. */
function argument(body: string, count: Counter): string {
  const parts = body.split(',');
  const type = parts[1]?.trim() ?? '';
  if (parts.length < 3 || !BRANCHING.has(type)) {
    return `{${body}}`;
  }
  const head = `${parts[0]},${parts[1]},`;
  const rest = parts.slice(2).join(',');
  let out = '';
  let index = 0;
  while (index < rest.length) {
    const open = rest.indexOf('{', index);
    const end = open === -1 ? -1 : closing(rest, open);
    if (open === -1 || end === -1) {
      out += rest.slice(index);
      break;
    }
    // The selector (`one`, `=0`, `offset:1 other`) is structure: verbatim.
    out += `${rest.slice(index, open)}{${transform(rest.slice(open + 1, end), count)}}`;
    index = end + 1;
  }
  return `{${head}${out}}`;
}

function transform(message: string, count: Counter): string {
  let out = '';
  let index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    const text = open === -1 ? message.slice(index) : message.slice(index, open);
    count.letters += text.length;
    out += accent(text);
    if (open === -1) break;
    const end = closing(message, open);
    if (end === -1) {
      out += message.slice(open);
      break;
    }
    out += argument(message.slice(open + 1, end), count);
    index = end + 1;
  }
  return out;
}

/** One message, pseudo-localised: `[Àccëntëd·····]`. */
export function pseudoMessage(message: string): string {
  const count: Counter = { letters: 0 };
  const transformed = transform(message, count);
  const padding = '·'.repeat(Math.max(1, Math.round(count.letters * 0.4)));
  return `[${transformed}${padding}]`;
}

/** A whole catalogue, pseudo-localised. */
export function pseudoCatalogue(source: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([id, message]) => [id, pseudoMessage(message)]),
  );
}
