import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../src/locales/en.json';

/**
 * Generates the `en-XA` pseudo-locale from `en`.
 *
 * Two transformations, each catching a different bug:
 *   1. accent every vowel  -> any string still reading as plain English in the
 *      UI was never externalised
 *   2. pad to ~140% length -> layouts that only fit English break visibly here
 *      rather than in production in French or Swahili
 *
 * ICU placeholders ({name}, {count, plural, ...}) are left untouched; mangling
 * them would produce a locale that fails to parse rather than one that reveals
 * layout problems.
 */

const VOWELS: Record<string, string> = {
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

/** Splits on ICU braces so placeholder contents are passed through verbatim. */
function pseudo(message: string): string {
  const segments = message.split(/(\{[^}]*\})/g);
  const transformed = segments
    .map((segment) => (segment.startsWith('{') ? segment : accent(segment)))
    .join('');

  const literalLength = segments
    .filter((segment) => !segment.startsWith('{'))
    .reduce((total, segment) => total + segment.length, 0);
  const padding = '·'.repeat(Math.max(1, Math.round(literalLength * 0.4)));

  return `[${transformed}${padding}]`;
}

const catalogue = Object.fromEntries(
  Object.entries(en).map(([id, message]) => [id, pseudo(message)]),
);

const target = resolve(__dirname, '..', 'src', 'locales', 'en-XA.json');
writeFileSync(target, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${Object.keys(catalogue).length} pseudo messages to ${target}\n`);
