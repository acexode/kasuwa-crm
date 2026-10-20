/**
 * What an avatar shows when there is no photo, which is always on the first
 * build: initials on one of four soft fills. Pure, so it is unit-tested, and
 * kept out of the component so a server can compute the same thing.
 *
 * v1.1 Components, "Avatars & presence": initials 14/700 (12/700 at 32px) on
 * primary-soft-strong, accent-soft, info-soft or success-soft, each with its
 * own -text colour. "Initials by default — photos only when low-bandwidth mode
 * is off."
 */

export const AVATAR_TONES = ['primary', 'accent', 'info', 'success'] as const;

export type AvatarTone = (typeof AVATAR_TONES)[number];

/**
 * FNV-1a, 32 bit, over the NFC code points of the seed.
 *
 * Deterministic and dependency-free: the same person keeps the same colour on
 * every screen, every device and every render, server or browser. NFC first,
 * so "Ọ̀" typed precomposed and "Ọ̀" typed as base plus combining marks are
 * the same person.
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (const char of seed.normalize('NFC')) {
    const point = char.codePointAt(0) ?? 0;
    hash ^= point;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The fill for a seed: a stable id where there is one, else the display name. */
export function avatarTone(seed: string): AvatarTone {
  return AVATAR_TONES[hashSeed(seed) % AVATAR_TONES.length] ?? 'primary';
}

const LETTER = /\p{L}/u;

/**
 * The user-perceived first character of a word, with its tone marks.
 *
 * "Ọláńrewájú" must give "Ọ", not "O" and not a dangling combining dot:
 * Yoruba, Igbo and Hausa names carry diacritics that are part of the letter.
 * Intl.Segmenter splits by grapheme cluster where it exists (every browser
 * Kasuwa supports, and Node). Without it, a base character keeps every
 * combining mark that follows it.
 */
function firstGrapheme(word: string): string {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word);
    const first = segments[Symbol.iterator]().next();
    return first.done === true ? '' : first.value.segment;
  }
  const chars = Array.from(word);
  let grapheme = chars[0] ?? '';
  for (const char of chars.slice(1)) {
    if (!/\p{M}/u.test(char)) break;
    grapheme += char;
  }
  return grapheme;
}

/**
 * Up to two initials: the first letter of the first word and of the last.
 *
 * Words are runs between whitespace; leading punctuation is dropped ("(Bayo)"
 * counts from the B) and a word with no letter at all ("—", "2") is skipped.
 * One word gives one initial. Uppercased for the given locale, so a Turkish
 * "i" is not dotless by accident.
 */
export function initials(name: string, locale?: string): string {
  const words = name
    .normalize('NFC')
    .trim()
    .split(/\s+/u)
    .map((word) => {
      const start = word.search(LETTER);
      return start === -1 ? '' : word.slice(start);
    })
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = firstGrapheme(first) + (last === undefined ? '' : firstGrapheme(last));
  return locale === undefined ? letters.toUpperCase() : letters.toLocaleUpperCase(locale);
}
