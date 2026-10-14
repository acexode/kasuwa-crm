/**
 * The search fold and the prefix range (T-0086; records-contract-search R3,
 * the T-0086 suite's R2).
 *
 * `foldSearchText` is the twin of the generation expression of every
 * `*_search` column (migration 0038): Unicode NFD, every combining mark
 * removed, the locale-independent default lower-casing, trimmed, each run of
 * whitespace one space. The query is folded here and the stored copy by the
 * database, so the two agree byte for byte. The mark and whitespace sets are
 * the FROZEN lists of search-charsets.ts, the same as 0038's, never the
 * running Node's `\p{M}` or `\s`.
 *
 * `prefixUpperBound` is the least string greater than every string that
 * starts with the prefix, in code-point order (the copies are `COLLATE "C"`):
 * the prefix with its last code point incremented. So
 * `folded >= prefix AND folded < prefixUpperBound(prefix)` is exactly "starts
 * with", and uses only the leak-proof text comparison operators, never LIKE.
 *
 * Pure. Nothing here logs: every input is a name.
 */

import { COMBINING_MARK_RANGES, SEARCH_WHITESPACE } from './search-charsets';

const codePoint = (point: number): string => `\\u{${point.toString(16)}}`;

/** The frozen mark set as one character class. */
const MARKS = new RegExp(
  `[${COMBINING_MARK_RANGES.map(([first, last]) =>
    first === last ? codePoint(first) : `${codePoint(first)}-${codePoint(last)}`,
  ).join('')}]`,
  'gu',
);
/** The frozen whitespace set. */
const WHITESPACE_CLASS = `[${SEARCH_WHITESPACE.map(codePoint).join('')}]`;
const WHITESPACE_RUNS = new RegExp(`${WHITESPACE_CLASS}+`, 'gu');
const EDGE_WHITESPACE = new RegExp(`^${WHITESPACE_CLASS}+|${WHITESPACE_CLASS}+$`, 'gu');

/** The largest Unicode code point. */
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(EDGE_WHITESPACE, '')
    .replace(WHITESPACE_RUNS, ' ');
}

/**
 * The exclusive upper bound of the strings starting with `prefix`, or null
 * when there is none (an empty prefix, or one made only of U+10FFFF: every
 * string greater or equal then starts with it). Surrogate code points are
 * skipped: they never occur in stored text.
 */
export function prefixUpperBound(prefix: string): string | null {
  const points = [...prefix].map((char) => char.codePointAt(0) ?? 0);
  while (points.length > 0) {
    const last = points.pop() ?? 0;
    if (last < MAX_CODE_POINT) {
      const next = last + 1 === SURROGATE_FIRST ? SURROGATE_LAST + 1 : last + 1;
      return String.fromCodePoint(...points, next);
    }
  }
  return null;
}
